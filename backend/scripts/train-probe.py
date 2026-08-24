"""Re-time training with labels ACTUALLY loaded.

The earlier probe reported 0.05s/image/epoch, but the label format was wrong so
every image was treated as background -- a model learning nothing trains fast.
That number was meaningless. This re-measures with real labels.

Lives in the repo, not /tmp: a gateway restart cleared /tmp mid-run and lost
both the script and an hour of downloaded card art.
"""
import time
from pathlib import Path

from ultralytics import YOLO

DATA = Path.home() / 'bindarr-yolo-data' / 'cards.yaml'
N_IMG = 90

t0 = time.time()
YOLO('yolo11n-obb.pt').train(
    data=str(DATA), epochs=3, imgsz=640, batch=8, workers=2, device='cpu',
    project=str(Path.home() / 'bindarr-yolo-runs'), name='probe',
    exist_ok=True, val=False, plots=False, verbose=False,
)
el = time.time() - t0
per = el / 3 / N_IMG

print(f'\n3 epochs x {N_IMG} images @640px CPU = {el:.0f}s')
print(f'  {per:.3f}s per image per epoch\n')
print('  full runs at 640px:')
for imgs, eps in ((2000, 40), (3000, 60), (4000, 80)):
    print(f'    {imgs} imgs x {eps} epochs -> {per*imgs*eps/3600:6.1f} h')
print('  at 416px (~2.4x cheaper):')
for imgs, eps in ((2000, 40), (3000, 60), (4000, 80)):
    print(f'    {imgs} imgs x {eps} epochs -> {per*imgs*eps/3600/2.4:6.1f} h')
