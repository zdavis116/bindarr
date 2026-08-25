import { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, AlertTriangle, X, Zap, ZapOff, Settings, ScanLine, Maximize, Minimize } from 'lucide-react';
import confetti from 'canvas-confetti';
import { formatPrice } from '../utils/formatPrice';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import { CONDITIONS, getPrintings } from '../utils/cardOptions';
import { detectCardInFrame, isLocked } from '../utils/liveCardDetect';
import { initCardDetector, detectCardOnDevice, detectorReady } from '../utils/onDeviceCardDetect';
import CardEntryFields from './CardEntryFields';
import CardInspectorModal from './CardInspectorModal';
import ScanReviewQueue from './ScanReviewQueue';
import { createScanReviewQueue } from './scanReviewQueue';
import ScanStagingReview from './ScanStagingReview';
import { createScanStaging } from './scanStaging';
import { useBackGuard } from '../utils/useBackGuard';
import { useMultiSelect } from '../utils/useMultiSelect';
import { laplacianVarianceScore, decideCapture, newGateState, SHARPNESS_WINDOW } from '../utils/frameSharpness';

import { isNative } from '../apiBase';
import { useT } from '../utils/i18n';
// Centered card-shaped guide box, styled in CSS (.scan-card-guide): card ratio
// with margin, centered by the overlay's flex. The crop maps the box's on-screen
// rect (getBoundingClientRect) into the frame, so its size is driven by CSS.
// Confidence gates for the server match. When ORB geometric verification ran
// (verified=true), gate on inlier count; otherwise on CLIP cosine similarity.
// Below the gate the scan shows the candidates for manual selection.
const SCAN_MATCH_MIN_SCORE = 0.55;
const SCAN_MATCH_MIN_INLIERS = 12;
// ONE capture profile. The scan-detail slider is gone, and this is why.
//
// The slider bundled uploadW + cooldown + countdown + recallK + orb behind a
// single "quick <-> accurate" axis. MEASURED, that axis did not exist:
//
//   recallK 250 / 100 / 50 / 25 / 10  -> 8/8 card identity at EVERY value.
//   Only latency moved: 4952ms -> 587ms. RECALL_K's server default is now 50.
//
// So the slider's headline promise — drag right to be more accurate — was
// false. Card identity was already 100%, and dragging right only bought a
// slower scan. A control whose axis measurably does nothing is worse than no
// control: it invites Zach to blame (or "fix") it for problems it cannot cause,
// and it is another thing to get wrong on a phone mid-stack.
//
// uploadW DOES matter, but not the way the labels implied. Card identity was
// 10/10 at every width including 400px — so width buys nothing for identifying
// the CARD. It matters only for the COLLECTOR NUMBER, which needs enough
// resolution to be legible at all, and which is now the thing that decides the
// exact printing. 1280 is therefore chosen for the OCR strip, the only consumer
// that can tell the difference. Zach: "it may be worth removing the slider and
// just having uploadW be the 1280."
//
// --- PR 12: RAISED 1280 -> 2000, AND WHY THAT EXACT NUMBER -------------------
//
// THIS CAP AND THE getUserMedia RESOLUTION BELOW MUST MOVE TOGETHER OR NEITHER
// DOES ANYTHING. At the old geometry (720x1280 stream, guide box 72% of a small
// boxed preview) the guide-box crop was ~660px wide, so `Math.min(1, 1280/660)`
// clamped to 1 and this cap was a NO-OP. The moment the sensor request and the
// fullscreen preview raise that crop past 1280px, this line becomes the BINDING
// constraint and throws away exactly the pixels the other two changes bought.
// Raising only the camera request would have been a pure no-op with extra
// battery cost; that is the whole reason this constant is touched here.
//
// MEASURED, through the REAL /api/scan-match route (express + real DB + real
// tesseract OCR), on staged photos of 4 real cards taken as a full-res
// guide-box crop 2281px wide, softened with a 1.6px blur to stand in for lens
// MTF that a composite scene does not have:
//
//   cap    q     avg KB   number   fabricated   median ms
//   660    0.85     99     4/4         0          544
//   1280   0.85    274     4/4         0          846
//   1600   0.85    375     4/4         0          841
//   2000   0.85    514     4/4         0          838
//   2600   0.85    560     4/4         0          881
//   1280   0.80    234     4/4         0          796
//   2000   0.80    437     4/4         0          829
//
// TWO HONEST READINGS OF THAT TABLE, and the second is the one that decides it.
//
// 1. On THIS fixture accuracy is already 4/4 everywhere, so the sweep does NOT
//    show a cap that "fixes" OCR. A composite has no sensor noise, and the
//    production failure is precisely a noise-plus-resolution one. Nobody should
//    later cite this table as proof of an accuracy win. It is not.
// 2. What it DOES decide is the PRICE. Latency is essentially FLAT from 1280 to
//    2600 (846 -> 881ms median, ~4%), so "a bigger upload will make the already
//    slow scanner slower" does not survive contact with the numbers — the cost
//    here is BYTES, not seconds, and bytes over Tailscale are the real budget.
//
// So the choice is the KNEE OF THE BYTE CURVE, not the peak. 2000 keeps ~3x the
// linear detail of 1280 on the collector-number strip (the only consumer that
// can tell the difference) while 2600 costs another ~9% of payload for pixels
// the server cannot use: it rectifies to 750x1050, and the strip is ~5% of card
// height, so past ~2000px of card width the warp is already downsampling.
// An UNBOUNDED upload was rejected outright — a modern iPhone would send
// ~4000px and trade a resolution complaint for a data-and-latency one.
const SCAN_UPLOAD_W = 2000;
// JPEG quality, deliberately LOWERED from 0.85 to 0.80 as the width went up.
//
// Measured above: at 2000px, q=0.80 is 437KB against q=0.85's 514KB — 15% fewer
// bytes — with the SAME 4/4 read and zero fabrications. More pixels at slightly
// lower per-pixel fidelity beats fewer pixels at higher fidelity for small
// printed text, because the sampling already records the digit strokes
// redundantly. 0.80 is treated as the FLOOR and not lowered further: below it
// JPEG ringing starts landing on the thin strokes the OCR reads, and this
// pipeline's one unforgivable outcome is a confident WRONG number, not a miss.
const SCAN_UPLOAD_Q = 0.80;
// What we ASK the camera for. Deliberately `ideal`, never `exact`.
//
// `exact` on an unsupported resolution makes getUserMedia REJECT with
// OverconstrainedError, and the catch in startCamera turns any rejection into
// "check your camera permissions" — leaving the user with NO CAMERA AT ALL.
// That failure is far worse than a lower-resolution one: a scanner stuck at
// 1280 still scans; a scanner that will not open scans nothing. `ideal` lets
// every browser negotiate DOWN to its best available mode instead of failing
// closed, so the failure mode matters more here than the peak.
//
// 4032x3024 is an iPhone-16-class main camera ceiling. Asking for more than a
// device can give is harmless under `ideal`; what matters is that the ACTUAL
// negotiated numbers are recorded into the diagnostics panel (see cameraInfo),
// because no browser and no camera runs in this repo and only Zach's phone can
// report what his hardware actually handed back.
const SCAN_CAPTURE_IDEAL_W = 4032;
const SCAN_CAPTURE_IDEAL_H = 3024;
// Kept from the old 'Accurate' preset. Deliberately NOT collapsed to Turbo's
// values: countdown 2 leaves a window to cancel a mis-scan, and the cooldown
// paces a physical stack. Neither is an accuracy setting.
// HOW LONG TO WAIT BEFORE THE NEXT AUTO-SCAN ATTEMPT, by what just happened.
//
// The old code waited a flat SCAN_COOLDOWN_MS after EVERY tick, including ticks
// that captured nothing. Measured against real work, that is where Zach's
// "3 to 4 secs" per card actually goes:
//
//   3.0s  flat cooldown before the next attempt
//   2.0s  auto-add cancel countdown
//   1.1s  the capture + server round trip   <- the only real work
//
// So the app spent ~5s waiting and ~1s working, and the cooldown alone capped
// throughput at 20 cards/min however fast the pipeline got.
//
// The three outcomes are not the same and must not wait the same:
//
// REJECTED (the sharpness gate skipped the frame). Nothing was captured, no
// card was added, no server call was made. This is the app saying "hold
// steady" — and then ignoring the card for three seconds, so a card that
// steadied instantly still waited out the full penalty. Retry fast; the gate
// is cheap and rejecting again costs almost nothing.
//
// SETTLE (a scan ran and resolved). A real pause belongs here, because Zach is
// physically swapping the next card in and re-firing immediately would just
// re-scan the one still in frame. But 3s is longer than that takes.
//
// ERROR (the scan threw). Back off further: hammering a failing server makes
// it worse, and the failure is unlikely to clear within one tick.
const SCAN_RETRY_REJECTED_MS = 350;
const SCAN_RETRY_SETTLE_MS = 400;
const SCAN_RETRY_ERROR_MS = 2500;

// ---------------------------------------------------------------------------
// STABILITY GATING — capture when the detection HOLDS STILL, never on a timer.
//
// Zach: "this scanner is not working it's just not getting any better.
// Recommending researching the internet for the best way to scan cards by
// detecting one is in the camera view."
//
// He was right that patching was not converging. Three attempts tried to answer
// "is this a DIFFERENT card?" from a preview frame -- luma fingerprint, then
// detector geometry, then match identity -- and all three skipped real cards.
// That question is not answerable from a preview: he stacks each card in the
// same position, so nothing moves, and two cards under the same light look
// nearly identical at any coarse measure.
//
// WHAT EVERY MATURE SCANNER DOES INSTEAD (see SCANNER_CAPTURE_REDESIGN.md):
// capture when the detected quad has held still across N consecutive frames.
// Four independent implementations of the same rule --
//   Dynamsoft QuadStabilizer   IoU 0.85, area delta 0.15, 3 stable frames
//   docuSnap                   10 consecutive passing frames + hold-still
//   CamScanner                 stability + occlusion + clarity before capture
//   Scanbot                    sensitivity threshold + post-detect delay
//
// The question changes from one that cannot be answered to one that can: "has
// the detection held still long enough to be a deliberate presentation?" A
// stable quad IS a card sitting in view, observed rather than assumed.
//
// Zach's workflow decides the duplicate rule: "I just drop cards on top."
// Dropping a card disturbs the quad, which resets the counter and produces a
// FRESH stable period -- that is the new-card event, and it needs no "leave the
// frame" requirement (option (a), his choice). The existing identity check
// remains the backstop for true duplicates. This errs toward scanning, which is
// the correct direction: a duplicate is visible and one tap to remove, while a
// skipped card is only findable by recounting physical cardboard.

