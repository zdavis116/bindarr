// THE SCAN LOOP, TRANSCRIBED FROM SCRYBOX (FastScanner.jsx:222-361).
//
// Zach, after four rounds of me adapting instead of copying: "Copy its scan
// loop exactly."
//
// So this file is a transcription, not an interpretation. Upstream's line
// numbers are in the comments so any line here can be checked against the
// source. The rule while writing it: if upstream does something that looks
// wrong or unnecessary, it stays, because every bug in this port so far has
// been me deciding otherwise.
//
// WHAT THE BUG WAS, AND WHY THE WHOLE LOOP HAD TO MOVE. Our scanner had TWO
// scan paths -- the on-device reader and the old CLIP+ORB server scan -- each
// with its own duplicate guard keyed differently: the device path on
// `card.id`, the server path on a CLIP name string. They shared one Map and
// could never match each other's entries, so the same card staged twice, one
// second apart, from two engines. Zach's session showed exactly that:
//
//   Fblthp, Knows the Way    server(8) , device , server(7)
//   Emergency Phytomedic     server(8) , device
//
// Upstream has ONE path, so that class of bug cannot exist there. This is the
// one path.
//
// THE ONE DELIBERATE SUBSTITUTION: upstream's serverRead() posts the frame to
// /api/cardscan/frame, which proxies to a separate OCR container (cardscan:8321)
// whose source is not public. We do not have that container. Our server read
// calls the SAME local fallback the rest of this port already uses. The
// CONTRACT is unchanged -- give it a JPEG, get back {candidates, results,
// frame} -- so the loop around it is untouched.

import { FRAME_MAX, needsServer, nextFailStreak, serverAllowed } from './fastScan';
import { readOnDevice, lastFrameJpeg, hydrateResults } from './clientScan';

// (21-23) The gaps. 60ms between passes, ALWAYS -- there is no settle pause
// after a hit, because a pause cannot tell "the same card is still there" from
// "a new card just landed", and the per-card window below answers that
// question properly.
export const AUTO_GAP_MS = 60;
export const AUTO_IDLE_MS = 350;
export const AUTO_BUSY_MS = 1000;

// (304) How long one card.id stays "already scanned".
export const SEEN_CARD_MS = 4000;

// (33-45) Encode the frame for the server path. Only reached when the phone
// could not prove the card.
async function grabJpeg(source, sw, sh, canvasRef) {
  const k = Math.min(1, FRAME_MAX / Math.max(sw, sh));
  const w = Math.round(sw * k), h = Math.round(sh * k);
  if (typeof OffscreenCanvas !== 'undefined') {
    const oc = new OffscreenCanvas(w, h);
    oc.getContext('2d').drawImage(source, 0, 0, w, h);
    return oc.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  }
  const c = canvasRef.current || (canvasRef.current = document.createElement('canvas'));
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(source, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.88));
}

/**
 * Create the scan loop. Everything it mutates lives in the refs handed to it,
 * so the caller owns lifetime and this file owns behaviour.
 *
 * @param {object} refs      busy, auto, alive, run, timer, scanAbort, failStreak,
 *                           seenIds, onDevice, firstSeen, canvas
 * @param {object} handlers  onCard(card, meta), onHint(text), onError(text),
 *                           onBusy(bool), serverScan(blob) -> {candidates, results, frame}
 */
