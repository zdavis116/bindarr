// ONE SCAN PATH. The loop is upstream's (utils/fastScanLoop.js); this file
// owns only what happens to a card once the loop has PROVEN it.
//
// WHAT THIS REPLACES, and why it had to go:
//
// handleCapture used to contain two complete scan paths -- the on-device
// reader and the old CLIP+ORB server scan -- each with its own duplicate
// guard, keyed differently. The device path keyed on card.id; the server path
// keyed on a CLIP name string. Both wrote into ONE Map and could therefore
// never match each other's entries. Zach's session:
//
//   Fblthp, Knows the Way    server(8) , device , server(7)    1.0s , 4.0s
//   Emergency Phytomedic     server(8) , device                1.0s
//
// Two engines, one card, staged twice, a second apart. Upstream has one path,
// so it cannot happen there. This is the one path.
import { createScanLoop } from './fastScanLoop';
import { lastCardCrop } from './clientScan';

/**
 * Wire the transcribed loop to this app's staging queue.
 *
 * The loop decides WHAT was scanned. Everything here decides what to DO with
 * it, which is where Bindarr differs from upstream on purpose: cards land in
 * the staging tray for review rather than going straight to a send list.
 *
 * @param {object} refs      the loop's refs (see createScanLoop)
 * @param {object} deps      submitScan, applyScanOutcome, serverScan, signal,
 *                           setScanStatus, setLoading, setDebugCandidates,
 *                           setCaptureSource, hint, onError, onBusy, isStale
 */
export function createScanner(refs, deps) {
  const {
    submitScan, applyScanOutcome, serverScan, signal, setScanStatus,
    setDebugCandidates, setCaptureSource, hint, onError, onBusy, isStale,
  } = deps;

  // Called once per PROVEN card, by the loop, after its dedupe window has
  // already refused repeats. Nothing here re-checks for duplicates: one rule,
  // in one place, keyed on card.id.
  const onCard = async (card, meta) => {
    if (isStale()) return;
    setCaptureSource('video');
    signal('capture');
    setDebugCandidates([{
      name: card.name, set: card.set_id, number: card.number,
      inliers: 100, score: 1, verified: true, card,
    }]);
    setScanStatus('');
    try {
      const outcome = await submitScan({
        matchInliers: 100,
        match_inliers: 100,
        name: card.name,
        titleText: meta.title || card.name,
        ocrText: '',
        // The printing the reader PROVED by reading the collector footer, so
        // set + number are evidence rather than a guess. The server still
        // validates it against the catalogue.
        printingHint: { set: card.set_id, number: card.number },
        stage: true,
        // THE PHOTO OF THE ACTUAL CARDBOARD. Without it the review list is
        // forty names and forty empty grey boxes, with no way to tell which
        // physical card each row was -- which is the one thing the crop is
        // for when a printing looks wrong. Returns null harmlessly if the
        // frame or the card outline is unavailable.
        crop: lastCardCrop(),
        quantity: 1,
      });
      if (isStale()) return;
      applyScanOutcome(outcome, card.name);
    } catch (err) {
      console.error('[scan] submit failed:', err);
      onError('Scan failed. Please search manually.');
    }
  };

  return createScanLoop(refs, {
    onCard,
    onHint: hint,
    onError,
    onBusy,
    serverScan,
  });
}