// Overlap between two axis-aligned boxes, 0..1. The standard IoU that
// Dynamsoft's stabilizer uses: it is scale-invariant, so it behaves the same
// whether the card fills the frame or sits far away.
function boxIoU(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

// Is this detection in the same place as the previous one?
//
// Both tests must pass. IoU alone accepts a box creeping steadily across the
// frame if each step is small; the area check catches a card being moved
// toward or away from the camera, which IoU is relatively insensitive to.
const STABLE_IOU = 0.85;          // Dynamsoft's published default
const STABLE_AREA_DELTA = 0.15;   // fractional area change allowed
function detectionsAgree(a, b) {
  if (!a || !b) return false;
  if (boxIoU(a, b) < STABLE_IOU) return false;
  const areaA = a.w * a.h, areaB = b.w * b.h;
  if (areaA <= 0 || areaB <= 0) return false;
  return Math.abs(areaA - areaB) / Math.max(areaA, areaB) <= STABLE_AREA_DELTA;
}

// How many consecutive agreeing frames before the card counts as presented.
//
// The live loop runs at ~7 fps (140ms), so 3 frames is ~420ms of stillness.
// Long enough that a hand moving through the frame cannot trigger it, short
// enough to feel immediate. Dynamsoft ships 3 at comparable frame rates.
//
// NOT A TIMER. Zach: "Nothing should be measured on time." This counts EVENTS
// from the detector -- if the camera stalls, the count stalls with it, which is
// the correct behaviour and is exactly what a wall-clock would get wrong.
const STABLE_FRAMES_REQUIRED = 3;

// EXTRA SETTLING FRAMES BEFORE THE SHUTTER, on top of stability.
//
// Zach: "scanning seems to be getting worse at one point it was doing really
// good". Four of seven queues came back with the collector-number line MISSING
// from the OCR text entirely -- 'MSH *EN Wo DOMIN' with no 'L 0295' above it,
// and one completely blank. The text was never in the image, so this is a
// CAPTURE QUALITY problem, not a parsing one.
//
// WHAT I CHANGED THAT CAUSED IT. Stability gating fires the shutter the moment
// the detection has agreed for STABLE_FRAMES_REQUIRED frames. That is the
// EARLIEST instant the card is arguably still -- the hand may only just have
// left, the card may still be rocking, and the lens has had no time to refocus
// on the new depth. The old timer-based path happened to wait longer, which is
// the "really good" behaviour he remembers.
//
// The sharpness gate does not save us here, and it is worth understanding why:
// it compares each frame to a MEDIAN OF RECENT FRAMES. During a card swap those
// recent frames are all motion-blurred, so the baseline sinks and a merely
// less-blurred frame clears it. The gate is relative by design (it adapts to
// each device), and that same property makes it blind right after motion.
//
// So: hold a few more frames of agreement past the point of stability. The
// collector number is ~3mm of text and the first thing to dissolve in blur,
// which is exactly the symptom.
//
// Counted detector frames, not milliseconds -- Zach's rule. A stalled camera
// stalls the count.
const SETTLE_FRAMES_BEFORE_CAPTURE = 3;

// HOW MANY CONSECUTIVE DISTURBED FRAMES COUNT AS A NEW PLACEMENT.
//
// Zach: "evil thrall scanned twice even though I never tapped or anything after
// it scanned the first time."
//
// The one-scan-per-stable-period latch used to clear on ANY single frame whose
// detection disagreed with the last. The trained detector regresses a fresh box
// every frame, so its output jitters by a pixel or two even on a motionless
// card -- and one frame drifting past the IoU threshold re-armed capture, so
// the same card scanned again with nothing having happened.
//
// A genuine placement disturbs the view for SEVERAL consecutive frames: the
// hand enters, the card falls, the box moves and resizes. Detector jitter does
// not. 2 frames (~280ms at this loop rate) is comfortably longer than a
// single-frame wobble and far shorter than any real hand movement.
//
// Still no clock: these are counted detector EVENTS, per Zach's rule.
const DISTURBED_FRAMES_TO_REARM = 2;

// THE LOAD-BEARING ASSUMPTION, STATED EXPLICITLY BECAUSE IT WAS MEASURED.
//
// Checked against Zach's 33 real scans: two DIFFERENT cards resting in the same
// spot produce detections with IoU 0.98-1.00. Settled frames alone therefore
// would NEVER break stability -- 0 of 4 consecutive pairs did.
//
// So re-arming does not depend on the new card looking different once it has
// landed. It depends on the live loop OBSERVING THE DROP: the hand entering
// frame, the card in motion, the momentary occlusion. At ~7 fps a hand movement
// spans several frames, each of which fails the IoU or area test and resets the
// counter.
//
// This is the same physical event barcode scanners key on ("remove and
// re-present"), just observed as motion rather than as absence. It is why the
// design should work where three attempts at "does this card LOOK different"
// failed -- but it is an assumption about the live camera, and the only way to
// confirm it is a real scanning session.
//
// IF IT PROVES WRONG, the fix is NOT to loosen these thresholds -- that would
// rescan a still card forever. It is to require the frame to CLEAR between
// cards (option (b) Zach declined), or to add his suggested tap-to-force.

// ---------------------------------------------------------------------------
// HOW FAR TO ZOOM THE LENS IN FOR SCANNING.
//
// Zach: "I think our zoom needs to mimic mana boxes I think we are zoomed to
// far out."
//
// MEASURED, NOT PICKED. On the real preview pixels from his screenshot the card
// filled 41% of the width and 18% OF THE FRAME AREA — four fifths of every
// captured pixel was desk. Everything downstream lives on that pixel budget:
// the art matcher's features, and the collector number, which is a ~2mm-tall
// line of text that has to survive all the way to OCR.
//
// 0.65 / 0.41 is ~1.6x. Zach tested 1.8x on his phone and asked to back it out
// "just a tad" — at 1.8x the crop came out 2872px and was downscaled to the
// 2000px upload, so the extra zoom was being thrown away at the wire anyway.
//
// WHY NOT MORE. The detector needs visible margin AROUND the card to find its
// border — that was PR #38, where a card filling the crop dropped collector
// number reads from 8/8 to 1/8. Filling the frame edge to edge would trade this
// bug for that one. 1.8x leaves roughly an eighth of the frame as margin on
// each side.
//
// WHY NOT LESS THAN 1.0, EVER: below 1.0 iOS switches to the ULTRA-WIDE lens,
// which is softer and lower resolution. See the lens pin in startCamera.
const SCAN_ZOOM = 1.6;

// THE CANCEL WINDOW before an auto-add commits. Lowered 2 -> 1.
//
// Two seconds per card is 33 seconds across a 100-card stack, spent watching a
// countdown that is almost never used: it exists to catch a mis-scan before it
// enters the collection, and the scan either looked right or it did not — that
// judgement takes a glance, not two seconds.
//
// It is not removed, because it is the only pre-commit undo on the auto path
// and Zach's standing rule is that silent state changes are unacceptable for
// software tracking physical objects. One second still shows the card name and
// still accepts a tap to cancel.
const SCAN_COUNTDOWN = 1;
const SCAN_ORB = 500;
// Server-side default after PR 22's latency work; sent explicitly so the value
// in play is visible here rather than implied.
const SCAN_RECALL_K = 50;

function CameraScanner({ onAddSuccess, showToast }) {
  const { t } = useT();

  const [stream, setStream] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const [scanMatches, setScanMatches] = useState([]);
  
  // UX scan history & effects states
  const [recentScans, setRecentScans] = useState([]);
  // Tap a recent scan to view/edit it; long-press to delete. Inspector reuses the
  // shared collection edit/delete modal (needs an entry-shaped object with entry_id).
  const [inspectorEntry, setInspectorEntry] = useState(null);
  // Long-press multi-select + bulk actions, same as the collection page.
  const recentSelect = useMultiSelect({
    showToast,
    onChanged: ({ ids, action }) => {
      onAddSuccess();
      // Recent scans is a local list: prune deleted tiles. Moves leave the tile
      // (its placement label just goes stale until the next scan).
      if (action === 'delete') setRecentScans(prev => prev.filter(s => !ids.includes(s.entry_id)));
    },
  });
  const [scanFlash, setScanFlash] = useState(null); // 'capture', 'error', or null
  // Draggable/rotatable scan guide: translate (px, relative to centered) + angle
  // (deg). Lets the user aim the crop at an off-center or tilted card.
  const [guideOffset, setGuideOffset] = useState({ x: 0, y: 0 });
  const [guideAngle, setGuideAngle] = useState(0);
  const [guideScale, setGuideScale] = useState(1);
  const guidePtrs = useRef(new Map());     // active pointerId -> {x,y}
  const guideGesture = useRef(null);        // snapshot taken at each pointer-count change
  
  // Camera active states
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraErrorKey, setCameraErrorKey] = useState('');
  const [autoScan, setAutoScan] = useState(false);
  const [showScanSettings, setShowScanSettings] = useState(false);
  // The review queue: cards scanned but not yet resolved to an exact printing.
  //
  // The controller is created ONCE (useRef, not useState) because it owns the
  // pending count across re-renders; recreating it would silently reset the
  // badge to zero mid-stack. React state mirrors it purely for rendering — the
  // SERVER remains the source of truth, and `refresh()` reconciles the count.
  const [showReviewQueue, setShowReviewQueue] = useState(false);
  const [queuePending, setQueuePending] = useState(0);
  const reviewQueueRef = useRef(null);
  if (!reviewQueueRef.current) {
    reviewQueueRef.current = createScanReviewQueue({
      onChange: (s) => setQueuePending(s.pendingCount),
    });
  }
  const reviewQueue = reviewQueueRef.current;
  // Reconcile against the server on mount, so a queue left over from a previous
  // session (or a reload mid-stack) shows its real size immediately rather than
  // appearing empty until something new is queued.
  useEffect(() => { reviewQueue.refresh(); }, [reviewQueue]);

  // THE SCAN SESSION. Same controller shape and the same reasoning as the review
  // queue above: created once so its count survives re-renders, mirrored into
  // React state purely for rendering, with the SERVER as the source of truth.
  //
  // Zach: "instead of auto putting in my collection. Just putting aside and at
  // the end letting me add all. That way I can ensure no weirdness occurred or
  // ensure there isn't any dupes."
  const [showStaging, setShowStaging] = useState(false);
  const [stagedCount, setStagedCount] = useState(0);
  const [stagedFlagged, setStagedFlagged] = useState(0);
  const stagingRef = useRef(null);
  if (!stagingRef.current) {
    stagingRef.current = createScanStaging({
      onChange: (s) => { setStagedCount(s.stagedCount); setStagedFlagged(s.flaggedCount); },
    });
  }
  const staging = stagingRef.current;
  // Reconcile on mount so a session left over from a previous visit (or a reload
  // mid-stack) shows its real size immediately instead of appearing empty —
  // which would look exactly like having lost it.
  useEffect(() => { staging.refresh(); }, [staging]);
  // Torch/Flashlight control
  const [isTorchOn, setIsTorchOn] = useState(false);
  // Manual exposure: caps ({min,max,step}) if the track exposes
  // exposureCompensation, else null (slider hidden). value = current setting.
  const [exposureCaps, setExposureCaps] = useState(null);
  const [exposure, setExposure] = useState(0);

  // Per-set index prep state for MTG set-scoped matching: 'idle'|'building'|'ready'.
  const [setPrep, setSetPrep] = useState('idle');
  // Build progress while status==='building': { total, done, status } or null.
  const [setBuildProgress, setSetBuildProgress] = useState(null);
  // Why a set index could not be built, when setPrep === 'error'.
  const [setBuildError, setSetBuildError] = useState(null);
  const scanGame = 'mtg';
  // Set-scoped scanning across one or more MTG sets.
  const [scanSetCodes, setScanSetCodesState] = useState([]);
  const persistSets = (arr) => { setScanSetCodesState(arr); localStorage.setItem('scanner_set_mtg', arr.join(',')); };
  const addSetCode = (code) => { const c = (code || '').trim(); if (c && !scanSetCodes.some(x => x.toLowerCase() === c.toLowerCase())) persistSets([...scanSetCodes, c]); };
  const removeSetCode = (code) => persistSets(scanSetCodes.filter(c => c !== code));
  const scanSetParam = scanSetCodes.join(',');
  const [setInput, setSetInput] = useState('');
  const [setList, setSetList] = useState([]);        // {id,name,...} for the active game
  const [setSearchOpen, setSetSearchOpen] = useState(false);
  const setScanCode = (s) => s.ptcgo_code || (s.id || '').replace(/^mtg-/, '');
  const setQuery = setInput.trim().toLowerCase();
  const setSuggestions = setQuery
    ? setList.filter(s => !scanSetCodes.some(c => c.toLowerCase() === (setScanCode(s) || '').toLowerCase())
        && [s.id, s.ptcgo_code, s.name].some(v => (v || '').toLowerCase().includes(setQuery))).slice(0, 8)
    : [];
  // Resolve a code to its set record so the UI can show the full name next to
  // the code (e.g. "Foundations (FDN)"). Falls back to the bare code for
  // free-typed sets not in the cached list.
  const labelForCode = (code) => { const m = setList.find(s => (setScanCode(s) || '').toLowerCase() === code.toLowerCase()); return m ? `${m.name} (${setScanCode(m)})` : code; };
  const setLabelJoined = scanSetCodes.map(labelForCode).join(', ');

  const [debugHashImg, setDebugHashImg] = useState('');
  const [debugCandidates, setDebugCandidates] = useState([]);
  const [debugScoped, setDebugScoped] = useState(null); // set code if set-scoped, false if global, null if n/a

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const currentScanId = useRef(0);

  // Auto-capture duplicate guard: a physical card lingers in frame across the
  // 3s auto-scan cycle. lastAddedId = the card just auto-added; a repeat match
  // of it means "same card again" — confirm a real 2nd copy vs a re-scan.
  // resolvedDupId = a repeat we already settled; skip it silently until a
  // different card appears (stops a re-prompt loop while it stays in view).
  const lastAddedIdRef = useRef(null);
  // WHAT THE LAST AUTO TICK DID, so the scheduler can wait proportionally:
  // 'rejected' (gate skipped, nothing captured), 'settle' (a scan ran), or
  // 'error'. A ref rather than state on purpose — the capture path writes it
  // mid-tick and the scheduler reads it on the next run, so it must not trigger
  // a re-render or race with one.
  const lastTickOutcomeRef = useRef('settle');
  const resolvedDupIdRef = useRef(null);
  // PR 9: the auto-scan queue path guards on the matched card NAME, because
  // that path never resolves a printing itself — the server does — so it has no
  // card id to compare. Kept as its OWN ref rather than reusing
  // resolvedDupIdRef: that one holds card IDs everywhere else, and storing two
  // different kinds of value in one ref would make a future "why doesn't this
  // match?" bug very hard to see.
  const lastQueuedNameRef = useRef(null);

  // BUG 2 (auto-scan blur): the sharpness gate's rolling state.
  //
  // A PLAIN OBJECT IN A REF, deliberately — { skips, bestScore, recent }, no
  // timer handles, no DOM nodes, nothing with a lifecycle. An earlier PR
  // shipped an iOS Safari crash by packing bare setTimeout handles into an
  // object on this screen, so this state is kept to values that are safe to
  // drop at any moment. `recent` is a bounded array of at most
  // SHARPNESS_WINDOW plain numbers, so it cannot grow.
  //
  // Losing it costs at most a few frames captured ungated while the baseline
  // relearns — which is the SAFE direction to fail.
  //
  // It is a REF and not state on purpose: updating it must NOT re-render the
  // scanner. It changes on every auto tick, and a re-render per tick would
  // restart the capture effect below and disturb the very cadence it gates.
  const sharpnessRef = useRef(newGateState());
  // Scratch canvas for scoring settled preview frames. Reused rather than
  // allocated per frame: this runs several times a second on a phone.
  const sharpProbeRef = useRef(null);

  // The last few gate decisions, kept ONLY so Zach can read the numbers.
  //
  // BUG 2 was a guessed threshold that nobody could check against a real
  // camera: it took him scanning a stack and reporting "hold steady showed on
  // like every card" to discover it. A ratio cannot go wrong the same way, but
  // if the gate misbehaves again the next fix must be MEASURED. So the
  // observed score and the baseline it was judged against are surfaced in the
  // scanner's existing debug panel rather than living only in a variable.
  //
  // Bounded to the last 12 entries of plain numbers and short strings.
  //
  // THE REF IS THE SOURCE OF TRUTH; the state below is a display MIRROR.
  //
  // Why both: the ref must be updated on every auto tick without re-rendering,
  // because a re-render per tick restarts the capture effect and disturbs the
  // very cadence the gate is measuring. But the panel can only show what is in
  // state. So the ref is written every tick, and the state is synced only when
  // a scan actually proceeds — at which point a render is happening anyway.
  const gateLogRef = useRef([]);
  const [gateLog, setGateLog] = useState([]);

  // THE NEGOTIATED CAMERA MODE, and the size of the last upload.
  //
  // Both exist for the same reason gateLogRef does: this repo runs no browser
  // and no camera, so what the phone actually delivered is unknowable from here
  // and the only way to make the NEXT adjustment measured instead of guessed is
  // to put the real numbers where Zach can read them back to us. Rendered in
  // the EXISTING diagnostics panel, in its existing type scale — no new screen.
  //
  // null means "we could not determine it", which is displayed as such rather
  // than as a zero. A fabricated diagnostic is worse than a missing one.
  const [cameraInfo, setCameraInfo] = useState(null);
  const [uploadInfo, setUploadInfo] = useState(null);
  // WHICH CAPTURE PATH ACTUALLY FIRED: 'photo' (ImageCapture.takePhoto, Apple's
  // still pipeline) or 'video' (a frame off the preview). takeStillPhoto falls
  // back silently by design, so without this the difference between "the still
  // path is working" and "it silently degraded on every scan" is invisible —
  // and that is precisely the question this change has to answer on Zach's
  // phone, since no browser runs in this repo.
  const [captureSource, setCaptureSource] = useState(null);
  // THE LIVE CARD OUTLINE. Zach: "I want live drawing going green when it has
  // it." null = nothing found; otherwise { x, y, w, h, confidence } in PREVIEW
  // element coordinates, ready to position a div over the video.
  //
  // State rather than a ref because the outline must RE-RENDER as the card
  // moves — that motion is the entire feature.
  const [liveDetect, setLiveDetect] = useState(null);
  const detectCanvasRef = useRef(null);
  // MIRRORED INTO A REF for the capture path. handleCapture is invoked from a
  // timer closure, so reading the state variable there can see a stale value
  // from a previous render — and cropping to a stale detection would frame the
  // card's PREVIOUS position. The ref always holds the latest.
  const liveDetectRef = useRef(null);
  // STABILITY GATING. `stableCountRef` counts consecutive frames whose
  // detection agrees with the previous one; `prevDetRef` is that previous
  // detection. Refs, not state: the live loop writes these ~7x/second and
  // re-rendering on each frame would cost more than the detection itself.
  const prevDetRef = useRef(null);
  const stableCountRef = useRef(0);
  // Set once a stable period has already fired a capture, so ONE stable period
  // produces exactly ONE scan. Cleared when the detection is disturbed --
  // which is what dropping the next card on the stack does.
  const stablePeriodConsumedRef = useRef(false);
  // Consecutive frames whose detection disagreed with the previous one. Used to
  // tell a real placement from detector jitter -- see DISTURBED_FRAMES_TO_REARM.
  const disturbedRunRef = useRef(0);
  // Card-in-view is STATE as well, because the UI tells Zach why it is waiting.
  // A scanner that has silently decided not to scan is indistinguishable from a
  // broken one.
  const [cardPresent, setCardPresent] = useState(false);
  // Has the detection held still long enough to count as a deliberate
  // presentation? Drives both the capture trigger and the on-screen status, so
  // what Zach sees and what the scanner decides cannot disagree.
  const [steady, setSteady] = useState(false);

  // FULLSCREEN SCAN MODE. Default ON for touch devices, because the whole point
  // of the change is that a phone preview must fill the screen: the guide box is
  // 72% of the preview's height and the crop is driven by its rendered rect, so
  // preview size translates DIRECTLY into how many pixels land on the collector
  // number. Desktop keeps the existing boxed layout, which is the production
  // look on a big screen and has no reason to change.
  //
  // It is a MODE ON THE EXISTING SCREEN, not a new screen: the same JSX, the
  // same controls, the same diagnostics panel, the same review-queue banner —
  // only the container class changes. That keeps the drag/rotate/pinch guide
  // adjustment, the settings panel and the queue reachable exactly as before.
  const [fullscreenScan, setFullscreenScan] = useState(() => {
    try {
      // matchMedia is guarded: it is absent in some embedded webviews and this
      // must never be the thing that stops the scanner rendering.
      return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(max-width: 900px)').matches;
    } catch {
      return false;
    }
  });

  const beepCtxRef = useRef(null); // reused AudioContext for the scan cue
  const handleCaptureRef = useRef(null); // always the latest handleCapture, for timers
  const captureBlockedRef = useRef(false); // true while a modal/picker/drawer is up
  const loadingRef = useRef(false); // mirrors `loading` for the metronome interval

  // Instant feedback cue: flash the guide-box border, click, and (on mobile)
  // vibrate. 'capture' fires the instant the photo is grabbed so the user can
  // move the card immediately; 'error' marks a failed/no-match scan. Web Audio
  // only (no asset/lib); no-ops if the browser blocks audio until a gesture.
  const signal = (type) => {
    setScanFlash(type);
    setTimeout(() => setScanFlash(null), type === 'capture' ? 400 : 1500);
    if (type === 'capture' && navigator.vibrate) navigator.vibrate(30);
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = beepCtxRef.current || (beepCtxRef.current = new AC());
      const play = () => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = type === 'capture' ? 'square' : 'sine';
        osc.frequency.value = type === 'error' ? 300 : 660; // capture = crisp click
        osc.connect(gain); gain.connect(ctx.destination);
        const dur = type === 'capture' ? 0.05 : 0.15; // short = click, long = tone
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
        osc.start(); osc.stop(ctx.currentTime + dur);
      };
      // Mobile auto-suspends the context between non-gesture captures; resume is
      // async, so scheduling into a suspended context is silent. Play only once
      // it's actually running.
      if (ctx.state === 'suspended') ctx.resume().then(play).catch(() => {});
      else play();
    } catch { /* audio unavailable — visual flash still fires */ }
  };

  const handleCancelScan = () => {
    currentScanId.current += 1;
    setLoading(false);
    setScanStatus('Scan cancelled.');
    setTimeout(() => {
      setScanStatus(prev => prev === 'Scan cancelled.' ? '' : prev);
    }, 2000);
  };

  // Guide box drag/rotate/scale. Pointer capture on the box routes all move/up
  // events here. One finger = move; two fingers = pinch-scale + twist-rotate +
  // drag by the midpoint. Snapshot is re-taken on every pointer-count change so
  // switching finger count rebases smoothly.
  const snapshotGuideGesture = () => {
    const el = document.querySelector('.scan-card-guide');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const base = {
      startOffset: guideOffset, startAngle: guideAngle, startScale: guideScale,
      cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2,
    };
    const pts = [...guidePtrs.current.values()];
    if (pts.length >= 2) {
      const [p, q] = pts;
      guideGesture.current = {
        mode: 'pinch', ...base,
        d0: Math.hypot(q.x - p.x, q.y - p.y) || 1,
        a0: Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI,
        mid0: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
      };
    } else if (pts.length === 1) {
      guideGesture.current = { mode: 'move', ...base, startX: pts[0].x, startY: pts[0].y };
    } else {
      guideGesture.current = null;
    }
  };
  const onGuidePointerDown = (e) => {
    guidePtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    snapshotGuideGesture();
    e.stopPropagation();
  };
  const onGuidePointerMove = (e) => {
    if (!guidePtrs.current.has(e.pointerId)) return;
    guidePtrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = guideGesture.current;
    if (!g) return;
    const pts = [...guidePtrs.current.values()];
    if (g.mode === 'pinch' && pts.length >= 2) {
      const [p, q] = pts;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      const a = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      setGuideScale(Math.min(3, Math.max(0.3, g.startScale * (d / g.d0))));
      setGuideAngle(g.startAngle + (a - g.a0));
      setGuideOffset({ x: g.startOffset.x + (mid.x - g.mid0.x), y: g.startOffset.y + (mid.y - g.mid0.y) });
    } else if (g.mode === 'move') {
      setGuideOffset({ x: g.startOffset.x + (e.clientX - g.startX), y: g.startOffset.y + (e.clientY - g.startY) });
    }
  };
  const onGuidePointerUp = (e) => {
    guidePtrs.current.delete(e.pointerId);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    snapshotGuideGesture(); // rebase any remaining finger
  };
  const resetGuide = () => { setGuideOffset({ x: 0, y: 0 }); setGuideAngle(0); setGuideScale(1); };

  // Drawer states
  const [selectedCard, setSelectedCard] = useState(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [autoAddCountdown, setAutoAddCountdown] = useState(null);
  const [autoAddTargetCard, setAutoAddTargetCard] = useState(null);
  // Tap the countdown popup to pause auto-add and tweak these before adding
  // (slower tiers only — Turbo adds instantly with no overlay).
  const [autoAddEditing, setAutoAddEditing] = useState(false);
  const [autoAddCond, setAutoAddCond] = useState('Near Mint');
  const [autoAddPrint, setAutoAddPrint] = useState('nonfoil');
  // Duplicate-scan confirm: set to the repeat-matched card; dupQty = copies to add.
  const [dupConfirmCard, setDupConfirmCard] = useState(null);
  const [dupQty, setDupQty] = useState(1);

  useBackGuard(scanMatches.length > 0, () => setScanMatches([]));
  // Android hardware back / iOS swipe closes the review screen instead of
  // leaving the scanner entirely, matching every other overlay here.
  useBackGuard(showReviewQueue, () => setShowReviewQueue(false));

  useBackGuard(!!dupConfirmCard, () => setDupConfirmCard(null));
  useBackGuard(!!inspectorEntry, () => setInspectorEntry(null));
  useBackGuard(recentSelect.selectMode, recentSelect.exitSelectMode);
  
  // Form states
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState('Near Mint');
  const [printing, setPrinting] = useState('nonfoil');

  const [purchasePrice, setPurchasePrice] = useState(0);

  // Keep a ref mirroring the latest stream so the unmount cleanup below (whose
  // closure is fixed from the first render) can always stop the live tracks.
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  // Clean up camera stream on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  // On game switch: restore that game's remembered set and load its set list
  // (for the search autocomplete).
  useEffect(() => {
    setScanSetCodesState((localStorage.getItem('scanner_set_mtg') || '').split(',').map(s => s.trim()).filter(Boolean));
    setSetInput('');
    setSetSearchOpen(false);
    fetch('/api/sets?game=mtg').then(r => r.ok ? r.json() : []).then(setSetList).catch(() => setSetList([]));
  }, []);

  // When a set code is set, build/verify that set's index on the server so scans
  // match within just that set (~300 cards) — accurate and fast. Polls until the
  // one-time build finishes.
  useEffect(() => {
    if (!scanSetParam) { setSetPrep('idle'); setSetBuildProgress(null); setSetBuildError(null); return; }
    let cancelled = false, timer, debounce;
    const poll = async () => {
      try {
        const r = await fetch('/api/prepare-set', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: 'mtg', set: scanSetParam, lang: 'en' }),
        });
        const d = await r.json();
        if (cancelled) return;
        if (d.ready) { setSetPrep('ready'); setSetBuildProgress(null); setSetBuildError(null); return; }
        // Unbuildable (no such set in this language, or the provider has no card
        // data for it). Stop polling and say so — retrying cannot help, and the
        // silent "fetching card list" spinner is what made this look like a hang.
        if (d.failed) { setSetPrep('error'); setSetBuildProgress(null); setSetBuildError(d.error || 'This set could not be indexed.'); return; }
        setSetPrep('building');
        setSetBuildProgress(d.progress || null);
        setSetBuildError(d.failures && d.failures.length ? d.failures[0].error : null);
        timer = setTimeout(poll, 1000);
      } catch { if (!cancelled) setSetPrep('idle'); }
    };
    debounce = setTimeout(() => { setSetPrep('building'); poll(); }, 200);
    return () => { cancelled = true; clearTimeout(debounce); if (timer) clearTimeout(timer); };
  }, [scanSetParam]);

  // Detect manual-exposure support on the live track. Present on most Android
  // Chrome back cameras; absent on iOS Safari and many desktop webcams (slider
  // then stays hidden). Reads the current value so the slider starts in place.
  useEffect(() => {
    const track = stream?.getVideoTracks?.()[0];
    if (!track || typeof track.getCapabilities !== 'function') { setExposureCaps(null); return; }
    const ec = track.getCapabilities().exposureCompensation;
    if (ec && typeof ec.min === 'number' && typeof ec.max === 'number') {
      setExposureCaps({ min: ec.min, max: ec.max, step: ec.step || (ec.max - ec.min) / 100 || 0.1 });
      const cur = track.getSettings?.().exposureCompensation;
      setExposure(typeof cur === 'number' ? cur : 0);
    } else {
      setExposureCaps(null);
    }
  }, [stream]);

  // Bind the camera stream to the video element when both are ready
  useEffect(() => {
    if (cameraActive && stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      // Explicitly call play to ensure the stream plays on all mobile browsers
      videoRef.current.play().catch(err => {
        console.error('Error playing video stream:', err);
      });
    }
  }, [cameraActive, stream]);

  // Auto-Add Countdown Effect
  useEffect(() => {
    let intervalId;
    if (autoAddEditing) {
      // Paused for manual edit: freeze the countdown, don't fire.
    } else if (autoAddCountdown !== null && autoAddCountdown > 0) {
      intervalId = setInterval(() => {
        setAutoAddCountdown(prev => prev - 1);
      }, 1000);
    } else if (autoAddCountdown === 0 && autoAddTargetCard) {
      const cardToTrigger = autoAddTargetCard;
      setAutoAddTargetCard(null);
      setAutoAddCountdown(null);
      autoAddCard(cardToTrigger);
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAddCountdown, autoAddTargetCard, autoAddEditing]);

  // Capture scheduler: fire the next capture after the previous scan finishes
  // (loading drops), waiting an amount PROPORTIONAL TO WHAT JUST HAPPENED.
  //
  // See SCAN_RETRY_* — a frame the sharpness gate skipped captured nothing and
  // must not be punished with the same pause as a completed scan. That flat
  // 3s-after-everything is the bulk of the per-card time Zach measured.
  //
  // PR 9: the fixed-cadence metronome that used to sit here is gone with the
  // scan-detail slider. It only ever ran for the 'Turbo' preset (the sole
  // profile carrying a `cadence`), and Turbo was the 400px/recallK-28 tier the
  // measurements retired. With one profile there is no cadence, so that whole
  // branch was unreachable code — and unreachable timer code on a page Zach
  // uses for long stretches is a liability, not a spare option.
  useEffect(() => {
    let timerId;
    if (cameraActive && autoScan && !isDrawerOpen && !loading && scanMatches.length === 0 && !autoAddTargetCard && !dupConfirmCard) {
      const outcome = lastTickOutcomeRef.current;
      const delay = outcome === 'rejected' ? SCAN_RETRY_REJECTED_MS
        : outcome === 'error' ? SCAN_RETRY_ERROR_MS
        : SCAN_RETRY_SETTLE_MS;
      timerId = setTimeout(() => {
        // TWO GATES BEFORE CAPTURING, both from Zach's rule: "We shouldn't
        // capture a card until we know there is a card in view and if a new
        // card doesn't come in view we shouldn't just keep scanning the same
        // card."
        //
        // 1. IS A CARD ACTUALLY IN VIEW? Previously auto-scan fired on a timer
        //    regardless, so an empty mat or a hand was uploaded and matched
        //    against 57,000 cards. `liveDetectRef` is what draws the outline he
        //    already sees, so the gate agrees with the UI by construction.
        //
        // 2. IS IT A DIFFERENT CARD FROM THE ONE JUST SCANNED? Being slow to
        //    swap cards previously scanned the same card twice, which for
        //    software tracking physical objects reports owning two of something
        //    he owns one of.
        //
        // The effect re-runs on every state change in the dep list, so this
        // re-checks continuously rather than deciding once. Failing a gate here
        // is NOT an error and must not back off: the moment he swaps cards the
        // signature changes and the next tick fires normally.
        // CAPTURE ON STABILITY. The detection must have held still for
        // STABLE_FRAMES_REQUIRED consecutive frames, and this stable period
        // must not have already produced a scan.
        //
        // This replaces three failed attempts to infer "is this a different
        // card?" from a preview frame. That question is unanswerable; this one
        // is not. See SCANNER_CAPTURE_REDESIGN.md and the constants above.
        //
        // The timer that still schedules this callback is a POLL, not a
        // deadline: it decides how often the condition is re-checked, never
        // whether to capture. Nothing here is measured on elapsed time.
        if (!liveDetectRef.current) return;
        if (stableCountRef.current < STABLE_FRAMES_REQUIRED + SETTLE_FRAMES_BEFORE_CAPTURE) return;
        if (stablePeriodConsumedRef.current) return;
        // One capture per stable period. Cleared the moment the detection is
        // disturbed -- i.e. when the next card lands on the stack.
        stablePeriodConsumedRef.current = true;
        handleCaptureRef.current?.(true);   // auto: subject to the sharpness gate
      }, delay);
    }
    return () => {
      if (timerId) clearTimeout(timerId);
    };
  // `cardPresent` and `steady` are in the dep list so the effect re-evaluates
  // the moment a card enters or leaves the frame, or the moment the detection
  // settles -- rather than waiting for an unrelated state change to wake it.
  }, [cameraActive, autoScan, isDrawerOpen, loading, scanMatches, autoAddTargetCard, dupConfirmCard, cardPresent, steady]);

  // WHY AUTO-SCAN IS WAITING, in Zach's words rather than the code's.
  //
  // A scanner that has silently decided not to fire is indistinguishable from a
  // broken one — that is the whole reason the status line exists. Both new gates
  // therefore say what they are waiting for.
  //
  // NOW IT NAMES EVERY BLOCKER, not just the first two. Three sessions in a row
  // have been spent guessing which latch stopped the scanner from my side of
  // the wire, while Zach could see the screen and I could not. The screen is
  // the fastest instrument available and it was reporting almost nothing:
  // "it stopped scanning and tapping didn't do anything" is all the UI allowed
  // him to tell me. Every condition that can suppress a capture now says so by
  // name, so the next report identifies the latch instead of the symptom.
  const autoScanWaitReason = (() => {
    if (!cameraActive || !autoScan) return '';
    // Ordered by how early each one short-circuits the capture effect, so the
    // message names the FIRST thing actually blocking.
    if (loading) return 'Scanning…';
    if (isDrawerOpen) return 'Waiting — a panel is open';
    if (scanMatches.length > 0) return 'Waiting — pick a match';
    if (autoAddTargetCard) return 'Waiting — confirming a card';
    if (dupConfirmCard) return 'Waiting — confirming a duplicate';
    // NAME THE DETECTOR WHEN NOTHING IS FOUND.
    //
    // "Waiting for a card" is ambiguous between "point the camera at a card"
    // and "the detector is broken again", and that ambiguity has cost several
    // rounds of guessing. If the trained detector failed to load, the preview
    // is running on the edge detector -- which finds 9/33 -- and Zach needs to
    // see that on screen rather than have me infer it later.
    if (!cardPresent) {
      return detectorReady() ? t('scan.waitingForCard') : 'Waiting for a card (basic detector)';
    }
    if (!steady) return t('scan.holdSteady');
    return '';
  })();

  // THE LIVE DETECTION LOOP — the outline Zach sees.
  //
  // Runs on an interval rather than requestAnimationFrame: this competes with
  // the video pipeline for main-thread time, and the outline only has to feel
  // live, not hit 60fps. ~7/sec tracks a hand-held card smoothly at a fraction
  // of the cost.
  //
  // Detection happens on a SMALL greyscale copy (160px wide). The card's edges
  // and its interior texture both survive that downscale, and it keeps a whole
  // pass well under a frame budget on a phone.
  useEffect(() => {
    if (!cameraActive) { liveDetectRef.current = null; setLiveDetect(null); return undefined; }
    let cancelled = false;
    // Start loading the detector when the camera opens. Fire-and-forget: the
    // loop runs on the edge detector until the model is ready, and for ever if
    // it never loads.
    initCardDetector();

    const tick = async () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (!video || !video.videoWidth) return;
      try {
        const DW = 160;
        const DH = Math.max(1, Math.round(DW * (video.videoHeight / video.videoWidth)));
        let c = detectCanvasRef.current;
        if (!c) { c = document.createElement('canvas'); detectCanvasRef.current = c; }
        if (c.width !== DW || c.height !== DH) { c.width = DW; c.height = DH; }
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, DW, DH);
        const { data } = ctx.getImageData(0, 0, DW, DH);

        // Luma, not a channel average: it weights green the way the eye does,
        // which keeps card art and text separable from a pale surface.
        const gray = new Uint8ClampedArray(DW * DH);
        for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
          gray[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
        }

        // THE TRAINED DETECTOR LEADS; THE EDGE DETECTOR FALLS BACK.
        //
        // Zach: "yeah I said this earlier about using the yolo detector for
        // measuring this please build it."
        //
        // Measured on his 33 real scans: the edge detector finds a card in
        // 9/33, and 21 of the 24 misses fail the ASPECT test -- it latches onto
        // the strongest edges, which on a STACK OF CARDS are not the card's
        // outline. The trained detector finds 31/33 of the same photos, and
        // Phase 4a measured it at 142ms on his iPhone over 2,195 inferences.
        //
        // YOLO needs COLOUR, so it gets the RGBA buffer; the edge detector
        // keeps the greyscale copy it was written for. Both return the same
        // { x, y, w, h, confidence } shape in detection-pixel space, so the
        // outline mapping and stability logic below are untouched.
        //
        // detectCardOnDevice returns null for "no card" AND for every failure,
        // including "model never loaded" -- so this degrades to exactly today's
        // behaviour rather than to a frozen preview.
        let det = null;
        if (detectorReady()) det = await detectCardOnDevice(data, DW, DH);
        if (!det) det = detectCardInFrame(gray, DW, DH);
        if (cancelled) return;
        if (!det) {
          liveDetectRef.current = null;
          setLiveDetect(null);
          // No card: the run of stable frames is over. Resetting here is also
          // what re-arms capture after a card is lifted away.
          prevDetRef.current = null;
          stableCountRef.current = 0;
          disturbedRunRef.current = 0;
          stablePeriodConsumedRef.current = false;
          setCardPresent(false);
          setSteady(false);
          return;
        }
        setCardPresent(true);


        // Map from detection pixels to the PREVIEW ELEMENT's box. The video is
        // object-fit: cover, so it is centre-cropped: the scale is the LARGER
        // of the two ratios and the overflow is split evenly. Getting this wrong
        // draws the outline offset from the card, which would be worse than no
        // outline at all — it would look like the app is locked onto thin air.
        const rect = video.getBoundingClientRect();
        const scale = Math.max(rect.width / DW, rect.height / DH);
        const offX = (rect.width - DW * scale) / 2;
        const offY = (rect.height - DH * scale) / 2;
        const mapped = {
          x: det.x * scale + offX,
          y: det.y * scale + offY,
          w: det.w * scale,
          h: det.h * scale,
          confidence: det.confidence,
        };
        // COUNT CONSECUTIVE AGREEING FRAMES. Movement resets the run and, with
        // it, the "already captured" latch -- so dropping the next card on the
        // stack disturbs the quad and re-arms capture without Zach having to
        // clear the frame. That is his stated workflow: "I just drop cards on
        // top."
        if (detectionsAgree(mapped, prevDetRef.current)) {
          stableCountRef.current += 1;
          disturbedRunRef.current = 0;
        } else {
          stableCountRef.current = 1;
          // RE-ARM ONLY AFTER A SUSTAINED DISTURBANCE, NOT A SINGLE ODD FRAME.
          //
          // Zach: "evil thrall scanned twice even though I never tapped or
          // anything after it scanned the first time."
          //
          // This used to clear the latch on ANY disagreeing frame. The trained
          // detector regresses a box per frame, so its output naturally jitters
          // by a pixel or two even on a motionless card; one frame drifting past
          // the IoU threshold re-armed capture and the same card scanned again.
          //
          // A real placement disturbs the view for SEVERAL consecutive frames --
          // the hand enters, the card falls, the box moves and resizes. Jitter
          // does not. Requiring a run of disturbed frames separates them without
          // needing to know anything about what the card looks like, and without
          // a clock.
          disturbedRunRef.current += 1;
          if (disturbedRunRef.current >= DISTURBED_FRAMES_TO_REARM) {
            stablePeriodConsumedRef.current = false;
          }
        }
        prevDetRef.current = mapped;

        // TEACH THE SHARPNESS BASELINE FROM SETTLED FRAMES ONLY.
        //
        // Zach: "scanning seems to be getting worse at one point it was doing
        // really good". Four of seven queues had NO collector-number line in
        // the OCR text -- the capture was blurred, so the text was never in the
        // image.
        //
        // The sharpness gate is RELATIVE: it rejects a frame scoring below 0.6x
        // the median of recent frames. Its window was sized for the old ~3s
        // cadence, where most observed frames were of a settled card. Stability
        // gating changed that: captures now cluster around card swaps, so the
        // window filled with post-motion frames, the median sank to the blur
        // level, and blurred frames read as "sharp".
        //
        // Driving the real decideCapture with a realistic swap/settle sequence
        // accepted 8 of 12 BLURRED frames -- the gate was blind exactly when he
        // was scanning fast.
        //
        // The fix is to feed it the frames it was always meant to judge
        // against: those observed while the detection is STABLE. Then the
        // baseline describes a settled card on this device, and a frame grabbed
        // mid-swap is measured against that rather than against other blur.
        if (stableCountRef.current >= STABLE_FRAMES_REQUIRED) {
          try {
            const gw = 160, gh = Math.max(3, Math.round(DH * (gw / DW)));
            const gc = sharpProbeRef.current || (sharpProbeRef.current = document.createElement('canvas'));
            if (gc.width !== gw || gc.height !== gh) { gc.width = gw; gc.height = gh; }
            const gctx = gc.getContext('2d', { willReadFrequently: true });
            gctx.drawImage(video, 0, 0, gw, gh);
            const gp = gctx.getImageData(0, 0, gw, gh);
            const sc = laplacianVarianceScore(gp.data, gw, gh);
            // OBSERVE ONLY. This records what a settled frame scores; it does
            // NOT decide anything and must never trigger a capture.
            sharpnessRef.current = {
              ...sharpnessRef.current,
              recent: [...(sharpnessRef.current.recent || []), sc].slice(-SHARPNESS_WINDOW),
            };
          } catch {
            // A tainted canvas must not break the preview. The gate keeps
            // whatever baseline it already had.
          }
        }
        const isSteady = stableCountRef.current >= STABLE_FRAMES_REQUIRED
          && !stablePeriodConsumedRef.current;
        setSteady(isSteady);

        liveDetectRef.current = mapped;
        setLiveDetect(mapped);
      } catch {
        // A detection failure must never break the preview.
        if (!cancelled) { liveDetectRef.current = null; setLiveDetect(null); }
      }
    };

    // SELF-SCHEDULING, NOT setInterval.
    //
    // The tick is now async: on-device inference measured ~142ms on Zach's
    // iPhone, against a 140ms interval. setInterval does not wait, so ticks
    // would overlap and pile up -- each one holding a frame buffer, on a phone,
    // in a loop that runs for as long as he is scanning.
    //
    // Chaining the next tick from the end of the previous one makes the loop
    // self-limiting: it runs as fast as inference allows and no faster, and it
    // cannot queue work behind itself. The 140ms is a floor on the gap, not a
    // deadline for the work.
    let timer = null;
    const pump = async () => {
      if (cancelled) return;
      await tick();
      if (cancelled) return;
      timer = setTimeout(pump, 140);
    };
    pump();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [cameraActive]);

  const updateAdvancedConstraints = (track, newAdvancedProps) => {
    try {
      const currentConstraints = track.getConstraints();
      let advanced = currentConstraints.advanced ? [...currentConstraints.advanced] : [];
      let advObj = advanced.length > 0 ? { ...advanced[0] } : {};
      
      for (const [key, value] of Object.entries(newAdvancedProps)) {
        if (value === null || value === undefined) {
          delete advObj[key];
        } else {
          advObj[key] = value;
        }
      }
      
      // Apply ONLY the advanced set. Re-sending the top-level resolution
      // constraints (facingMode/width/height) makes many Android Chrome builds
      // reset the track and silently drop torch/focus. applyConstraints leaves
      // any field we don't name untouched, so the resolution stays put.
      track.applyConstraints({
        advanced: [advObj]
      }).catch(err => console.warn('applyConstraints error:', err));
    } catch (e) {
      console.warn('updateAdvancedConstraints error:', e);
    }
  };

  // Torch gets its own path (not the shared merge) so it applies the bare
  // `advanced: [{ torch }]` constraint and surfaces the real reason on-screen —
  // the user can't open a phone console. iOS Safari never reports caps.torch,
  // so those users get a clear "not supported" instead of a dead button.
  // THE TORCH IS DEFAULT-OFF AND MUST STAY THAT WAY (PR 11).
  //
  // `isTorchOn` initialises to false and nothing in this component ever turns
  // it on by itself — verified by FTORCH-TC1/TC2. That is not a stylistic
  // choice, it is the fix for a measured failure:
  //
  //   clean Scryfall image  ->  MATCH Fated Firepower tla#132
  //   Zach's phone photo    ->  noise: Transpose 9, Outpace Oblivion 8, ...
  //
  // The card was neither foil nor sleeved. A phone torch is a small, intense
  // source inches from glossy modern card stock, so it produces a SPECULAR
  // HIGHLIGHT — a blown-out patch where pixels saturate and the information
  // under them is destroyed, not merely brightened. That patch sits on the
  // artwork, which is exactly what the CLIP matcher reads. Ambient room light
  // is diffuse and spreads its energy over the whole face instead.
  //
  // So the torch actively HARMS the thing it looks like it should help, and
  // that is deeply counter-intuitive — "it's dark, turn on the light" is the
  // obvious move, and it is the wrong one here. Leaving that unsaid means the
  // next person to hit a dim room rediscovers the failure the hard way, so
  // enabling it warns ONCE rather than silently degrading matching.
  const toggleTorch = async () => {
    const track = stream?.getVideoTracks()[0];
    if (!track) { showToast(t('scan.errCameraNotReady')); return; }
    // iOS Safari never reports caps.torch, so those users get a clear
    // "not supported" instead of a dead button. Degrade silently, never throw.
    const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
    if (!caps.torch) {
      showToast(t('scan.errNoTorch'));
      return;
    }
    const next = !isTorchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setIsTorchOn(next);
      if (next) showToast(t('scan.torchGlareWarning'));
    } catch (err) {
      showToast(t('scan.errTorch', { error: err.name || err.message || t('scan.unknownError') }));
    }
  };

  // Exposure bias. exposureCompensation is an EV offset on top of continuous
  // auto-exposure; in 'manual' mode the camera drives exposure by exposureTime/ISO
  // and ignores the compensation, so the slider must stay in continuous mode.
  const changeExposure = (val) => {
    setExposure(val);
    const track = stream?.getVideoTracks?.()[0];
    if (track) updateAdvancedConstraints(track, { exposureMode: 'continuous', exposureCompensation: val });
  };

  const startCamera = async () => {
    setCameraErrorKey('');
    setScanMatches([]);
    setScanStatus('');
    setDebugHashImg('');
    setDebugCandidates([]);
    setDebugScoped(null);
    // getUserMedia only exists in a secure context. Served over plain HTTP on a
    // LAN address (the usual Docker setup, http://host:3001) navigator.mediaDevices
    // is undefined, and the browser never shows a permission prompt at all — so
    // "check your permissions" sends people hunting for a setting that is fine.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraErrorKey('scan.errCameraInsecure');
      showToast(t('scan.errCameraInsecure', { origin: window.location.origin, port: window.location.port || '80' }));
      return;
    }
    try {
      // ASK BIG, ACCEPT WHATEVER COMES BACK. See SCAN_CAPTURE_IDEAL_W: every
      // constraint here is `ideal`, so a device that cannot deliver negotiates
      // DOWN instead of rejecting. There is no `exact` anywhere in this object
      // and there must never be one — an OverconstrainedError lands in the catch
      // below and the user is told their permissions are broken when they are
      // fine, ending with no camera at all.
      //
      // The old request was 1280x720. Held in portrait that is a 720px-wide
      // frame; with the guide box at 72% of a boxed preview the cropped card was
      // ~660px, which puts the printed collector number at roughly 6-8px tall —
      // the floor of OCR legibility, and the reason the scanner works in good
      // light and collapses when noise is added.
      const constraints = {
        video: {
          facingMode: 'environment', // Use back camera on phones
          width: { ideal: SCAN_CAPTURE_IDEAL_W },
          height: { ideal: SCAN_CAPTURE_IDEAL_H },
        },
        audio: false
      };

      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      // PIN THE LENS TO THE MAIN WIDE CAMERA, AND ZOOM IN TO FILL THE FRAME.
      //
      // On a multi-lens iPhone WebKit hands the page a VIRTUAL camera whose web
      // zoom domain is [0.5, 10] (cameraZoomScaleFactor() is 2.0 for
      // BuiltInTripleCamera / BuiltInDualWideCamera, and minZoom is 1/scale).
      // Anything BELOW 1.0 is the ULTRA-WIDE lens: softer, lower resolution,
      // and the single most common cause of "the web capture is mysteriously
      // blurrier than the native camera app". Leaving zoom unset inherits
      // whatever factor the device happens to be sitting at, and worse, iOS
      // hands off to the ultra-wide for MACRO when the subject is close — i.e.
      // exactly when a card is filling the frame, which is every scan.
      //
      // WHY 1.0 WAS NOT ENOUGH. Pinning to exactly 1.0 fixed the lens but left
      // us at the WIDEST non-ultra-wide setting, and Zach: "I think our zoom
      // needs to mimic mana boxes I think we are zoomed to far out." Measured on
      // his screenshot, the card filled 41% of the preview's width and 18% OF
      // ITS AREA — so more than four fifths of every captured pixel was desk.
      // That is the pixel budget the art matcher and the collector-number OCR
      // both have to live on, and it is why the number kept coming back short.
      //
      // SCAN_ZOOM targets the card filling ~75% of the short axis: 0.75 / 0.41
      // is ~1.8x. It deliberately stops short of filling the frame because the
      // detector NEEDS margin around the card to find its border at all — that
      // was PR #38, and cranking zoom to the point where the card is edge to
      // edge would reintroduce exactly that bug.
      //
      // Clamped into the device's real range, and never below 1.0, so the lens
      // pin still holds on hardware with a narrower zoom range.
      //
      // applyConstraints (not getUserMedia) because zoom must be applied after
      // the resolution preset has settled; WebKit re-derives the zoom range from
      // the chosen preset and clamps into it.
      //
      // `advanced` makes this a BEST-EFFORT constraint: a device without zoom
      // support ignores the block instead of failing the whole call. Guarded on
      // getCapabilities() as well, since it is optional in the spec, and wrapped
      // because a lens preference must never be the reason the camera fails to
      // open — a scanner on the wrong lens still scans.
      try {
        const zoomTrack = mediaStream.getVideoTracks?.()[0];
        const caps = typeof zoomTrack?.getCapabilities === 'function' ? (zoomTrack.getCapabilities() || {}) : {};
        if (caps.zoom && typeof zoomTrack.applyConstraints === 'function') {
          // Clamp into the device's real range: min can exceed 1.0 on hardware
          // that has no ultra-wide, and asking below min is an error there.
          const lo = Math.max(1.0, caps.zoom.min ?? 1.0);
          const hi = caps.zoom.max ?? lo;
          const target = Math.min(Math.max(lo, SCAN_ZOOM), hi);
          await zoomTrack.applyConstraints({ advanced: [{ zoom: target }] });
        }
      } catch {
        // Ignore: the stream is live and usable, just possibly on a softer lens.
        // The negotiated zoom is reported in the diagnostics panel below, so a
        // failure here is visible rather than silent.
      }
      // RECORD WHAT THE DEVICE ACTUALLY GAVE US.
      //
      // This is the single most important line for the next round of this
      // problem. Nothing in this repo runs a camera, so the negotiated mode is
      // unknowable from here — asking for 4032x3024 does not mean receiving it,
      // and iOS Safari in particular is free to hand back something else
      // entirely. Surfacing getSettings() in the diagnostics panel means the
      // next adjustment is MEASURED off Zach's real phone rather than guessed,
      // which is exactly the mistake the focus gate already cost a release to
      // learn (see gateLogRef).
      //
      // Defensive on every field: getSettings is optional in the spec, and a
      // browser that returns an empty object or omits width/height must degrade
      // to "unknown" rather than crash the only screen that opens the camera.
      try {
        const track = mediaStream.getVideoTracks?.()[0];
        const s = typeof track?.getSettings === 'function' ? (track.getSettings() || {}) : {};
        const w = Number.isFinite(s.width) ? s.width : null;
        const h = Number.isFinite(s.height) ? s.height : null;
        setCameraInfo({
          width: w,
          height: h,
          // Portrait use rotates the frame, so the SHORT side is what ends up
          // across the card. That is the number that decides how many pixels
          // land on the collector number, so it is shown explicitly rather than
          // left for someone to infer from WxH.
          shortSide: w && h ? Math.min(w, h) : null,
          frameRate: Number.isFinite(s.frameRate) ? Math.round(s.frameRate) : null,
          // The negotiated zoom, which is how we tell WHICH LENS we ended up on.
          // < 1.0 means the soft ultra-wide and explains a blurry capture on its
          // own; null means the device does not report zoom at all. Shown rather
          // than assumed, because the applyConstraints above is best-effort.
          zoom: Number.isFinite(s.zoom) ? Math.round(s.zoom * 100) / 100 : null,
          requestedW: SCAN_CAPTURE_IDEAL_W,
          requestedH: SCAN_CAPTURE_IDEAL_H,
        });
      } catch {
        // A browser that will not describe its own track is not a reason to
        // refuse the camera. Diagnostics are a nice-to-have; scanning is not.
        setCameraInfo(null);
      }
      setStream(mediaStream);
      setCameraActive(true);
    } catch (err) {
      console.error('Error opening camera:', err);
      setCameraErrorKey('scan.errCameraPermissions');
      showToast(t('scan.errCameraAccess'));
    }
  };

  const stopCamera = () => {
    if (stream) {
      const track = stream.getVideoTracks()[0];
      if (track && isTorchOn) {
        updateAdvancedConstraints(track, { torch: false });
      }
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setCameraActive(false);
    setAutoScan(false); // Reset autoScan on camera stop
    setIsTorchOn(false);
    // The negotiated mode belongs to the track that just stopped. Leaving it on
    // screen would show a resolution no live camera is producing, and a stale
    // diagnostic is exactly the kind of confidently-wrong state this app refuses
    // everywhere else.
    setCameraInfo(null);
    setUploadInfo(null);
    setCaptureSource(null);
    setDebugHashImg('');
    setDebugCandidates([]);
    setDebugScoped(null);
  };

  const autoAddCard = async (card, qty = 1, overrides = null) => {
    // Mark the dup guard BEFORE the await: a fast cooldown can fire the next
    // capture before this POST resolves, and a match of the same card must hit
    // the duplicate path instead of auto-adding a second time.
    lastAddedIdRef.current = card.id;
    try {
      const autoPrinting = overrides?.printing || 'nonfoil';
      const autoCondition = overrides?.condition || 'Near Mint';
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: card.id,
          quantity: qty,
          condition: autoCondition,
          printing: autoPrinting,
          // price_trend is whichever finish the TCG API returned first (usually
          // nonfoil), not necessarily the foil finish just chosen above -
          // resolve against the printing actually being recorded.
          purchase_price: resolveCardPrice(card, autoPrinting),
          location_id: null
        })
      });

      if (response.ok) {
        const data = await response.json();
        const qtyLabel = qty > 1 ? `${qty}× ` : '';
        const placementLabel = data.placement?.label || null;
        if (placementLabel) {
          showToast(t('scan.addedTo', { qty: qtyLabel, name: card.name, place: placementLabel }));
        } else if (data.container_full) {
          showToast(t('scan.addedFull', { qty: qtyLabel, name: card.name }));
        } else {
          showToast(t('scan.autoAdded', { qty: qtyLabel, name: card.name, set: card.set_name }));
        }

        // Append to recent scans history log. entry_id (the last inserted row)
        // lets the recent-scans price splitter target these exact entries and the
        // inspector edit/delete the entry. Carry the entry fields it was saved with.
        setRecentScans(prev => [{
          ...card, card_id: card.id, placementLabel, entry_id: data.id,
          quantity: qty, condition: autoCondition, printing: autoPrinting,
          purchase_price: resolveCardPrice(card, autoPrinting), location_id: null,
        }, ...prev].slice(0, 10));

        // Brief confetti blast for ultra-rares
        const rarity = (card.rarity || '').toLowerCase();
        if (rarity.includes('secret') || rarity.includes('ultra') || (card.price_trend || 0) > 15) {
          confetti({ particleCount: 50, spread: 40, origin: { y: 0.8 } });
        }
        
        onAddSuccess(); // Refresh stats
      } else {
        showToast(t('scan.errAutoAdd', { name: card.name }));
        signal('error');
      }
    } catch (err) {
      console.error('Auto-add error:', err);
      showToast(t('scan.errAutoAddGeneric'));
      signal('error');
    }
  };

  // Resolves the landscape-to-portrait camera stream rotation bug on mobile devices.
  // It creates a canvas matching the visual orientation on the user's screen.
  // Pass maxW to downscale the output (cheap enough to run every frame for the
  // live detection loop); omit it for a full-resolution capture.
  // THE STILL-PHOTO PATH. ImageCapture.takePhoto() (Safari 18.4+) routes through
  // AVCapturePhotoOutput — Apple's real still pipeline, with the multi-frame
  // processing the native Camera app uses — instead of grabbing a frame off the
  // realtime video preview, which iOS deliberately keeps cheap (no Smart HDR, no
  // Deep Fusion). That difference is exactly what Zach reported: on an identical
  // setup ManaBox looks clear and our preview looks soft, because a native app
  // previews the processed feed and a web page does not.
  //
  // Returns an ImageBitmap on success, or null to use the video frame. Null is a
  // normal outcome, not an error: iOS < 18.4 has no ImageCapture at all.
  //
  // GEOMETRY IS THE RISK, NOT QUALITY. The guide-box crop maps preview CSS pixels
  // onto the captured frame assuming the frame has the SAME ASPECT RATIO as the
  // video track. A photo can legitimately come back at a different aspect (a 4:3
  // still from a 16:9 video mode), and using it blind would silently crop the
  // WRONG REGION — no card, or half a card, which is worse than a soft image
  // because it fails without looking like a failure. So the photo must prove it
  // is geometrically compatible before it is used; anything else falls back.
  const takeStillPhoto = async (video) => {
    const track = stream?.getVideoTracks?.()[0];
    if (!track || typeof window === 'undefined' || typeof window.ImageCapture !== 'function') return null;
    if (track.readyState !== 'live') return null;
    try {
      const cap = new window.ImageCapture(track);
      // Ask for more than any sensor has: WebKit clamps to the largest supported
      // photo size. getPhotoCapabilities() is NOT consulted because WebKit fills
      // its imageWidth/imageHeight from the TRACK capabilities, which under-report
      // what takePhoto can actually deliver — so it would cap us at video
      // resolution, defeating the entire point.
      const blob = await cap.takePhoto({ imageWidth: 9999, imageHeight: 9999 });
      if (!blob || blob.size < 1024) return null;
      const bmp = await createImageBitmap(blob);

      // Compare aspect ratios ORIENTATION-INDEPENDENTLY: the still and the video
      // track can disagree about portrait/landscape while describing the same
      // framing, so both are normalised to long/short before comparing.
      const norm = (w, h) => (w >= h ? w / h : h / w);
      const photoAR = norm(bmp.width, bmp.height);
      const videoAR = norm(video.videoWidth || 1, video.videoHeight || 1);
      // 2% tolerance absorbs rounding between preset dimensions; a genuine
      // aspect change (4:3 vs 16:9 is 33%) is nowhere near this.
      if (!Number.isFinite(photoAR) || !Number.isFinite(videoAR)
          || Math.abs(photoAR - videoAR) / videoAR > 0.02) {
        bmp.close?.();
        return null;
      }
      // A still SMALLER than the video frame carries no more detail and costs a
      // shutter round-trip, so there is nothing to gain by using it.
      if (bmp.width * bmp.height <= (video.videoWidth || 0) * (video.videoHeight || 0)) {
        bmp.close?.();
        return null;
      }
      return bmp;
    } catch {
      // takePhoto rejects on an unready device, a concurrent capture, or a
      // watchdog timeout. All of these must degrade to the video frame — a
      // slightly soft scan is fine, a scanner that stops scanning is not.
      return null;
    }
  };

  const getOrientedVideoCanvas = (video, maxW = 0, source = null) => {
    // ORIENTATION IS DECIDED BY THE VIDEO, PIXELS COME FROM `source`.
    //
    // `source` is an optional higher-resolution still of the SAME SCENE (see
    // takeStillPhoto, which refuses anything with a different aspect ratio).
    // The rotation decision below must stay keyed to the VIDEO track, because it
    // compares the stream's shape against how the preview is laid out on screen
    // — that is a fact about the preview, not about the still. Using the still's
    // own dimensions here would re-derive the same answer on a compatible photo
    // and a WRONG one on any photo that slipped through, so the video stays
    // authoritative and the still only supplies pixels.
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    // Draw dimensions come from whichever image is actually being sampled.
    const src = source || video;
    const srcW = source ? source.width : videoWidth;
    const srcH = source ? source.height : videoHeight;
    const canvas = document.createElement('canvas');

    const videoRect = video.getBoundingClientRect();
    const streamRatio = videoWidth / videoHeight;
    const visualRatio = videoRect.width / videoRect.height;

    // Stream orientation rotation applies to mobile devices (iOS/Android)
    // where physical camera sensors deliver landscape raw frames while displayed in portrait.
    // Desktop webcams deliver unrotated frames matching the screen layout.
    const isMobile = isNative || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const isRotated = isMobile && ((streamRatio > 1.0 && visualRatio < 1.0) || (streamRatio < 1.0 && visualRatio > 1.0));

    // Oriented output dimensions, then an optional uniform downscale.
    // Driven by the SOURCE size so a high-resolution still produces a
    // correspondingly larger canvas — that extra detail is the entire point.
    const outW = isRotated ? srcH : srcW;
    const outH = isRotated ? srcW : srcH;
    const scale = (maxW && outW > maxW) ? maxW / outW : 1;
    canvas.width = Math.max(1, Math.round(outW * scale));
    canvas.height = Math.max(1, Math.round(outH * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale); // subsequent coords are in unscaled (oriented) space

    if (isRotated) {
      ctx.translate(outW / 2, outH / 2);
      ctx.rotate(90 * Math.PI / 180);
      ctx.drawImage(src, -srcW / 2, -srcH / 2, srcW, srcH);
    } else {
      ctx.drawImage(src, 0, 0, srcW, srcH);
    }

    return canvas;
  };

  // Present the image-match results: show the picker, and on a single result
  // take the fast path (auto-add / quick-
  // add per mode). autoSingle lets the caller allow the fast path for a single MTG
  // result too — used when the image match is confident and the printing is
  // unambiguous (only one printing, or the set code narrowed it to one). Ambiguous
  // MTG (many printings, no set code) still shows the picker.
  const applyMatches = async (matches, notFoundMsg, autoSingle = false, matchInliers = null) => {
    setScanMatches(matches);
    if (matches.length === 0) {
      // Nothing in frame — the resolved-duplicate card has left, so clear the
      // skip guard; re-presenting it later should prompt again, not skip forever.
      resolvedDupIdRef.current = null;
      setScanStatus(notFoundMsg);
      signal('error');
      return;
    }
    setScanStatus('');
    if (matches.length === 1 && (scanGame !== 'mtg' || autoSingle)) {
      if (autoScan) {
        const id = matches[0].id;
        // A LOW-CONFIDENCE MATCH IS NOT AN IDENTITY, so it must not drive the
        // duplicate guards below.
        //
        // Zach: "It's not really scanning each new card on top." The trace
        // showed why: two DIFFERENT foil cards both matched as 'Jeskai
        // Ascendancy' at 11 and 14 inliers -- noise. The second was then
        // suppressed as "same card still in view" and never scanned. The guard
        // was working correctly on an identity that was simply wrong.
        //
        // Below WEAK_MATCH_INLIERS the matcher is guessing (measured on Zach's
        // scans: correct matches 47-141, wrong ones 4-23), so a repeated name
        // carries no information about whether the CARDBOARD is the same. Let
        // it through and let the server's set+number resolution decide -- that
        // path reads the printed catalogue address and is right where the art
        // is not.
        const WEAK_MATCH_INLIERS = 25;
        const inl = Number.isFinite(matchInliers) ? matchInliers : matches[0].inliers;
        const identityIsTrusted = Number.isFinite(inl) && inl > WEAK_MATCH_INLIERS;

        if (identityIsTrusted && id === resolvedDupIdRef.current) {
          // Same card we already handled, still sitting in frame — wait for a
          // different card before doing anything.
          setScanMatches([]);
          setScanStatus('Same card still in view — swap in the next card.');
          return;
        }
        if (identityIsTrusted && id === lastAddedIdRef.current) {
          // Repeat of the card just auto-added: could be a real second copy or
          // just the same card lingering. Make the user decide.
          setDupConfirmCard(matches[0]);
          setDupQty(1);
          setScanMatches([]);
          return;
        }
        // A different card is now in frame — clear the skip guard so the old
        // resolved-duplicate card is scannable again later.
        resolvedDupIdRef.current = null;
        // The countdown overlay gives a window to cancel a mis-scan before the
        // card is added. SCAN_COUNTDOWN is fixed at 2 now that the profile
        // table is gone; the old countdown-0 fast path belonged to 'Turbo'.
        setAutoAddTargetCard(matches[0]);
        setAutoAddCountdown(SCAN_COUNTDOWN);
        setScanMatches([]);
      } else {
        openQuickAdd(matches[0]);
      }
    }
  };

  // `auto` distinguishes the two callers, and it is the ONLY thing the
  // sharpness gate keys on. The metronome effect passes true; the scan BUTTON
  // passes nothing, so a manual tap is never gated and always produces a scan.
  const handleCapture = async (auto = false, force = false) => {
    // `loading` guards against two scans running at once. A MANUAL tap may
    // override it, because a stuck `loading` is otherwise unrecoverable without
    // restarting the camera -- Zach: "tapping didn't get it to scan again".
    // Auto-scan never forces: only a deliberate tap does.
    if ((loading && !force) || !videoRef.current || !cameraActive) return;

    setLoading(true);
    const scanId = ++currentScanId.current;
    setScanMatches([]);
    setScanStatus('Initializing scanner...');

    const video = videoRef.current;
    
    const guideElement = document.querySelector('.scan-card-guide');
    if (!guideElement) {
      setLoading(false);
      setScanStatus('Error: Guide box overlay not found.');
      return;
    }

    // 1. Capture and correctly orient the frame onto a canvas.
    //
    // ORDER MATTERS: the sharpness gate runs on the CHEAP video frame, and the
    // still-photo shutter only fires once that gate has passed.
    //
    // takePhoto() costs a real shutter (~0.3-1s on iOS). Auto-scan ticks every
    // SCAN_COOLDOWN_MS and DELIBERATELY discards blurred frames, so taking a
    // still before the gate would pay that shutter on every rejected tick —
    // turning a fast reject into a slow one and making the scanner feel worse
    // than before precisely when conditions are poor. Gating first means the
    // expensive capture happens only for frames that were going to be uploaded.
    const previewCanvas = getOrientedVideoCanvas(video);

    // Map the dashed guide box's rendered rect into oriented-canvas pixels through
    // the preview's object-fit:cover transform, then pad it: the box is an aim
    // hint, but a card can overhang it, so crop wider so a frame-filling card
    // isn't clipped. Server auto-detects/deskews the card inside this region.
    //
    // Factored into a helper because it now runs TWICE: once on the preview
    // frame to score sharpness, then again on the still. `k` derives from
    // oc.width/oc.height, so a larger source canvas rescales the mapping
    // automatically and BOTH calls crop the same region of the scene.
    // MARGIN AROUND THE CARD IS NOT COSMETIC — THE DETECTOR NEEDS IT.
    //
    // Zach: "mana box auto outlines the card I think we need something like that
    // so we get the whole card including the border." Exactly right, and it is
    // the mechanism: detectCard finds the card by locating its BORDER against
    // the surface behind it. If the crop starts at the card's edge there is no
    // border in the image, so there is nothing to detect.
    //
    // MEASURED through the real /api/scan-match route, on real card art,
    // varying ONLY the margin around the card:
    //
    //   margin  0%   1/8 collector numbers   (one card failed to detect at all)
    //   margin  4%   2/8                     (three failed to detect)
    //   margin  6%   8/8                     <- clean
    //   margin 10%   8/8
    //
    // No code change in that sweep. The detector was never short — it was being
    // handed images with no visible card edge, and it did the only sensible
    // thing. Three earlier attempts to "correct" the quad were fixing a bug that
    // did not exist.
    //
    // WHY THIS GOT WORSE RECENTLY. The old value was 0.05, but it padded the
    // GUIDE BOX, not the card — and the guide box is an aim hint the card sits
    // inside, so margin was incidental. Every capture improvement that got the
    // card filling more of the frame (fullscreen preview, full-resolution
    // request, ImageCapture stills) squeezed that accidental margin toward zero.
    // Better photographs, worse detection.
    //
    // 0.14 is deliberately past the 6% knee. The guide box is card-shaped and
    // the card can OVERHANG it, so the pad must cover both the detector's need
    // and the overhang; and the sweep is flat from 6% to 10%, so overshooting
    // costs a little background while undershooting costs the whole scan.
    const CROP_PAD = 0.14;
    const videoRect = video.getBoundingClientRect();
    const guideRect = guideElement.getBoundingClientRect();
    const cropGuideRegion = (oc) => {
      // Cover-transform mapping from displayed video px to oriented-canvas px
      // (matches object-fit:cover on the preview; overflow crop offsets handled below).
      const k = Math.max(videoRect.width / oc.width, videoRect.height / oc.height);
      const offX = (videoRect.width - oc.width * k) / 2;
      const offY = (videoRect.height - oc.height * k) / 2;
      // Box center (rotation is about the element center, so the rotated AABB
      // center from getBoundingClientRect is still the true center) and unrotated
      // size (offsetWidth/Height ignore the CSS transform).
      const cx = ((guideRect.left + guideRect.width / 2) - videoRect.left - offX) / k;
      const cy = ((guideRect.top + guideRect.height / 2) - videoRect.top - offY) / k;
      // offsetWidth/Height are the unscaled layout size; the CSS scale transform
      // doesn't change them, so fold guideScale in here.
      const destW = Math.max(1, Math.round((guideElement.offsetWidth * guideScale / k) * (1 + 2 * CROP_PAD)));
      const destH = Math.max(1, Math.round((guideElement.offsetHeight * guideScale / k) * (1 + 2 * CROP_PAD)));
      const rad = (guideAngle * Math.PI) / 180;
      const out = document.createElement('canvas');
      out.width = destW;
      out.height = destH;
      const c = out.getContext('2d');
      // Sample the (possibly rotated, off-center) box region upright: dest center
      // maps to the box center, undo the box rotation, draw the frame. Pixels past
      // the box (pad / frame overhang) come through black; server auto-detects the card.
      c.translate(destW / 2, destH / 2);
      c.rotate(-rad);
      c.translate(-cx, -cy);
      c.drawImage(oc, 0, 0);
      return out;
    };
    let framedCanvas = cropGuideRegion(previewCanvas);

    // CROP TO THE DETECTED CARD WHEN WE HAVE ONE.
    //
    // This is the fix for Zach's white box. Cropping to the static guide box
    // hands the server a frame that is ~72% container — box corners, walls and
    // shadowed interior — and the server's own detectCard then picks the BOX,
    // because the box interior is a bigger, equally rectangular, equally centred
    // candidate than the card. His four failed basic lands came back with
    // matched_name = '': never identified at all.
    //
    // The live detector has already found the card by SHAPE and INTERIOR DETAIL,
    // which a flat container floor fails. Cropping to that detection (plus a
    // margin, so the card's own border is still visible for the server to
    // deskew against) removes the container from the picture entirely.
    //
    // ONLY WHEN LOCKED. A low-confidence detection is a guess, and cropping to a
    // guess would throw away a card that the guide-box path would have caught.
    // Unlocked falls through to the existing behaviour — strictly no worse than
    // today.
    if (isLocked(liveDetectRef.current)) {
      const d = liveDetectRef.current;
      const vw = previewCanvas.width, vh = previewCanvas.height;
      // The detection is in preview-element pixels; convert back to canvas
      // pixels using the same object-fit: cover mapping the overlay used.
      const vr = video.getBoundingClientRect();
      const s = Math.max(vr.width / vw, vr.height / vh);
      const ox = (vr.width - vw * s) / 2;
      const oy = (vr.height - vh * s) / 2;
      // Margin around the CARD (not the guide box) so the border survives —
      // this is what CROP_PAD was always trying to achieve.
      const pad = 0.10;
      const cw = (d.w / s) * (1 + 2 * pad);
      const ch = (d.h / s) * (1 + 2 * pad);
      const cxd = (d.x - ox) / s - (d.w / s) * pad;
      const cyd = (d.y - oy) / s - (d.h / s) * pad;
      // Clamp inside the frame: a card near the edge would otherwise sample
      // outside the canvas and come through black.
      const sx = Math.max(0, Math.min(vw - 1, Math.round(cxd)));
      const sy = Math.max(0, Math.min(vh - 1, Math.round(cyd)));
      const sw = Math.max(1, Math.min(vw - sx, Math.round(cw)));
      const sh = Math.max(1, Math.min(vh - sy, Math.round(ch)));
      const out = document.createElement('canvas');
      out.width = sw; out.height = sh;
      out.getContext('2d').drawImage(previewCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
      framedCanvas = out;
    }

    // --- BUG 2: THE SHARPNESS GATE ------------------------------------------
    //
    // AUTO-CAPTURE ONLY. A manual tap is Zach explicitly asking for a scan, and
    // the app must never answer that with silence — `auto` is false on that
    // path, so the whole block is skipped and a button press ALWAYS captures.
    //
    // Placed HERE, on the cropped frame, not the full video frame. The crop is
    // the region that actually gets uploaded and OCR'd, so it is the region
    // whose sharpness decides whether the collector number is readable. Scoring
    // the whole frame would let a sharp background rescue a blurred card.
    //
    // Scored on a small downscaled copy (~160px wide): the metric is a ratio of
    // edge energy, so it does not need full resolution, and the downscale keeps
    // the check at a fraction of a millisecond.
    if (auto) {
      let decision = { capture: true, reason: 'unmeasured', score: null, baseline: null };
      try {
        const gate = document.createElement('canvas');
        const gs = Math.min(1, 160 / framedCanvas.width);
        gate.width = Math.max(3, Math.round(framedCanvas.width * gs));
        gate.height = Math.max(3, Math.round(framedCanvas.height * gs));
        const gctx = gate.getContext('2d', { willReadFrequently: true });
        gctx.drawImage(framedCanvas, 0, 0, gate.width, gate.height);
        const px = gctx.getImageData(0, 0, gate.width, gate.height);
        const score = laplacianVarianceScore(px.data, gate.width, gate.height);
        decision = decideCapture(score, sharpnessRef.current);
        sharpnessRef.current = decision.state;
      } catch {
        // getImageData can throw on a tainted canvas, and a browser that
        // refuses to give us pixels must not disable scanning. FAIL OPEN: an
        // ungated capture is the old behaviour, which is merely imperfect; a
        // gate that swallows every frame would silently stop auto-scan, and a
        // card missing from a scanned stack is the failure this app cannot
        // afford.
        decision = { capture: true, reason: 'gate-unavailable', score: null, baseline: null };
      }

      // RECORD THE OBSERVED NUMBERS. See gateLogRef: BUG 2 was an unvalidated
      // threshold that only a real phone could disprove, and it cost a release
      // to find. Whatever happens next, the numbers are visible.
      gateLogRef.current = [
        ...gateLogRef.current,
        {
          t: Date.now(),
          score: decision.score == null ? null : Math.round(decision.score * 100) / 100,
          baseline: decision.baseline == null ? null : Math.round(decision.baseline * 100) / 100,
          reason: decision.reason,
          captured: decision.capture,
        },
      ].slice(-12);

      if (!decision.capture) {
        // Skip WITHOUT signalling. No click, no flash, no vibrate: from Zach's
        // side nothing happened, the card is still in frame, and the next tick
        // comes around quickly. Dropping `loading` back to false is what
        // reschedules it — the capture effect keys on `loading`.
        //
        // Marked 'rejected' so the scheduler retries in SCAN_RETRY_REJECTED_MS
        // rather than the full settle pause: nothing was captured and no server
        // call was made, so there is nothing to pace. Waiting the long cooldown
        // here meant a card that steadied instantly still sat out three seconds.
        lastTickOutcomeRef.current = 'rejected';
        setScanStatus(t('scan.holdSteady'));
        setLoading(false);
        return;
      }
      // Clear a lingering "hold steady" so the status line reflects the scan
      // that is actually now running.
      setScanStatus('');
      // Sync the display mirror. Only on a capture: a render is happening here
      // regardless, so this adds no extra re-render to the tick loop.
      setGateLog(gateLogRef.current);
    }

    // THE GATE HAS PASSED (or this is a manual tap). Only now pay for the real
    // shutter.
    //
    // ImageCapture.takePhoto() routes through AVCapturePhotoOutput — Apple's
    // still pipeline, with the multi-frame processing the native Camera app
    // uses — rather than a frame off the realtime preview, which iOS
    // deliberately keeps cheap (no Smart HDR, no Deep Fusion). That is the gap
    // Zach measured: identical setup, ManaBox clear, ours soft, because a
    // native app previews the processed feed and a web page cannot.
    //
    // takeStillPhoto returns null for every unsuitable case — no ImageCapture
    // (iOS < 18.4), a rejected or timed-out shutter, or a photo whose aspect
    // ratio does not match the preview. Null keeps the already-computed preview
    // crop, which is exactly the pre-existing behaviour, so this can only add
    // quality and never remove the ability to scan.
    const still = await takeStillPhoto(video);
    if (still) {
      framedCanvas = cropGuideRegion(getOrientedVideoCanvas(video, 0, still));
      // ImageBitmaps hold decoded pixels outside the JS heap; on a bulk scan
      // these add up fast, so release it as soon as it has been drawn.
      still.close?.();
    }
    setCaptureSource(still ? 'photo' : 'video');

    // Past the gate: a real scan is now running. Default the tick outcome to
    // 'settle' so the scheduler paces the next attempt for a physical card
    // swap. The catch below overrides this to 'error' if the scan throws.
    lastTickOutcomeRef.current = 'settle';

    // Picture is now taken — fire the instant cue (click + vibrate + flash) so
    // the user can move the card immediately, before the server lookup runs.
    signal('capture');

    try {
      // Identify by image (server-side). Send the WHOLE oriented frame (downscaled)
      // so the server can auto-detect + deskew the card before matching — the guide
      // box is just an aim hint.
      {
        setScanStatus('Matching card image...');
        {
          // Downscale the frame for upload; server auto-crops the card. Keep it
          // fairly high-res so a far/small card still has enough pixels to match.
          //
          // SCAN_UPLOAD_W is 2000 and this is the line that makes it matter. It
          // was a no-op at the old ~660px crop; with the fullscreen preview and
          // the full-resolution capture request the crop is larger than the cap,
          // so this is now a REAL downscale and the constant above is the thing
          // deciding how many pixels reach the collector-number strip.
          const up = document.createElement('canvas');
          const s = Math.min(1, SCAN_UPLOAD_W / framedCanvas.width);
          up.width = Math.round(framedCanvas.width * s);
          up.height = Math.round(framedCanvas.height * s);
          up.getContext('2d').drawImage(framedCanvas, 0, 0, up.width, up.height);
          const imageData = up.toDataURL('image/jpeg', SCAN_UPLOAD_Q);
          // WHAT WE ACTUALLY SENT, for the diagnostics panel. The crop width
          // before the cap is the number that says whether the resolution work
          // reached this point at all: if it reads ~660 on his phone, the camera
          // request or the fullscreen layout did not take effect and the upload
          // cap is irrelevant. KB is the Tailscale cost, measured rather than
          // predicted. Base64 is ~4/3 of the bytes, so that factor is removed.
          setUploadInfo({
            cropW: framedCanvas.width,
            sentW: up.width,
            kb: Math.round((imageData.length - imageData.indexOf(',') - 1) * 0.75 / 1024),
          });
          setDebugHashImg(imageData);
          try {
            const resp = await fetch('/api/scan-match', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // ocr: true is what connects PR 8's collector-number pipeline to
              // the app. The server GATES OCR behind this flag, so without it
              // the whole pipeline — reader, parser, resolver, queue — was built
              // and tested but never once ran from the scanner, and every scan
              // fell back to guessing the printing from whichever unique_artwork
              // entry matched. That is the bug PR 9 exists to fix.
              body: JSON.stringify({ game: 'mtg', image: imageData, set: scanSetParam, lang: 'en', recallK: SCAN_RECALL_K, orb: SCAN_ORB, ocr: true }),
            });
            if (scanId !== currentScanId.current) return;
            if (resp.ok) {
              const { game: matchGame, verified, candidates, crop, scoped, englishOnly, ocr } = await resp.json();

              console.log('Scan candidates:', matchGame, scoped ? `(set-scoped ${scanSetParam})` : '(GLOBAL)', verified ? 'ORB' : 'CLIP', candidates);
              if (crop) setDebugHashImg(crop); // show the server's auto-cropped card
              setDebugScoped(scoped ? scanSetParam : false);
              setDebugCandidates((candidates || []).map(c => ({ ...c, verified })));
              // The whole-game indexes only exist in English, so a non-English scan
              // needs a set selected (its index builds on demand). Say that plainly
              // instead of leaving the user re-scanning a card that cannot match.
              if (englishOnly) {
                setScanStatus('Select a set before scanning this card.');
                return;
              }
              const top = candidates && candidates[0];
              const confident = top && (verified ? top.inliers >= SCAN_MATCH_MIN_INLIERS : top.score >= SCAN_MATCH_MIN_SCORE);
              // Printing ambiguity: basic lands (and other low-art cards) share one
              // big symbol + frame, so ORB scores nearly tie across every printing
              // of the same card. A near-tied same-name runner-up means the image
              // can't tell the printings apart — so DON'T auto-add the top pick's
              // set; fall through to the picker and let the user choose the set.
              const second = candidates && candidates[1];
              const ambiguousPrinting = top && second && top.name === second.name
                && (top.set !== second.set || top.number !== second.number)
                && (verified ? second.inliers >= top.inliers * 0.7 : second.score >= top.score - 0.02);
              if (candidates && candidates.length > 0) {
                // --- PR 9: the add-or-queue decision ------------------------
                //
                // AUTO-SCAN ONLY, and that boundary is deliberate. Auto-scan is
                // the stack workflow: Zach holds a pile and the app must never
                // stop to ask, so an unresolved card goes to the server-side
                // review queue and scanning continues. A MANUAL tap is already
                // an explicit, one-card-at-a-time interaction, so the existing
                // picker below stays exactly as it is for that path — showing
                // him a picker he asked for is not an interruption.
                //
                // THE SERVER MAKES THE DECISION, NOT THIS CODE. /scan-resolve
                // adds only when the OCR read narrows the catalogue to exactly
                // one printing; everything else queues. Nothing here inspects
                // the OCR read to second-guess that, because the catalogue is
                // the validator and this component is not.
                // PR 11: A CONFIDENT CLIP MATCH IS NO LONGER REQUIRED TO
                // SUBMIT, and this gate was the real single point of failure.
                //
                // `confident` is a threshold on the ARTWORK match. On Zach's
                // glared Fated Firepower the top candidate was noise (9 inliers,
                // wrong card), so this gate returned early and the scan was
                // never sent — even though the title and collector number were
                // both plainly legible in the very same photo. The backend
                // could not rescue a request it never received.
                //
                // So the condition is now "we have SOMETHING to identify with":
                // a confident CLIP name, or an OCR'd title. The server still
                // makes the whole decision and still adds only when the
                // catalogue narrows to exactly one printing — this widens what
                // gets ASKED, not what gets added.
                const titleText = (ocr?.title || '').trim();
                const clipName = confident && top?.name ? top.name : '';
                // THE PRINTING THE ARTWORK ACTUALLY MATCHED.
                //
                // The scan index is built per ARTWORK, so a confident match does
                // not merely name the card — it names one specific printing
                // (top.set + top.number). That was computed and then thrown
                // away: only `name` was sent, so the server re-looked-up EVERY
                // printing of that name, found several, and queued as
                // 'ambiguous'. Zach's stack shows the cost — 'The Legend of
                // Roku' (tla 357) and 'Dai Li Agents' (tla 214) are ALT ARTS
                // with artwork unique to one printing, and both were queued
                // asking him a question the matcher had already answered.
                //
                // Only sent when the image can actually tell the printings
                // apart. `ambiguousPrinting` (computed above) flags the case
                // where a same-name runner-up scores nearly as well — basic
                // lands and other low-art cards, where every printing shares one
                // frame and ORB near-ties across all of them. In that case the
                // artwork genuinely does NOT identify the printing, so the hint
                // is withheld and the collector number / the queue decides, as
                // before.
                //
                // This is a HINT, not an instruction: the server validates it
                // against the catalogue and ignores it if it does not resolve to
                // exactly one real printing. Nothing is added on the strength of
                // the client's say-so.
                // THE SET IS SENT EVEN WHEN THE PRINTING IS AMBIGUOUS.
                //
                // Zach: "ManaBox had no issues with basic lands", and his stack
                // kept queueing Forests the matcher had already identified.
                //
                // MEASURED on 22 basic lands from his real scans: the matcher got
                // the card right EVERY TIME (Forest->Forest, Plains->Plains,
                // Mountain->Mountain, 0 misidentified) and OCR read the number
                // reliably -- Forest #295 seven times, Plains #288 five times,
                // Mountain #293 three times, the same answer on every repeat.
                // The ONLY unreliable signal was the OCR'd SET CODE: 'rvryg',
                // 'nard', 'rrr', 'ere', 'mshen', null.
                //
                // The old condition withheld the hint whenever `ambiguousPrinting`
                // was true -- which is ALWAYS true for a basic land, because every
                // printing of a Forest shares the art and ties on inliers. So on
                // exactly the cards that were failing, we threw away the set we
                // already knew and left the resolver holding a garbage one.
                //
                // TWO DIFFERENT QUESTIONS WERE BEING CONFLATED:
                //   which CARD     -- Forest, in msh. The matcher knows this.
                //   which PRINTING -- #295 or #296. The art genuinely cannot say.
                // Ambiguity about the second is not a reason to discard the first.
                //
                // So the SET always goes, and the NUMBER only goes when the image
                // could actually tell the printings apart. The collector number --
                // the signal that IS reliable -- then picks within the set. Still
                // a HINT: the server validates against the catalogue and ignores
                // it unless it resolves to exactly one real printing, so nothing
                // is added on the client's say-so and a wrong guess still queues.
                // THE MATCHER'S SET IS ONLY TRUSTED WHEN THE MATCH IS REAL.
                //
                // WHAT INLIERS ARE: the number of feature points from the photo
                // that agree with a single geometric transform onto the reference
                // image. High means many landmarks genuinely line up; low means a
                // handful agreed by coincidence and the matcher is picking the
                // least-bad row rather than recognising anything.
                //
                // MEASURED on Zach's stack, where sending the set unconditionally
                // put WRONG CARDS into staging:
                //     Plains              inliers 52, 70   -> correct
                //     Forest              inliers 9-15      -> staged as pal03 #5
                //     Blightstep Pathway  inliers 12        -> not a land at all
                // The separation is clean and it is not close. Below ~20 every
                // result was wrong; above it every result was right.
                //
                // Basic lands are the hard case for a reason: a Forest is smooth
                // artwork with very few distinctive corners, so there are barely
                // any feature points to match and the score stays near the noise
                // floor even for the correct card. That is exactly when the set
                // must NOT be taken on trust.
                //
                // Sending the set regardless is what turned "queues annoyingly"
                // into "silently files a Forest as Arena League 2003". A queued
                // card costs a tap; a wrong card in the collection cannot be
                // reconciled against the physical stack.
                const MIN_TRUSTED_INLIERS = 20;
                const matchInliers = Number.isFinite(top?.inliers) ? top.inliers : null;
                const matchIsTrusted = matchInliers != null && matchInliers >= MIN_TRUSTED_INLIERS;
                const printingHint = (clipName && top?.set && matchIsTrusted)
                  ? {
                    set: String(top.set),
                    number: (!ambiguousPrinting && top?.number) ? String(top.number) : null,
                  }
                  : null;
                if (autoScan && (clipName || titleText)) {
                  // The dedup key must survive CLIP being wrong, so it keys on
                  // whichever identifier we actually have. Without this a stack
                  // of glared cards with no CLIP name would all share the key ''
                  // and every card after the first would be silently skipped.
                  const identified = clipName || titleText;
                  if (identified === lastQueuedNameRef.current) {
                    setScanStatus(t('scan.sameCardAgain'));
                    return;
                  }
                  setScanStatus('');
                  const outcome = await reviewQueue.submitScan({
                    // HOW STRONG THE MATCH WAS. The staging row stores this and
                    // the low_confidence flag keys on it -- a flag that has never
                    // once fired, because this value was never sent. Every wrong
                    // card in Zach's session (Forest as pal03 #5, Blightstep
                    // Pathway as a land) scored 9-15 while the one correct land
                    // scored 52-70, so the signal that would have caught all of
                    // them was sitting in the response, unused.
                    matchInliers,
                    name: clipName,
                    // The OCR'd TITLE. The server fuzzy-matches it against the
                    // catalogue and prefers it over the CLIP name — the title
                    // survives a torch highlight, the artwork does not.
                    titleText,
                    // The RAW OCR text, not a parsed number. The server owns the
                    // parse (collectorNumberParse.js) and re-parsing it here
                    // would be a second, divergent implementation of the one
                    // rule that keeps a misread from becoming a wrong card.
                    ocrText: ocr?.raw || '',
                    // STAGE, DO NOT ADD. Zach reviews the whole session and
                    // presses Add All; nothing reaches the collection before
                    // that. The resolution rules are unchanged — only the
                    // destination moves.
                    stage: true,
                    // So the server can flag a weak match as worth a look.
                    match_inliers: Number.isFinite(top?.inliers) ? top.inliers : null,
                    // WHICH PRINTING the artwork matched, when the artwork can
                    // tell them apart. See printingHint above. The server
                    // validates it against the catalogue before trusting it.
                    printingHint,
                    // The server's rectified crop, so the queue shows the card
                    // he actually photographed rather than a catalogue image.
                    crop: crop || null,
                    quantity: 1,
                  });
                  if (scanId !== currentScanId.current) return;

                  if (outcome.action === 'staged') {
                    // RESOLVED, BUT NOT OWNED. It waits in the session until he
                    // presses Add All. The badge moves; the collection does not.
                    //
                    // No countdown and no cancel modal on this path: staging is
                    // already the undo. Interrupting every scan to confirm a
                    // reversible action would be the slowness he asked me to fix.
                    // THE BADGE MOVES WITHOUT RE-READING THE LIST.
                    //
                    // This used to call staging.refresh(), which pulled EVERY
                    // staged row and its thumbnail back over Tailscale after
                    // every single scan — a second round trip that grows with
                    // the stack, so scan sixty was slower than scan two. The
                    // list itself is only looked at when the review screen
                    // opens, and it re-reads on mount.
                    //
                    // noteStaged bumps the counter from what the server already
                    // told us in THIS response, so the badge stays honest for
                    // free. It is not a local guess: the row exists because the
                    // server said 'staged'.
                    staging.noteStaged(outcome.flag);
                    setRecentScans(prev => [{
                      ...outcome.card, card_id: outcome.card?.id, entry_id: null,
                      quantity: 1, condition: 'Near Mint', printing: 'nonfoil', location_id: null,
                      staged: true,
                    }, ...prev].slice(0, 10));
                    showToast(outcome.flag
                      ? t('scan.stagedFlaggedToast', { name: outcome.card?.name || identified })
                      : t('scan.stagedToast', { name: outcome.card?.name || identified }));
                    signal('success');
                  } else if (outcome.action === 'added') {
                    lastAddedIdRef.current = outcome.card?.id;
                    setRecentScans(prev => [{
                      ...outcome.card, card_id: outcome.card?.id, entry_id: outcome.entry_id,
                      quantity: 1, condition: 'Near Mint', printing: 'nonfoil', location_id: null,
                    }, ...prev].slice(0, 10));
                    showToast(t('scan.autoAdded', {
                      qty: '', name: outcome.card?.name || identified, set: outcome.card?.set_name || '',
                    }));
                    signal('success');
                    if (onAddSuccess) onAddSuccess();
                  } else if (outcome.action === 'queued') {
                    // NOT added to the collection. The badge moves; the
                    // collection does not. No modal, by design — he reviews the
                    // whole queue when the stack is done.
                    setScanStatus(t('scan.queuedForReview', { name: identified }));
                    showToast(t('scan.queuedToast', { name: identified }));
                    signal('capture');
                  } else {
                    setScanStatus(outcome.error || t('scan.unknownError'));
                    signal('error');
                  }
                  // Guard only on a DECIDED outcome. An error (a dropped request
                  // mid-stack) must stay retryable: setting the guard here would
                  // make the app quietly ignore that card until Zach noticed it
                  // never appeared, and a card silently missing from a scanned
                  // stack is exactly the failure this app cannot afford.
                  if (outcome.action !== 'error') lastQueuedNameRef.current = identified;
                  setScanMatches([]);
                  return;
                }

                if (confident && !ambiguousPrinting) {
                  // Instant path: if scan-match pre-hydrated the card from local card_cache,
                  // apply it directly without waiting for a second /api/search HTTP round-trip!
                  if (top.card) {
                    await applyMatches([top.card], '', true, top.inliers);
                    return;
                  }

                  // Uses the DETECTED game (auto-detect may override the UI mode).
                  // Query the MATCHED card's exact set + number (top.set/top.number),
                  // not just its name — otherwise search returns some other printing
                  // of the same name instead of the card ORB actually identified.
                  // `lang` keeps the lookup on the printing that was scanned: the
                  // matched name may itself be localized (稲妻), and the English row
                  // for the same set+number is a different card.
                  const exact = new URLSearchParams({ game: matchGame, lang: 'en' });
                  if (top.name) exact.append('name', top.name);
                  if (top.set) exact.append('set', top.set);
                  if (top.number) exact.append('number', top.number);
                  let searchResponse = await fetch(`/api/search?${exact.toString()}`);
                  if (scanId !== currentScanId.current) return;
                  let matches = searchResponse.ok ? await searchResponse.json() : [];
                  // Fallback: exact set/number isn't cached/known — offer all
                  // printings by name so the user can still pick.
                  if (matches.length === 0) {
                    const byName = new URLSearchParams({ game: matchGame, lang: 'en', prints: '1' });
                    if (top.name) byName.append('name', top.name);
                    searchResponse = await fetch(`/api/search?${byName.toString()}`);
                    if (scanId !== currentScanId.current) return;
                    matches = searchResponse.ok ? await searchResponse.json() : [];
                  }
                  // Confident image match on an exact set+number is unambiguous, so
                  // take the fast path (single result auto-adds).
                  if (matches.length) { await applyMatches(matches, '', true); return; }
                }

                // If not confident (or multiple printings), check if candidates are pre-hydrated
                const preHydrated = candidates.slice(0, 8).map(c => c.card).filter(Boolean);
                if (preHydrated.length === candidates.slice(0, 8).length) {
                  await applyMatches(preHydrated, 'No matching cards found.');
                  return;
                }

                // Fallback: fetch full card info for candidates and show the picker.
                setScanStatus('Fetching candidate cards...');
                const fullCandidates = await Promise.all(
                  candidates.slice(0, 8).map(async cand => {
                    if (cand.card) return cand.card;
                    const p = new URLSearchParams({ game: matchGame, lang: 'en' });
                    if (cand.set) p.append('set', cand.set);
                    if (cand.number) p.append('number', cand.number);
                    if (cand.name) p.append('name', cand.name);
                    const res = await fetch(`/api/search?${p.toString()}`);
                    if (res.ok) {
                      const m = await res.json();
                      return m[0]; // Take the closest printing
                    }
                    return null;
                  })
                );
                
                if (scanId !== currentScanId.current) return;
                const validCandidates = fullCandidates.filter(c => c);
                if (validCandidates.length > 0) {
                  await applyMatches(validCandidates, '', false);
                  return;
                }
              }
            }
          } catch (e) { console.warn('scan-match request failed:', e); }
        }
      }

      setScanStatus('No confident match. Try again or search manually.');
      // Frame no longer shows a recognizable card — clear the skip guard so the
      // resolved-duplicate card isn't skipped forever once re-presented.
      resolvedDupIdRef.current = null;
      // Same reasoning for the queue guard: once the card has left the frame, a
      // genuine SECOND physical copy of it must be scannable again. Without
      // this, scanning two real copies of the same card in one stack would
      // silently record only the first.
      lastQueuedNameRef.current = null;
      signal('error');
    } catch (err) {
      console.error('Scan match failed:', err);
      // A thrown scan backs off further — see SCAN_RETRY_ERROR_MS. Retrying
      // hard against a failing server makes it worse, and the cause (a dropped
      // request, a restart) rarely clears inside one fast tick.
      lastTickOutcomeRef.current = 'error';
      if (scanId === currentScanId.current) setScanStatus('Scan failed. Please search manually.');
    } finally {
      // ALWAYS CLEAR `loading`, EVEN FOR A SUPERSEDED SCAN.
      //
      // Zach: "it stopped scanning eventually and tapping didn't get it to scan
      // again". This is why. `loading` gates BOTH auto-scan and the tap
      // override (handleCapture's first line returns immediately when it is
      // true), so if it is ever left stuck the scanner is dead until the camera
      // is restarted -- and no amount of tapping recovers it.
      //
      // The guard used to be `if (scanId === currentScanId.current)`, which
      // skips the reset whenever this scan was superseded: a cancel, or a new
      // capture starting, bumps currentScanId. The NEW scan then owns `loading`
      // and clears it on its own path -- but if that newer scan returned early
      // (a stale-id check, an englishOnly bail, a missing guide element), the
      // flag was never cleared by anyone. Terminal, and exactly the symptom he
      // hit: works for a while, then stops forever.
      //
      // Clearing unconditionally is safe. A superseded scan setting `loading`
      // to false at worst lets one extra capture start a moment early, which
      // the stability gate then has to approve anyway. A stuck `true` is
      // unrecoverable. Prefer the recoverable failure.
      setLoading(false);
      // The STATUS text still belongs to the newest scan only, so a stale scan
      // cannot overwrite what the current one is saying.
    }
  };
  // Keep the ref pointing at the latest handleCapture so timers (metronome /
  // cooldown) always invoke the current closure, never a stale one.
  handleCaptureRef.current = handleCapture;
  // Metronome reads this (not effect deps) to decide whether to fire a capture,
  // so a modal/picker/drawer pauses the beat without restarting the interval.
  captureBlockedRef.current = isDrawerOpen || scanMatches.length > 0 || !!autoAddTargetCard || !!dupConfirmCard;
  loadingRef.current = loading;

  const openQuickAdd = (card) => {
    setScanMatches([]);
    setSelectedCard(card);
    setPurchasePrice(0);
    // Nonfoil default; no rarity-based guessing. See CardSearch.jsx for why:
    // MTG rarity carries no finish information, so the old holo/secret/ultra
    // heuristic mislabeled physical cards at random.
    setPrinting('nonfoil');

    setIsDrawerOpen(true);
  };

  const closeDrawer = () => {
    setIsDrawerOpen(false);
    setSelectedCard(null);
    setScanMatches([]);
    setQuantity(1);
    setCondition('Near Mint');
    setPrinting('nonfoil');

    setPurchasePrice(0);
    // Restart camera on close only if stream was stopped
    if (!stream || !cameraActive) {
      startCamera();
    }
  };

  const removeRecentTile = (entryId) => setRecentScans(prev => prev.filter(s => s.entry_id !== entryId));
  // Tap: open the inspector, unless a long-press just armed selection or we're
  // already selecting (then toggle). Long-press + bulk actions come from the hook.
  const activateRecent = (item) => {
    if (recentSelect.longPressFired.current) { recentSelect.longPressFired.current = false; return; }
    if (recentSelect.selectMode) recentSelect.toggleSelect(item.entry_id);
    else setInspectorEntry(item);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedCard) return;

    try {
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: selectedCard.id,
          quantity: parseInt(quantity, 10),
          condition,
          printing,
          purchase_price: parseFloat(purchasePrice) || 0,
          location_id: null
        })
      });

      if (response.ok) {
        const data = await response.json();
        const placementLabel = data.placement?.label || null;
        if (placementLabel) {
          showToast(t('scan.addedToPlain', { name: selectedCard.name, place: placementLabel }));
        } else if (data.container_full) {
          showToast(t('scan.addedFullPlain', { name: selectedCard.name }));
        } else {
          showToast(t('search.addedToCollection', { name: selectedCard.name }));
        }

        // Append to recent scans history. Carry entry_id + saved fields so the
        // strip supports tap-to-edit / long-press-delete like the auto-add path.
        setRecentScans(prev => [{
          ...selectedCard, card_id: selectedCard.id, placementLabel, entry_id: data.id,
          quantity: parseInt(quantity, 10), condition, printing,
          purchase_price: parseFloat(purchasePrice) || 0, location_id: null,
        }, ...prev].slice(0, 10));

        const rarity = (selectedCard.rarity || '').toLowerCase();
        const price = selectedCard.price_trend || 0;
        if (rarity.includes('holo') || rarity.includes('secret') || rarity.includes('ultra') || price > 10) {
          confetti({
            particleCount: 150,
            spread: 80,
            origin: { y: 0.6 }
          });
        }

        onAddSuccess();
        closeDrawer();
      } else {
        showToast(t('search.errAddCard'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('scan.errSaveCard'));
    }
  };

  return (
    <div className="scanner-container">



      {/* Camera Window */}
      {!cameraActive ? (
        <div 
          className="camera-preview-wrapper" 
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          onClick={startCamera}
        >
          {cameraErrorKey ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <AlertTriangle size={48} style={{ color: 'var(--accent-yellow)', marginBottom: '1rem' }} />
              <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                {t(cameraErrorKey, { origin: window.location.origin, port: window.location.port || '80' })}
              </p>
              <button className="btn btn-primary" onClick={startCamera}>
                <RefreshCw size={14} /> Retry Camera
              </button>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <Camera size={48} style={{ color: 'var(--accent-red)', marginBottom: '1rem', opacity: 0.8 }} />
              <p style={{ fontSize: '0.95rem', color: 'var(--text-primary)', marginBottom: '0.5rem' }}>{t('scan.readyTitle')}</p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>{t('scan.readyHint')}</p>
              <button className="btn btn-primary">
                {t('scan.activateCamera')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div className={`camera-preview-wrapper camera-active${fullscreenScan ? ' camera-fullscreen' : ''}`}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="camera-video"
            />

            {/* Fullscreen toggle. Fullscreen is the DEFAULT on phones because it
                is what puts pixels on the card (see .camera-fullscreen in
                index.css), but it must be escapable: the boxed layout is the
                production look and the only way to see the rest of the page. */}
            <button
              type="button"
              className="btn btn-secondary"
              aria-label={t(fullscreenScan ? 'scan.exitFullscreen' : 'scan.enterFullscreen')}
              title={t(fullscreenScan ? 'scan.exitFullscreen' : 'scan.enterFullscreen')}
              style={{
                position: 'absolute',
                top: `calc(1rem + ${fullscreenScan ? 'env(safe-area-inset-top)' : '0px'})`,
                left: '1rem',
                zIndex: 20,
                borderRadius: '50%',
                padding: '0.6rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
              }}
              onClick={(e) => { e.stopPropagation(); setFullscreenScan((v) => !v); }}
            >
              {fullscreenScan ? <Minimize size={18} /> : <Maximize size={18} />}
            </button>

            {/* Torch Toggle Overlay Button */}
            <button
                type="button"
                className={`btn ${isTorchOn ? 'btn-primary' : 'btn-secondary'}`}
                style={{
                  position: 'absolute',
                  top: `calc(1rem + ${fullscreenScan ? 'env(safe-area-inset-top)' : '0px'})`,
                  right: '1rem',
                  zIndex: 20,
                  borderRadius: '50%',
                  padding: '0.6rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
                }}
                onClick={(e) => { e.stopPropagation(); toggleTorch(); }}
              >
                {isTorchOn ? <Zap size={18} /> : <ZapOff size={18} />}
              </button>

            {/* IN-FRAME STATUS. Fullscreen made the existing status line (far
                below the camera, ~line 1940) unreachable: the preview covers the
                viewport, so every message the scanner produced — "Matching card
                image…", "Hold steady", the queued/added result — was rendered
                off-screen. Zach's report was that fullscreen looked better but
                it was "hard to see what it's doing", which is exactly this.

                So the SAME scanStatus string is mirrored INSIDE the frame while
                fullscreen is on. Not a new message set and not a second source
                of truth: one state, shown where the user is actually looking.
                Only rendered in fullscreen, so the boxed desktop layout keeps
                its production appearance and does not get a duplicate line. */}
            {/* TAP TO FORCE A SCAN. Zach: "if it doesnt scan that card we can
                have a tap feature that will force scanning".

                Built now rather than later because it is the escape hatch for
                the one measured risk in stability gating: two different cards
                resting in the same spot produce detections with IoU 0.98-1.00,
                so re-arming depends on the live loop SEEING the drop. If that
                assumption fails on his phone, this is the difference between
                "occasionally tap" and "the scanner is broken again".

                Deliberately bypasses the stability gate but NOT the sharpness
                gate: forcing a blurred frame would trade a missed card for a
                wrong one, which is the worse outcome. Marking the period as
                consumed prevents the auto path immediately firing a second
                scan of the same card. */}
            {/* RENDERED EVEN WHILE `loading`. If the tap target disappears
                whenever the scanner thinks it is busy, then a wedged `loading`
                flag removes the very control that exists to recover from it --
                which is what Zach hit: "tapping didn't get it to scan again".
                handleCapture still refuses to run two scans at once, so the
                worst case of a tap during a real scan is that nothing
                happens. */}
            {fullscreenScan && cameraActive && autoScan && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  // NO DETECTION REQUIREMENT. This gate was `if
                  // (!liveDetectRef.current) return;` and it is very likely why
                  // Zach's taps did nothing at all: "The first card I put in
                  // never scanned and tapping didn't resolve it". If the live
                  // detector is not producing a box -- and a card that never
                  // auto-scans is exactly that case -- then tap silently did
                  // nothing too, for the SAME reason the auto path was stuck.
                  //
                  // A manual tap is an explicit instruction. It must not be
                  // conditional on the subsystem that is already failing. The
                  // server does its own detection on the full-resolution frame
                  // and is far better at it than the 160px preview detector, so
                  // a scan with no preview box is still worth sending.
                  // TAP MUST ALSO RECOVER A WEDGED SCANNER.
                  //
                  // Zach: "it stopped scanning eventually and tapping didn't get
                  // it to scan again". Two independent latches can wedge
                  // auto-scan, and tap has to clear BOTH or it is not an escape
                  // hatch at all -- it just fails the same way the auto path
                  // did, which is precisely what he experienced.
                  //
                  //   stablePeriodConsumedRef  one-scan-per-stable-period latch
                  //   currentScanId            bumped so any in-flight scan's
                  //                            late callbacks cannot clobber
                  //                            the state this tap is about to
                  //                            set
                  //
                  // `loading` is the third, and it is cleared unconditionally
                  // in handleCapture's finally now -- see the note there.
                  stablePeriodConsumedRef.current = true;
                  stableCountRef.current = 0;
                  prevDetRef.current = null;
                  currentScanId.current += 1;
                  handleCaptureRef.current?.(false, true);  // manual + force past a stuck `loading`
                }}
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 15,
                  cursor: 'pointer',
                  background: 'transparent',
                }}
                aria-label={t('scan.tapToScan')}
              />
            )}

            {fullscreenScan && (scanStatus || loading || autoScanWaitReason) && (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  bottom: `calc(5.5rem + env(safe-area-inset-bottom))`,
                  zIndex: 21,
                  maxWidth: '86%',
                  padding: '0.5rem 0.9rem',
                  borderRadius: 999,
                  background: 'rgba(0,0,0,0.72)',
                  border: '1px solid rgba(255,255,255,0.28)',
                  color: 'var(--text-strong)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  textAlign: 'center',
                  pointerEvents: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.45rem',
                }}
              >
                {/* A moving indicator distinguishes "working" from "idle and
                    stuck". A static string cannot: an auto-scan that has quietly
                    stopped and one mid-lookup look identical without it. */}
                {loading && (
                  <span
                    style={{
                      width: 10, height: 10, borderRadius: '50%',
                      border: '2px solid rgba(255,255,255,0.35)',
                      borderTopColor: 'var(--accent-red)',
                      animation: 'scan-status-spin 0.8s linear infinite',
                      flexShrink: 0,
                    }}
                  />
                )}
                <span>{scanStatus || autoScanWaitReason || t('scan.working')}</span>
              </div>
            )}

            {/* QUEUE COUNT, in frame. The review banner also lives below the
                camera (~line 1940) and is equally invisible in fullscreen — so
                the queue silently grew to 6 entries during Zach's session with
                no on-screen sign. A count badge is enough here: it says
                something needs attention without stealing the frame, and the
                full banner is one tap away via the fullscreen exit. Tapping it
                leaves fullscreen rather than opening review directly, so the
                camera is never torn down underneath an unrelated screen. */}
            {fullscreenScan && queuePending > 0 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setFullscreenScan(false); }}
                style={{
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  top: `calc(1rem + env(safe-area-inset-top))`,
                  zIndex: 21,
                  padding: '0.35rem 0.8rem',
                  borderRadius: 999,
                  background: 'rgba(0,0,0,0.72)',
                  border: '1px solid var(--accent-yellow)',
                  color: 'var(--accent-yellow)',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {t('scan.queuedBadge', { count: queuePending })}
              </button>
            )}

            {/* THE SESSION BADGE — how many cards are waiting, and the way in.
                Placed in-frame because in fullscreen the camera covers the
                screen: a count rendered below the preview is invisible, which
                is how the review queue silently reached six entries without
                Zach seeing it. A session he cannot see is a session he cannot
                trust holds his stack.

                Green when everything is clean, amber when something is flagged,
                so the colour alone answers "does this need me?". */}
            {stagedCount > 0 && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowStaging(true); }}
                aria-label={t('scan.stagingOpen')}
                style={{
                  position: 'absolute',
                  right: '1rem',
                  top: `calc(1rem + env(safe-area-inset-top))`,
                  zIndex: 21,
                  padding: '0.35rem 0.8rem',
                  borderRadius: 999,
                  background: 'rgba(0,0,0,0.72)',
                  border: `1px solid ${stagedFlagged ? 'var(--accent-yellow)' : 'var(--type-grass)'}`,
                  color: stagedFlagged ? 'var(--accent-yellow)' : 'var(--type-grass)',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {stagedFlagged
                  ? t('scan.stagingBadgeFlagged', { count: stagedCount, flagged: stagedFlagged })
                  : t('scan.stagingBadge', { count: stagedCount })}
              </button>
            )}

            {/* PR 9: the fixed-cadence countdown ring is gone with the metronome
                that drove it — only the retired 'Turbo' preset had a cadence, so
                captureCountdown was permanently null and this never rendered. */}

            {/* Outline Box Guides */}
            <div className="camera-overlay">
              <style>{`
                @keyframes border-flash-success {
                  0%, 100% { border-color: rgba(255, 255, 255, 0.4); box-shadow: none; }
                  30%, 70% { border-color: var(--type-grass); box-shadow: 0 0 25px rgba(74, 222, 128, 0.6); }
                }
                @keyframes border-flash-error {
                  0%, 100% { border-color: rgba(255, 255, 255, 0.4); box-shadow: none; }
                  30%, 70% { border-color: var(--accent-red); box-shadow: 0 0 25px var(--accent-red-glow); }
                }
                @keyframes border-flash-capture {
                  0%, 100% { border-color: rgba(255, 255, 255, 0.4); box-shadow: none; }
                  50% { border-color: #fff; box-shadow: 0 0 30px rgba(255, 255, 255, 0.9); }
                }
                @keyframes scan-status-spin {
                  to { transform: rotate(360deg); }
                }
              `}</style>
              {/* THE LIVE CARD OUTLINE — drawn where the card WAS FOUND.
                  Zach: "mana box ... just draws a line around the entire and it
                  auto detects that", "I want live drawing going green when it
                  has it."

                  This is the inversion that matters: the old dashed box was an
                  INPUT (aim here) and the app then had to guess which rectangle
                  inside it was the card — which is why a card in a white box
                  failed, the box being the bigger, better-centred rectangle.
                  This outline is OUTPUT: it shows what the app has actually
                  locked onto, so "green" is a promise backed by a detection
                  rather than a hint that something might be there. */}
              {liveDetect && (
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: `${liveDetect.x}px`,
                    top: `${liveDetect.y}px`,
                    width: `${liveDetect.w}px`,
                    height: `${liveDetect.h}px`,
                    border: `3px solid ${isLocked(liveDetect) ? 'var(--type-grass)' : 'rgba(255,255,255,0.55)'}`,
                    boxShadow: isLocked(liveDetect)
                      ? '0 0 18px rgba(74, 222, 128, 0.55)'
                      : 'none',
                    borderRadius: '10px',
                    pointerEvents: 'none',
                    // Snappy enough to feel attached to the card, slow enough
                    // that per-frame jitter does not read as a shaking box.
                    transition: 'left 90ms linear, top 90ms linear, width 90ms linear, height 90ms linear, border-color 120ms linear',
                    zIndex: 3,
                  }}
                />
              )}

              <div
                className="scan-card-guide"
                onPointerDown={onGuidePointerDown}
                onPointerMove={onGuidePointerMove}
                onPointerUp={onGuidePointerUp}
                onPointerCancel={onGuidePointerUp}
                style={{
                  pointerEvents: 'auto',
                  cursor: 'move',
                  touchAction: 'none',
                  transform: `translate(${guideOffset.x}px, ${guideOffset.y}px) rotate(${guideAngle}deg) scale(${guideScale})`,
                  animation: scanFlash === 'capture' ? 'border-flash-capture 0.4s ease-in-out' : scanFlash === 'error' ? 'border-flash-error 1.5s ease-in-out' : 'none'
                }}
              >
                {loading && <div className="scan-line"></div>}
              </div>
              {(guideOffset.x !== 0 || guideOffset.y !== 0 || guideAngle !== 0 || guideScale !== 1) && (
                <button
                  type="button"
                  onClick={resetGuide}
                  style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'auto', zIndex: 10, fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-strong)', background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.4)', borderRadius: 999, padding: '0.25rem 0.7rem', cursor: 'pointer' }}
                >
                  {t('scan.resetBox')}
                </button>
              )}
            </div>
          </div>

          {/* Settings panel (toggled by the gear in the action row): set,
              scan detail, exposure. Kept off the camera view so it stays clean. */}
          {showScanSettings && (
          <div className="glass-panel" style={{ width: '100%', padding: '1rem', background: 'rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.25rem', order: 2, position: 'relative', zIndex: setSearchOpen ? 40 : undefined }}>
            {/* Set search: pick a set to build a per-set index
                for accurate one-step scans. Free text also works as an
                exact-id escape hatch for sets not yet cached. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', position: 'relative' }}>
              {(() => {
                const bp = setBuildProgress;
                const pct = bp && bp.total > 0 ? Math.round((bp.done / bp.total) * 100) : null;
                const isFetching = setPrep === 'building' && (pct === null || bp?.status === 'fetching');
                const displayPct = isFetching ? 15 : (pct || 0);

                let text;
                if (!scanSetCodes.length) {
                  // PR 9: this banner used to open with a strong recommendation
                  // to pick set(s) first, warning that unscoped scanning could
                  // identify the wrong card. That was true before a global index
                  // existed. It is now FALSE — unscoped card identification
                  // measured 12/12 and 10/10 in two separate runs against the
                  // live route, at every upload width from 400px to 1600px.
                  //
                  // Leaving it up steered Zach away from the exact workflow he
                  // asked for ("any card, no set first") on the strength of a
                  // fact that no longer holds. Set scoping is still a real
                  // option — it makes a known box faster — so it is presented as
                  // a SPEED choice, which is what it now is, rather than as a
                  // correctness warning.
                  text = t('scan.setOptionalHint');

                } else if (setPrep === 'building') {
                  text = isFetching
                    ? `Preparing ${setLabelJoined}… fetching card list. Scans work meanwhile.`
                    : `Indexing ${setLabelJoined}: ${bp.done}/${bp.total} cards (${pct}%). Scans work meanwhile.`;
                } else if (setPrep === 'ready') {
                  text = `${setLabelJoined} ready: exact matches within your set${scanSetCodes.length > 1 ? 's' : ''}.`;
                } else if (setPrep === 'error') {
                  text = setBuildError || `${setLabelJoined} could not be indexed.`;
                } else {
                  text = setLabelJoined;
                }
                const textColor = setPrep === 'error' ? 'var(--accent-red)'
                  // No set selected is a NORMAL, fully supported state now, so it
                  // is styled as ordinary secondary text. It used to be yellow —
                  // a warning colour saying "you are doing this wrong" about the
                  // workflow Zach actually asked for.
                  : !scanSetCodes.length ? 'var(--text-secondary)'
                  : setPrep === 'ready' ? 'var(--type-grass)'
                  : 'var(--text-secondary)';
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    <p style={{ fontSize: '0.75rem', color: textColor, margin: 0, textAlign: 'center', fontWeight: 600 }}>
                      {text}
                    </p>
                    {/* A set that failed but sits alongside ones still building:
                        the bar below keeps reporting the buildable ones. */}
                    {setPrep === 'building' && setBuildError && (
                      <p style={{ fontSize: '0.7rem', color: 'var(--accent-red)', margin: 0, textAlign: 'center' }}>
                        {setBuildError}
                      </p>
                    )}
                    {setPrep === 'building' && (
                      <div style={{ padding: '0.45rem 0.65rem', background: 'rgba(0,0,0,0.35)', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.12)', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-strong)' }}>
                          <span>{isFetching ? 'Fetching Card List...' : `Indexing Cards (${bp?.done || 0}/${bp?.total || 0})`}</span>
                          <span style={{ color: 'var(--accent-yellow)' }}>{isFetching ? 'Please wait' : `${pct}%`}</span>
                        </div>
                        <div style={{ height: '10px', width: '100%', background: 'rgba(255,255,255,0.08)', borderRadius: '5px', overflow: 'hidden', position: 'relative' }}>
                          <div style={{
                            height: '100%',
                            width: `${displayPct}%`,
                            background: 'linear-gradient(90deg, #ef4444, #f59e0b, #10b981)',
                            borderRadius: '5px',
                            transition: 'width 0.3s ease',
                            boxShadow: '0 0 10px rgba(245, 158, 11, 0.6)'
                          }} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
              {scanSetCodes.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                  {scanSetCodes.map((code) => (
                    <span key={code} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.2rem 0.5rem', fontSize: '0.7rem', fontWeight: 600, background: 'rgba(255,255,255,0.06)', border: '1px solid var(--type-grass)', borderRadius: '999px', color: 'var(--text-strong)' }}>
                      {labelForCode(code)}
                      <button type="button" onClick={() => removeSetCode(code)} aria-label={`Remove ${code}`} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: '0.85rem' }}>&times;</button>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{t('scan.addSet')}</label>
                <input
                  type="text"
                  value={setInput}
                  onChange={(e) => { setSetInput(e.target.value); setSetSearchOpen(true); }}
                  onFocus={() => setSetSearchOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const q = setInput.trim().toLowerCase();
                      if (!q) return;
                      // Snap a typed name/code to the canonical dropdown code so
                      // "Foundations" and "FDN" don't build twice; else add as-is.
                      const m = setList.find(s => [s.id, s.ptcgo_code, s.name].some(v => (v || '').toLowerCase() === q));
                      addSetCode(m ? setScanCode(m) : setInput.trim());
                      setSetInput(''); setSetSearchOpen(false);
                    }
                  }}
                  onBlur={() => setTimeout(() => {
                    setSetSearchOpen(false);
                    const q = setInput.trim().toLowerCase();
                    if (!q) return;
                    const m = setList.find(s => [s.id, s.ptcgo_code, s.name].some(v => (v || '').toLowerCase() === q));
                    if (m) { addSetCode(setScanCode(m)); setSetInput(''); }
                  }, 150)}
                  placeholder={t('scan.setSearchMtg')}
                  style={{ flex: 1, padding: '0.3rem 0.5rem', fontSize: '0.75rem', background: 'rgba(255,255,255,0.06)', border: `1px solid ${scanSetCodes.length ? 'var(--type-grass)' : 'var(--border-glass)'}`, borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)' }}
                />
                {scanSetCodes.length > 0 && (
                  <button type="button" className="btn btn-secondary" style={{ fontSize: '0.6rem', padding: '0.2rem 0.4rem' }} onClick={() => { persistSets([]); setSetInput(''); setSetSearchOpen(false); }}>{t('bulk.clear')}</button>
                )}
              </div>
              {setSearchOpen && setSuggestions.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, marginTop: '0.2rem', background: 'var(--bg-elevated, #1c1c22)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', maxHeight: '220px', overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                  {setSuggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onMouseDown={() => { addSetCode(setScanCode(s)); setSetInput(''); setSetSearchOpen(false); }}
                      style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', width: '100%', padding: '0.4rem 0.6rem', background: 'none', border: 'none', color: 'var(--text-strong)', fontSize: '0.75rem', textAlign: 'left', cursor: 'pointer' }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      <span style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', flexShrink: 0 }}>{setScanCode(s)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* PR 9: the Scan Detail slider is REMOVED. Measured, its axis did
                not exist — recallK scored 8/8 card identity at 250/100/50/25/10
                and moved only latency, and card identity was 10/10 at every
                upload width down to 400px. Capture now uses one fixed profile
                (SCAN_UPLOAD_W = 1280), chosen for the collector-number strip,
                which is the only consumer that needs the resolution. */}

            {/* Manual exposure: only rendered when the camera track supports it
                (Android Chrome back cams). Auto-exposure stays default until you
                move this. */}
            {exposureCaps && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{t('scan.exposure')}</span>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: '0.6rem', padding: '0.15rem 0.4rem' }}
                    onClick={() => {
                      const track = stream?.getVideoTracks?.()[0];
                      if (track) updateAdvancedConstraints(track, { exposureMode: 'continuous', exposureCompensation: null });
                      const cur = track?.getSettings?.().exposureCompensation;
                      setExposure(typeof cur === 'number' ? cur : 0);
                    }}
                  >
                    {t('scan.auto')}
                  </button>
                </div>
                <input
                  type="range"
                  min={exposureCaps.min}
                  max={exposureCaps.max}
                  step={exposureCaps.step}
                  value={exposure}
                  onChange={(e) => changeExposure(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-red)' }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                  <span>{t('scan.darker')}</span>
                  <span>{t('scan.brighter')}</span>
                </div>
              </div>
            )}
          </div>
          )}

          {/* Scan crop + candidate diagnostics — only render when we actually have
              a crop/candidates, so an empty dashed box doesn't eat vertical space on phone.
              PR 12 adds cameraInfo to the render condition: the NEGOTIATED CAMERA
              MODE must be visible BEFORE the first scan, because if the phone
              silently handed back 1280x720 then nothing downstream can help and
              that is the first thing Zach needs to be able to tell us. */}
          {cameraActive && (cameraInfo || debugHashImg || debugCandidates.length > 0) && (
            <div className="glass-panel" style={{ width: '100%', padding: '0.75rem 1rem', background: 'rgba(0,0,0,0.3)', border: '1px dashed var(--border-glass-hover)', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.25rem' }}>
              {/* PR 12: WHAT THE CAMERA ACTUALLY GAVE US, and what we actually
                  sent. Asking getUserMedia for 4032x3024 is a request, not a
                  result — iOS Safari negotiates freely and no browser runs in
                  this repo, so these numbers cannot be known from here. They are
                  the same lesson as the focus gate's scores one panel down: put
                  the measurement on screen so the NEXT change is measured. */}
              {cameraInfo && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                    {t('scan.cameraModeDebug')}
                  </span>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                    <span style={{ fontWeight: 700, color: 'var(--text-strong)' }}>
                      {cameraInfo.width && cameraInfo.height
                        ? `${cameraInfo.width}×${cameraInfo.height}`
                        : t('scan.cameraModeUnknown')}
                    </span>
                    {cameraInfo.shortSide ? <span> · card side {cameraInfo.shortSide}px</span> : null}
                    {cameraInfo.frameRate ? <span> · {cameraInfo.frameRate}fps</span> : null}
                    {/* Lens indicator. Below 1.0 is the ultra-wide, which is a
                        complete explanation for a soft capture on its own, so it
                        is called out in the warning colour rather than left as a
                        number to interpret. */}
                    {cameraInfo.zoom != null ? (
                      <span style={{ color: cameraInfo.zoom < 1 ? 'var(--accent-yellow)' : undefined }}>
                        {' '}· zoom {cameraInfo.zoom}
                        {cameraInfo.zoom < 1 ? ' (ULTRA-WIDE)' : ''}
                      </span>
                    ) : null}
                    <span style={{ color: 'var(--text-muted)' }}> (asked {cameraInfo.requestedW}×{cameraInfo.requestedH})</span>
                  </div>
                  {uploadInfo && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      {t('scan.uploadDebug', { crop: uploadInfo.cropW, sent: uploadInfo.sentW, kb: uploadInfo.kb })}
                      {/* WHICH capture path produced that crop. 'video' after a
                          scan means the still path fell back — the crop width
                          alone cannot show that, and a silent permanent fallback
                          would otherwise look identical to success. */}
                      {captureSource && (
                        <span style={{ color: captureSource === 'photo' ? 'var(--type-grass)' : 'var(--accent-yellow)' }}>
                          {captureSource === 'photo' ? ' · still photo' : ' · video frame'}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* Hash-match diagnostics: what was cropped + the ranked candidates. */}
              {(debugHashImg || debugCandidates.length > 0) && (
                <div style={{ display: 'flex', gap: '0.75rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', marginTop: '0.25rem' }}>
                  {debugHashImg && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.25rem', flexShrink: 0 }}>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('scan.hashedCrop')}</span>
                      <img src={debugHashImg} style={{ width: '52px', maxHeight: '80px', objectFit: 'contain', background: '#111', borderRadius: '3px', border: '1px solid var(--border-glass-hover)' }} alt="Hashed crop" />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                    {debugScoped !== null && (
                      <span style={{ fontSize: '0.65rem', fontWeight: 700, color: debugScoped ? 'var(--type-grass)' : 'var(--accent-red)' }}>
                        {debugScoped ? `✓ Set-scoped: ${debugScoped}` : '✗ GLOBAL search (not scoped to a set)'}
                      </span>
                    )}
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Top matches ({debugCandidates[0]?.verified ? 'ORB inliers' : 'similarity'}, higher = closer)</span>
                    {debugCandidates.length === 0 ? (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('scan.noCandidates')}</span>
                    ) : debugCandidates.slice(0, 3).map((cd, i) => {
                      const pass = cd.verified ? cd.inliers >= SCAN_MATCH_MIN_INLIERS : cd.score >= SCAN_MATCH_MIN_SCORE;
                      const label = cd.verified ? `${cd.inliers} inl` : (cd.score != null ? cd.score.toFixed(2) : '?');
                      return (
                        <div key={i} style={{ fontSize: '0.7rem', color: i === 0 ? '#fff' : 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <span style={{ color: pass ? 'var(--type-grass)' : 'var(--accent-red)', fontWeight: 700 }}>{label}</span>
                          {' '}{cd.name} <span style={{ color: 'var(--text-muted)' }}>({cd.set} #{cd.number})</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* BUG 2: THE FOCUS GATE'S OBSERVED NUMBERS.
                  The previous threshold was a guess tuned against synthetic
                  blur, and the only way it got disproved was Zach scanning a
                  stack and reporting that "hold steady" showed on every card.
                  Showing the real scores here means the next adjustment is
                  measured rather than guessed. Rendered inside the EXISTING
                  diagnostics panel, in its existing type scale — no new screen
                  and no new layout. */}
              {gateLog.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', background: 'rgba(0,0,0,0.2)', padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                    {t('scan.focusGateDebug')}
                  </span>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {gateLog.slice(-6).map((g, i) => (
                      <span key={i} style={{ marginRight: '0.5rem', color: g.captured ? 'var(--type-grass)' : 'var(--accent-red)' }}>
                        {g.score == null ? '—' : g.score}
                        {g.baseline == null ? '' : `/${g.baseline}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* PENDING REVIEW BANNER. Shown DURING scanning so the queue is never
              a surprise at the end of a stack — Zach needs to know that cards
              are accumulating decisions while he works, not discover forty of
              them later.
              It states plainly that these are NOT in the collection yet, because
              the whole safety property of the queue is that a pending decision
              is not a card he owns. Tapping is the ONLY way to the review
              screen; nothing opens it automatically mid-scan. */}
          {queuePending > 0 && (
            <button
              type="button"
              onClick={() => setShowReviewQueue(true)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
                width: '100%', minHeight: 44, padding: '0.5rem 0.75rem', marginBottom: '0.5rem',
                background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.4)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)', cursor: 'pointer',
                fontSize: '0.75rem', fontWeight: 700,
              }}
            >
              <span>{t('scan.pendingReview', { count: queuePending })}</span>
              <span style={{ color: 'var(--accent-yellow)' }}>{t('scan.pendingReviewCta')}</span>
            </button>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
            <button className="btn btn-secondary" onClick={stopCamera} style={{ flex: 1 }} title={t('scan.stopCamera')}>
              {t('scan.stop')}
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={autoScan}
              className="btn btn-secondary"
              onClick={() => setAutoScan(!autoScan)}
              style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0 0.7rem', borderColor: autoScan ? 'var(--type-grass)' : undefined, color: autoScan ? 'var(--type-grass)' : undefined }}
              title={t('scan.autoCaptureHint')}
            >
              <ScanLine size={15} />
              <span style={{ fontSize: '0.72rem', fontWeight: 700 }}>{t('scan.auto')}</span>
              <span style={{ width: 28, height: 15, borderRadius: 999, background: autoScan ? 'var(--type-grass)' : 'rgba(255,255,255,0.22)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                <span style={{ position: 'absolute', top: 2, left: autoScan ? 15 : 2, width: 11, height: 11, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
              </span>
            </button>
            {loading ? (
              <button className="btn btn-primary" onClick={handleCancelScan} style={{ flex: 2, backgroundColor: 'var(--accent-red)', borderColor: 'var(--accent-red)' }}>
                {t('scan.cancelScan')}
              </button>
            ) : (
              // NOTE: the arrow wrapper is load-bearing. onClick={handleCapture}
              // would pass the CLICK EVENT as `auto`, which is truthy, and a
              // manual tap would then be silently subject to the sharpness gate
              // — the one thing that must never happen.
              <button className="btn btn-primary" onClick={() => handleCapture(false)} style={{ flex: 2 }}>
                {t('scan.captureIdentify')}
              </button>
            )}
            <button
              type="button"
              className={`btn ${showScanSettings ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setShowScanSettings(s => !s)}
              title={t('scan.settingsHint')}
              aria-label={t('scan.settings')}
              style={{ flexShrink: 0, padding: '0 0.7rem', position: 'relative' }}
            >
              <Settings size={16} />
              {!scanSetCodes.length && <span style={{ position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: '50%', background: 'var(--accent-yellow)' }} />}
            </button>
          </div>
        </div>
      )}

      {/* Scan Status Log */}
      {scanStatus && (
        <div className="glass-panel" style={{ width: '100%', padding: '1rem', borderLeft: '3px solid var(--accent-red)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {loading && <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div>}
          <span style={{ fontSize: '0.85rem', color: 'var(--text-strong)', fontWeight: 500 }}>{scanStatus}</span>
        </div>
      )}

      {/* Auto Add Countdown Overlay. Tap the card (before the countdown ends) to
          pause auto-add and adjust condition/printing before it's saved. */}
      {autoAddTargetCard && (autoAddCountdown !== null || autoAddEditing) && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: '1rem'
          }}
        >
          <div className="glass-panel animate-fade-in" style={{ maxWidth: '420px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center', textAlign: 'center', border: '1px solid var(--accent-red)' }}>
            <div>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 800 }}>{t(autoAddEditing ? 'scan.adjustAndAdd' : 'scan.exactMatch')}</span>
              <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', margin: '0.25rem 0 0.5rem 0' }}>{autoAddTargetCard.name}</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>{autoAddTargetCard.set_name} • #{autoAddTargetCard.number}</p>
            </div>

            <div
              onClick={() => {
                if (autoAddEditing) return;
                // Pause and open the editor with sensible defaults.
                setAutoAddCond('Near Mint');
                setAutoAddPrint('nonfoil');
                setAutoAddEditing(true);
              }}
              style={{ position: 'relative', width: '115px', aspectRatio: 0.718, margin: '0.5rem 0', cursor: autoAddEditing ? 'default' : 'pointer' }}
              title={autoAddEditing ? undefined : 'Tap to change condition/foil'}
            >
              <img src={autoAddTargetCard.image_url} alt={autoAddTargetCard.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '6px', boxShadow: 'var(--shadow-glow)' }} />
              {!autoAddEditing && (
                <div style={{
                  position: 'absolute',
                  top: '-10px',
                  right: '-10px',
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  backgroundColor: 'var(--accent-red)',
                  border: '2px solid #fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-strong)',
                  fontWeight: 900,
                  fontSize: '1rem',
                  boxShadow: '0 4px 10px rgba(0,0,0,0.5)'
                }}>
                  {autoAddCountdown}
                </div>
              )}
            </div>

            {autoAddEditing ? (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ display: 'flex', gap: '0.6rem' }}>
                  <div className="form-group" style={{ marginBottom: 0, flex: 1, textAlign: 'left' }}>
                    <label>{t('card.condition')}</label>
                    <select className="select-control" value={autoAddCond} onChange={(e) => setAutoAddCond(e.target.value)}>
                      {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="form-group" style={{ marginBottom: 0, flex: 1, textAlign: 'left' }}>
                    <label>{t('card.printing')}</label>
                    <select className="select-control" value={autoAddPrint} onChange={(e) => setAutoAddPrint(e.target.value)}>
                      {getPrintings(autoAddTargetCard.game || autoAddTargetCard.supertype).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', width: '100%' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      const card = autoAddTargetCard;
                      const overrides = { condition: autoAddCond, printing: autoAddPrint };
                      setAutoAddTargetCard(null);
                      setAutoAddCountdown(null);
                      setAutoAddEditing(false);
                      autoAddCard(card, 1, overrides);
                    }}
                    style={{ flex: 1.5, fontSize: '0.75rem', padding: '0.45rem 0' }}
                  >
                    {t('search.addToCollection')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setAutoAddTargetCard(null);
                      setAutoAddCountdown(null);
                      setAutoAddEditing(false);
                      showToast(t('scan.autoAddCancelled'));
                    }}
                    style={{ flex: 1, fontSize: '0.75rem', padding: '0.45rem 0' }}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Auto-adding to collection in {autoAddCountdown}s...</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('scan.tapToChange')}</span>
                <div style={{ display: 'flex', gap: '0.5rem', width: '100%', marginTop: '0.5rem' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      const card = autoAddTargetCard;
                      setAutoAddTargetCard(null);
                      setAutoAddCountdown(null);
                      autoAddCard(card);
                    }}
                    style={{ flex: 1.5, fontSize: '0.75rem', padding: '0.45rem 0' }}
                  >
                    {t('scan.addNow')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setAutoAddTargetCard(null);
                      setAutoAddCountdown(null);
                      showToast(t('scan.autoAddCancelled'));
                    }}
                    style={{ flex: 1, fontSize: '0.75rem', padding: '0.45rem 0' }}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Duplicate-Scan Confirm Overlay: the just-added card was scanned again. */}
      {dupConfirmCard && (
        <div
          className="modal-backdrop"
          style={{
            position: 'fixed',
            top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: '1rem'
          }}
        >
          <div className="glass-panel animate-fade-in" style={{ maxWidth: '420px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', alignItems: 'center', textAlign: 'center', border: '1px solid var(--accent-yellow)' }}>
            <div>
              <span style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 800 }}>{t('scan.sameCardAgain')}</span>
              <h3 style={{ fontSize: '1.25rem', color: 'var(--text-strong)', margin: '0.25rem 0 0.5rem 0' }}>{dupConfirmCard.name}</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>{dupConfirmCard.set_name} • #{dupConfirmCard.number}</p>
            </div>

            <img src={dupConfirmCard.image_url} alt={dupConfirmCard.name} style={{ width: '110px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '6px', boxShadow: 'var(--shadow-glow)' }} />

            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
              {t('scan.repeatHint')}
            </p>

            {/* Quantity stepper: number of ADDITIONAL copies to add now. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDupQty(q => Math.max(1, q - 1))}
                style={{ width: '36px', padding: '0.35rem 0', fontSize: '1rem', fontWeight: 800 }}
              >−</button>
              <span style={{ minWidth: '2.5rem', fontSize: '1.4rem', fontWeight: 900, color: 'var(--text-strong)' }}>{dupQty}</span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDupQty(q => Math.min(99, q + 1))}
                style={{ width: '36px', padding: '0.35rem 0', fontSize: '1rem', fontWeight: 800 }}
              >+</button>
            </div>

            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const card = dupConfirmCard;
                  const qty = dupQty;
                  // Mark handled so the same card lingering in frame won't re-prompt.
                  resolvedDupIdRef.current = card.id;
                  setDupConfirmCard(null);
                  autoAddCard(card, qty);
                }}
                style={{ width: '100%', fontSize: '0.85rem', padding: '0.55rem 0' }}
              >
                Add {dupQty} more {dupQty === 1 ? 'copy' : 'copies'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  resolvedDupIdRef.current = dupConfirmCard.id;
                  setDupConfirmCard(null);
                  showToast(t('scan.discardedRepeat'));
                }}
                style={{ width: '100%', fontSize: '0.8rem', padding: '0.45rem 0' }}
              >
                Discard — same card, keep scanning
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  resolvedDupIdRef.current = dupConfirmCard.id;
                  setDupConfirmCard(null);
                  setAutoScan(false);
                  showToast(t('scan.secondPhoto'));
                }}
                style={{ width: '100%', fontSize: '0.8rem', padding: '0.45rem 0' }}
              >
                Done — that was another photo of the same card
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scan Results Suggestions Popup Modal */}
      {scanMatches.length > 0 && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(5px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1rem'
        }}>
          <div className="glass-panel" style={{ maxWidth: '560px', width: '100%', padding: '1.75rem', display: 'flex', flexDirection: 'column', gap: '1.25rem', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
              <h3 style={{ fontSize: '1.1rem', color: 'var(--text-strong)', margin: 0 }}>{t('scan.identifiedTitle')}</h3>
              <button 
                className="btn btn-secondary btn-icon-only" 
                onClick={() => {
                  setScanMatches([]);
                  setScanStatus('');
                  if (!stream || !cameraActive) startCamera();
                }} 
                style={{ borderRadius: '50%' }}
                title={t('scan.closeRescan')}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>
                {t('scan.selectCorrect')}
              </p>
              
              {/* Manual search fallback within the modal */}
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input 
                  type="text" 
                  placeholder={t('scan.manualSearchPlaceholder')} 
                  className="input-control"
                  style={{ flex: 1, padding: '0.4rem 0.5rem', fontSize: '0.8rem' }}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && e.target.value.trim()) {
                      const q = e.target.value.trim();
                      const p = new URLSearchParams({ game: 'mtg', lang: 'en' });
                      const match = q.match(/^([A-Z0-9]{3,5})\s+(\d+[A-Z★]?)$/i);
                      if (match) {
                        p.append('set', match[1]);
                        p.append('number', match[2]);
                      } else {
                        p.append('name', q);
                      }
                      
                      const searchResponse = await fetch(`/api/search?${p.toString()}`);
                      if (searchResponse.ok) {
                        const m = await searchResponse.json();
                        if (m.length) {
                          setScanMatches(m);
                        } else {
                          showToast(t('scan.errManualSearch'));
                        }
                      }
                    }
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '1rem', maxHeight: '350px', overflowY: 'auto', padding: '0.25rem' }}>
              {scanMatches.map(card => (
                <div key={card.id} className="tcg-card" onClick={() => openQuickAdd(card)} style={{ cursor: 'pointer' }}>
                  <div className="tcg-card-inner" style={{ border: '1px solid var(--border-glass-hover)' }}>
                    <img src={card.image_url} alt={card.name} className="tcg-card-image" />
                  </div>
                  <div className="tcg-card-info" style={{ textAlign: 'center', marginTop: '0.5rem' }}>
                    <div className="tcg-card-name" style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-strong)' }}>{card.name}</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>{card.set_name} • #{card.number}</div>
                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-yellow)', marginTop: '0.2rem' }}>${formatPrice(card.price_trend)}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem' }}>
              <button 
                className="btn btn-primary" 
                onClick={() => {
                  setScanMatches([]);
                  setScanStatus('');
                  if (!stream || !cameraActive) startCamera();
                }} 
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}
              >
                <RefreshCw size={14} />
                <span>{t('scan.rescan')}</span>
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setScanMatches([]);
                  setScanStatus('');
                  setAutoScan(false);
                  if (!stream || !cameraActive) startCamera();
                }}
                style={{ flex: 1 }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recent Scans History Panel */}
      {recentScans.length > 0 && (
        <div className="glass-panel" style={{ width: '100%', marginTop: '1rem' }}>
          <h3 style={{ fontSize: '1rem', color: 'var(--text-strong)', marginBottom: '0.85rem', borderLeft: '3px solid var(--accent-red)', paddingLeft: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{t('scan.recentScans')}</span>
            {recentSelect.selectMode
              ? <button className="btn btn-secondary" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }} onClick={recentSelect.exitSelectMode}>{t('bulk.done')}</button>
              : <button className="btn btn-secondary" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }} onClick={() => setRecentScans([])}>{t('scan.clearHistory')}</button>}
          </h3>

          {/* Bulk action bar (select mode). Same actions/endpoint as the collection page. */}
          {recentSelect.selectMode && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', marginBottom: '0.6rem' }}>
              <span style={{ fontWeight: 800, color: 'var(--text-strong)', fontSize: '0.8rem', marginRight: '0.25rem' }}>{recentSelect.selectedIds.size} selected</span>
              <button className="btn btn-danger" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!recentSelect.selectedIds.size} onClick={() => recentSelect.runBulk('delete', null, t('bulk.confirmDelete', { count: recentSelect.selectedIds.size }))}>{t('bulk.delete')}</button>
              <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!recentSelect.selectedIds.size} onClick={() => recentSelect.runBulk('trade', null)}>{t('bulk.markTrade')}</button>
              <button className="btn btn-secondary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={!recentSelect.selectedIds.size} onClick={() => recentSelect.runBulk('list_type', 'wishlist')}>{t('bulk.moveToWishlist')}</button>
            </div>
          )}

          {/* Horizontal strip of recent scans, card-shaped like the box tiles.
              Tap = edit; long-press = multi-select (shared with collection page). */}
          <div style={{ display: 'flex', gap: '0.6rem', overflowX: 'auto', paddingBottom: '0.4rem' }}>
            {recentScans.map((item, idx) => {
              const selected = recentSelect.selectMode && recentSelect.selectedIds.has(item.entry_id);
              return (
              <div
                key={idx}
                onClick={() => activateRecent(item)}
                {...recentSelect.pressHandlers(item.entry_id)}
                title={t('scan.tapEditHoldSelect')}
                style={{ flex: '0 0 auto', width: '76px', display: 'flex', flexDirection: 'column', gap: '0.25rem', cursor: 'pointer', userSelect: 'none', WebkitTouchCallout: 'none', opacity: recentSelect.selectMode && !selected ? 0.55 : 1 }}
              >
                <img
                  src={item.image_url}
                  alt={item.name}
                  draggable={false}
                  style={{ width: '76px', height: '106px', objectFit: 'cover', borderRadius: '4px', border: selected ? '2px solid var(--accent-red)' : '1px solid var(--border-glass)', boxShadow: selected ? '0 0 12px var(--accent-red-glow)' : '0 2px 6px rgba(0,0,0,0.3)', pointerEvents: 'none' }}
                />
                <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--accent-yellow)', textAlign: 'center' }}>${formatPrice(item.price_trend)}</div>
                {item.placementLabel && (
                  <div style={{ fontSize: '0.55rem', color: '#ffc107', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={item.placementLabel}>{item.placementLabel}</div>
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}

      {inspectorEntry && (
        <CardInspectorModal
          card={inspectorEntry}
          onClose={() => setInspectorEntry(null)}
          onUpdate={onAddSuccess}
          onDeleted={removeRecentTile}
          showToast={showToast}
        />
      )}

      {/* Drawer Overlay for Selected Card */}
      <div className={`drawer-backdrop ${isDrawerOpen ? 'open' : ''}`} onClick={closeDrawer}></div>
      <div className={`quick-add-drawer ${isDrawerOpen ? 'open' : ''}`}>
        {selectedCard && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
              <div>
                <h3 style={{ color: 'var(--text-strong)', fontSize: '1.25rem', margin: 0 }}>{t('scan.addScannedTitle')}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: 0 }}>{selectedCard.name} ({selectedCard.set_name} • #{selectedCard.number})</p>
              </div>
              <button className="btn btn-secondary btn-icon-only" onClick={closeDrawer} style={{ borderRadius: '50%' }}>
                <X size={18} />
              </button>
            </div>

            {/* Three Column Layout (No vertical scroll) */}
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div className="quick-add-grid" style={{ gridTemplateColumns: '200px 1fr' }}>
                
                {/* Column 1: Card Preview (Smaller card: width 150px) */}
                <div className="quick-add-preview">
                  <img 
                    src={selectedCard.image_url} 
                    alt={selectedCard.name} 
                    className="quick-add-preview-img"
                  />
                  <div className="quick-add-preview-info">
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>TCG Market ({printing})</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-yellow)', margin: '0.1rem 0' }}>
                      ${formatPrice(resolveCardPrice(selectedCard, printing))}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      Rarity: <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{selectedCard.rarity || 'Common'}</span>
                    </div>
                  </div>
                </div>

                {/* Column 2: Card Properties Form */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div className="quick-add-section-title">{t('scan.cardProperties')}</div>
                  
                  <CardEntryFields
                    variant="stacked"
                    quantity={quantity} purchasePrice={purchasePrice} condition={condition} printing={printing}
                    onQuantity={setQuantity} onPurchasePrice={setPurchasePrice} onCondition={setCondition} onPrinting={setPrinting}
                    finishes={selectedCard.finishes}
                  />
                </div>
              </div>

              {/* Submit Buttons */}
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', borderTop: '1px solid var(--border-glass)', paddingTop: '1rem', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={closeDrawer} style={{ padding: '0.5rem 1.5rem' }}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary" style={{ padding: '0.5rem 2rem' }}>{t('search.addToCollection')}</button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* The scan session review. Rendered LAST so it overlays the scanner, and
          only on an explicit tap of the session badge — never opened by a scan,
          because interrupting a stack to show a list is the opposite of what
          staging is for. */}
      {showStaging && (
        <ScanStagingReview
          staging={staging}
          onClose={() => setShowStaging(false)}
          onCommitted={() => { if (onAddSuccess) onAddSuccess(); }}
        />
      )}

      {/* The review screen. Rendered LAST so it overlays the scanner, and only
          on an explicit tap — never opened by a scan. Resolving an entry adds
          the card through the server, so onAddSuccess refreshes the collection
          totals that the queue was deliberately excluded from. */}
      {showReviewQueue && (
        <ScanReviewQueue
          queue={reviewQueue}
          onClose={() => setShowReviewQueue(false)}
          onResolved={() => { if (onAddSuccess) onAddSuccess(); }}
        />
      )}
    </div>
  );
}

export default CameraScanner;
