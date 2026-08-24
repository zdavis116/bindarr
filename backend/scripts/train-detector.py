#!/usr/bin/env python3
"""PHASE 4b — TRAIN THE CARD DETECTOR. Built to not wedge the box.

WHY THE GUARDRAILS. Two gateway crashes came from training, not from anything
Zach did: load average hit 9.3 on a 2-CORE container with a ~2GB memory cap.
Ultralytics defaults assume a workstation. On this box the defaults are a
denial-of-service against the agent that has to report the result.

WHAT IS CONSTRAINED, AND WHY EACH ONE MATTERS

  nice 19        the kernel deprioritises every training thread, so the gateway
                 always wins a CPU contest. This alone fixed the crash.
  workers=0      dataloader workers are SUBPROCESSES; each carries a copy of
                 the parent and multiplies memory. At a 2GB cap, 2 workers is
                 the difference between finishing and an OOM kill.
  batch=4        peak memory scales with batch. 4 measured safe; 8 was not
                 tested and is not worth discovering at 3am.
  torch threads  pinned to 1. Torch otherwise spawns one thread per core and
                 fights the gateway for both of them.
  cache=False    ultralytics' RAM cache would hold the whole dataset in memory.
                 Fine at 90 images, fatal at 2000.

SAFETY, NOT OPTIMISM: a watchdog thread samples the cgroup's own memory counter
and ABORTS the run if it crosses a threshold. A training run that dies cleanly
having written its last checkpoint is recoverable; an OOM kill that takes the
gateway with it is not.

Resumable by design. Checkpoints land every epoch, so an interrupted run
restarts from `last.pt` rather than from zero.
"""
import argparse
import os
import sys
import threading
import time
from pathlib import Path

# MUST be set before torch is imported, or the thread pool is already built.
os.environ.setdefault('OMP_NUM_THREADS', '1')
os.environ.setdefault('MKL_NUM_THREADS', '1')

CGROUP_CUR = Path('/sys/fs/cgroup/memory.current')
CGROUP_MAX = Path('/sys/fs/cgroup/memory.max')


def mem_limit_bytes():
    """The container's real memory ceiling, not the host's."""
    try:
        v = CGROUP_MAX.read_text().strip()
        if v != 'max':
            return int(v)
    except Exception:
        pass
    try:                                  # fall back to total RAM
        import psutil
        return psutil.virtual_memory().total
    except Exception:
        return 2 * 1024 ** 3


def mem_now():
    try:
        return int(CGROUP_CUR.read_text().strip())
    except Exception:
        return 0


def watchdog(limit, frac, stop):
    """Abort the process if memory crosses `frac` of the cap.

    Deliberately hard: os._exit skips cleanup handlers that could themselves
    allocate. The point is to stop BEFORE the kernel OOM killer chooses a
    victim, because the kernel may well choose the gateway rather than us.
    """
    ceiling = int(limit * frac)
    peak = 0
    while not stop.is_set():
        cur = mem_now()
        peak = max(peak, cur)
        if cur > ceiling:
            print(f'\nWATCHDOG: memory {cur/1e6:.0f}MB exceeded '
                  f'{ceiling/1e6:.0f}MB ({frac:.0%} of cap). Aborting to protect '
                  f'the system; resume from last.pt.', flush=True)
            os._exit(3)
        time.sleep(2)
    print(f'watchdog: peak memory {peak/1e6:.0f}MB of {limit/1e6:.0f}MB cap', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default=str(Path.home() / 'bindarr-yolo-data' / 'cards.yaml'))
    ap.add_argument('--epochs', type=int, default=40)
    ap.add_argument('--imgsz', type=int, default=416)
    ap.add_argument('--batch', type=int, default=4)
    ap.add_argument('--name', default='cards')
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--memfrac', type=float, default=0.80)
    a = ap.parse_args()

    if not Path(a.data).exists():
        sys.exit(f'dataset not found: {a.data}\nRun gen-card-dataset.py first.')

    # Be nice to the box even if the caller forgot to.
    try:
        os.nice(19 - os.nice(0))
    except Exception:
        pass

    import torch
    torch.set_num_threads(1)

    limit = mem_limit_bytes()
    print(f'memory cap {limit/1e6:.0f}MB, aborting above {a.memfrac:.0%}')
    stop = threading.Event()
    threading.Thread(target=watchdog, args=(limit, a.memfrac, stop), daemon=True).start()

    from ultralytics import YOLO
    runs = Path.home() / 'bindarr-yolo-runs'
    ckpt = runs / a.name / 'weights' / 'last.pt'
    model = YOLO(str(ckpt)) if (a.resume and ckpt.exists()) else YOLO('yolo11n-obb.pt')
    if a.resume and ckpt.exists():
        print(f'resuming from {ckpt}')

    t0 = time.time()
    try:
        model.train(
            data=a.data, epochs=a.epochs, imgsz=a.imgsz, batch=a.batch,
            device='cpu', workers=0, cache=False, project=str(runs),
            name=a.name, exist_ok=True, resume=bool(a.resume and ckpt.exists()),
            patience=15, val=True, plots=False, verbose=True, save_period=1,
        )
    finally:
        stop.set()
        time.sleep(2.5)

    print(f'\ntraining finished in {(time.time()-t0)/3600:.2f}h')
    print(f'weights: {runs / a.name / "weights" / "best.pt"}')


if __name__ == '__main__':
    main()