export function createScanLoop(refs, handlers) {
  const {
    busyRef, autoRef, aliveRef, runRef, timerRef, scanAbortRef,
    failStreakRef, seenIdsRef, onDeviceRef, firstSeenRef, canvasRef,
  } = refs;
  const { onCard, onHint, onError, onBusy, serverScan } = handlers;

  // (222-326) scan(). One pass over one frame.
  const scan = async (source, { autoPass = false, gen = runRef.current } = {}) => {
    // (223) One pass at a time. A second pass starting while one is in flight
    // would race the shared refs below.
    if (busyRef.current) return { busy: true };
    // (226) Results commit only for the run that asked: a pass that outlives a
    // stop (or a stop+restart) must not add rows to the new run.
    const stale = () => !aliveRef.current || (autoPass && (!autoRef.current || gen !== runRef.current));
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return { busy: true };
    busyRef.current = true; onBusy(true);
    if (!autoPass) onError('');
    const t0 = performance.now();
    try {
      let out = null;
      const abort = new AbortController();
      scanAbortRef.current = abort;
      // (244) Why this frame went to the server, for the logs.
      let why = onDeviceRef.current ? (autoPass ? 'unproven' : 'hedge') : 'no-device';

      const serverRead = async (blobP) => {
        const blob = await blobP;
        if (!blob) throw new Error('no frame to send');
        return serverScan(blob, { signal: abort.signal, why, autoPass });
      };

      // (253) SHUTTER PRESS: HEDGE. The server read starts NOW, alongside the
      // on-device one, instead of only after the phone gives up -- the old
      // sequential fallback is where the 2s+ scans came from. Auto passes stay
      // sequential so a 60ms loop does not flood the server.
      const hedged = onDeviceRef.current && !autoPass
        ? serverRead(grabJpeg(source, sw, sh, canvasRef))
        : null;
      hedged?.catch(() => {});

      let local = null;
      if (onDeviceRef.current) {
        // (257) requireStill on an auto pass: the pipeline's own stillness gate
        // holds back a moving card rather than reading a blur.
        local = await readOnDevice(source, sw, sh, { requireStill: autoPass });
        if (local?.error) { console.warn('[fastscan] on-device read failed:', local.error); why = 'device-error'; }
        // (259) NO CARD CLEARS THE STREAK. This is what lets the next card
        // through immediately instead of inheriting the last one's backoff.
        else if (!local?.candidates?.length) { why = 'no-card'; failStreakRef.current = null; }
        else if (!local.candidates[0].eligible) why = String(local.candidates[0].status || 'ineligible').replace(/\s+/g, '-');
        // (264) Proven on the phone -- or an auto pass the stillness gate held
        // back -- means no upload.
        if (!needsServer(local, { autoPass })) {
          out = { ...local, results: await hydrateResults(local.results, abort.signal).catch(() => null) };
          if (!out.results) out = null;
        }
      }

      // (269-277) THE FOUR-WAY DECISION. Proven -> done. Shutter -> take the
      // hedge. Auto + backoff says hold -> hold. EVERYTHING ELSE UPLOADS.
      if (out) abort.abort();
      else if (hedged) out = await hedged;
      else if (autoPass && !serverAllowed(failStreakRef.current, Date.now(), local)) {
        // (272) Same card, same unresolved footer as the last few passes: do
        // not pay for another server read to get the same answer. Say what
        // would help instead.
        if (!stale()) onHint('footer');
        return { held: true };
      } else {
        out = await serverRead((async () => (
          (onDeviceRef.current && await Promise.resolve(lastFrameJpeg()).catch(() => null))
          || grabJpeg(source, sw, sh, canvasRef)
        ))());
      }

      // (279) Stopped or navigated away while this was in flight: drop it.
      if (stale()) return { busy: true };
      if (out.busy) return out;

      // (281) Fold this answer into the fail streak.
      failStreakRef.current = nextFailStreak(failStreakRef.current, out, Date.now());

      const ms = Math.round(performance.now() - t0);
      const hits = (out.results || []).filter(x => x.ok && x.card);
      const candidates = out.candidates || [];
      const eligible = candidates.filter(c => c.eligible).length;

      // (289-291) When the card now in view was FIRST seen, so a latency figure
      // reflects the user's real wait rather than the final pass.
      if (!candidates.length) firstSeenRef.current = null;
      else if (firstSeenRef.current == null) firstSeenRef.current = t0;
      const waited = autoPass && firstSeenRef.current != null
        ? Math.round(performance.now() - firstSeenRef.current) : ms;

      // (292-297) The hint is derived from the OUTCOME, after the pass. Never a
      // "working on it" message before one: an early return cannot clear that,
      // and a 60ms loop leaves it on screen for ever.
      const streak = failStreakRef.current;
      if (!candidates.length) onHint('noCard');
      else if (!eligible) onHint('adjust', { reason: candidates[0].status });
      else if (!hits.length && streak && streak.count >= 2) onHint('footer');
      else if (!hits.length) onHint('hold');
      else onHint('');

      // (299-306) THE DUPLICATE RULE. Keyed by card.id, expiring on a clock.
      // A card left on the table is quiet; a DIFFERENT card is never blocked;
      // a genuine second copy is scannable again after the window. No "did the
      // card leave the frame" event is needed, which matters because nothing
      // reports that any more -- and because Zach drops cards on top.
      const now = Date.now();
      const fresh = hits.filter(h => {
        if (!autoPass) return true;
        const last = seenIdsRef.current.get(h.card.id);
        return !last || now - last > SEEN_CARD_MS;
      });
      for (const h of hits) seenIdsRef.current.set(h.card.id, now);
      if (hits.length) firstSeenRef.current = null;

      // (308-316) Stage only the fresh ones.
      for (const h of fresh) {
        await onCard(h.card, { title: h.title || null, via: h.via || null, waited, ms, autoPass });
        if (stale()) return { busy: true };
      }

      return { matched: fresh.length, none: !candidates.length };
    } catch (e) {
      // (319) An aborted read is not an error the user should see.
      if (e?.name === 'AbortError' || stale()) return { busy: true };
      onError(e.message || String(e));
      return { error: true };
    } finally {
      // (322-324) ALWAYS release, even on the early returns above. A stuck
      // busy flag wedges the scanner with no way back except restarting the
      // camera.
      busyRef.current = false;
      if (aliveRef.current) onBusy(false);
    }
  };

  // (337-350) autoLoop(). Tick, scan, schedule the next tick. That is all.
  //
  // One loop per generation: stopping bumps runRef, so a pass still awaiting
  // its scan when the user stops (and maybe restarts) sees a different number
  // and exits instead of scheduling a second loop beside the new one.
  const autoLoop = async (gen, getVideo, isPaused) => {
    if (!autoRef.current || gen !== runRef.current) return;
    // (340) Paused for a reason the caller owns (a modal, a full tray): wait
    // the idle gap and re-check rather than scanning into a blocked UI.
    if (isPaused?.()) {
      timerRef.current = setTimeout(() => autoLoop(gen, getVideo, isPaused), AUTO_IDLE_MS);
      return;
    }
    const v = getVideo();
    const r = v && v.readyState >= 2
      ? await scan(v, { autoPass: true, gen })
      : { busy: true };
    if (!autoRef.current || gen !== runRef.current) return;
    // (348) The gap depends on the OUTCOME: a server backoff waits, an idle or
    // failed pass waits a little, everything else goes again at 60ms.
    const wait = r.backoff ? AUTO_BUSY_MS
      : (r.none || r.error) ? AUTO_IDLE_MS
        : AUTO_GAP_MS;
    timerRef.current = setTimeout(() => autoLoop(gen, getVideo, isPaused), wait);
  };

  // (352-361) Start/stop. A new run proves every card afresh: nothing tracked
  // in the last one carries over.
  const setAutoRunning = (next, getVideo, isPaused, resetOnDevice) => {
    autoRef.current = next;
    clearTimeout(timerRef.current);
    const gen = ++runRef.current;
    if (!next) { scanAbortRef.current?.abort(); return gen; }
    seenIdsRef.current.clear();
    failStreakRef.current = null;
    firstSeenRef.current = null;
    resetOnDevice?.();
    autoLoop(gen, getVideo, isPaused);
    return gen;
  };

  return { scan, autoLoop, setAutoRunning };
}
