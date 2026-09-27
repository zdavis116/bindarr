import { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, AlertTriangle, X, Zap, ZapOff, Settings } from 'lucide-react';
import confetti from 'canvas-confetti';
import { formatPrice } from '../utils/formatPrice';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import { CONDITIONS, getPrintings } from '../utils/cardOptions';
import { readOnDevice, needsServer, hydrateResults, loadClientScan, resetOnDevice, lastFrameJpeg } from '../utils/clientScan';
import { FRAME_MAX } from '../utils/fastScan';
import CardEntryFields from './CardEntryFields';
import CardInspectorModal from './CardInspectorModal';
import { createScanReviewQueue } from './scanReviewQueue';
import ScanStagingReview from './ScanStagingReview';
import { createScanStaging } from './scanStaging';
import { useBackGuard } from '../utils/useBackGuard';
import { useMultiSelect } from '../utils/useMultiSelect';

import { useT } from '../utils/i18n';
// Centered card-shaped guide box, styled in CSS (.scan-card-guide): card ratio
// with margin, centered by the overlay's flex. The crop maps the box's on-screen
// rect (getBoundingClientRect) into the frame, so its size is driven by CSS.
// Confidence gates for the server match. When ORB geometric verification ran
// (verified=true), gate on inlier count; otherwise on CLIP cosine similarity.
// Below the gate the scan shows the candidates for manual selection.
const SCAN_MATCH_MIN_SCORE = 0.55;
const SCAN_MATCH_MIN_INLIERS = 12;
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
// REJECTED (the gate held the frame back). Nothing was captured and no read
// ran, so there is nothing to pace -- retry almost immediately. The on-device
// reader's own stillness gate is what decides a frame is worth reading, and it
// costs ~15ms to say no, so a long pause here just makes a card that steadied
// instantly sit out for no reason.
//
// SETTLE (a scan ran and resolved). A real pause belongs here, because Zach is
// physically swapping the next card in and re-firing immediately would just
// re-scan the one still in frame.
//
// ERROR (the scan threw). Back off further: hammering a failing server makes
// it worse, and the failure is unlikely to clear within one tick.
//
// RETUNED FOR THE ON-DEVICE READER. These were sized for a ~1.5s server round
// trip, where an extra 350ms was noise. A local read is ~330ms, so the same
// gaps were more than doubling the time between attempts. The upstream app
// this pipeline came from ticks its auto loop at 60ms for exactly this reason
// -- Zach: "His scans worked way quicker than ours."
//
// SETTLE stays generous: it paces a HUMAN swapping a physical card, which did
// not get faster. Only the machine-bound gaps move.
const SCAN_RETRY_REJECTED_MS = 60;
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

// Is this detection in the same place as the previous one?
//
// Both tests must pass. IoU alone accepts a box creeping steadily across the
// frame if each step is small; the area check catches a card being moved
// toward or away from the camera, which IoU is relatively insensitive to.




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
// RETUNED 1.6 -> 1.5 ON MEASURED CAPTURES.
//
// Zach: "currently at 1.6 seems a tad close but also can leave at 1.6 because
// everything seems to be working." His feel was right, and there is hard
// evidence for it. Across 160 detections in his corpus:
//
//     card width  / frame width :  p50 0.827   p95 1.063   max 1.132
//     card height / frame height:  p50 0.865   p95 1.049   max 1.187
//
// Values ABOVE 1.0 mean the card runs off the edge of the frame. That happened
// on 28 of 160 captures -- 18% -- and it is the failure mode PR #38 documented:
// the detector needs visible margin AROUND the card to find its border, and a
// card filling the crop dropped collector-number reads from 8/8 to 1/8.
//
// Scaling linearly:
//
//     zoom 1.6   28/160 overflowing   strip pixels 100%
//     zoom 1.5    9/160 overflowing   strip pixels  88%
//     zoom 1.4    1/160 overflowing   strip pixels  77%
//     zoom 1.3    0/160 overflowing   strip pixels  66%
//
// WHY 1.5 AND NOT 1.4. The competing cost is real: the collector number is
// ~2mm of text and OCR is already the weakest link, so every pixel removed from
// the strip is paid for at the hardest step. 1.5 removes two thirds of the
// overflow for 12% of the strip's pixels; 1.4 removes almost all of it but
// costs nearly a quarter.
//
// 1.5 is the conservative move against a MEASURED harm, without spending much
// on the signal that is already marginal. If overflow still shows up in the
// next corpus, 1.4 is the next step -- and that will be a measurement, not
// another guess.
const SCAN_ZOOM = 1.5;

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
  // AUTO-SCAN IS ALWAYS ON. Zach: "for the auto on I just want it always on no
  // more click to capture button."
  //
  // A constant rather than state. It was state with a toggle AND a reset to
  // false on every camera stop, which is why it kept turning itself off between
  // sessions. Keeping the name lets the existing gates read naturally; the
  // dead branches behind `!autoScan` are removed rather than left implying a
  // mode that no longer exists.
  const autoScan = true;
  const [showScanSettings, setShowScanSettings] = useState(false);
  // The review queue: cards scanned but not yet resolved to an exact printing.
  //
  // The controller is created ONCE (useRef, not useState) because it owns the
  // pending count across re-renders; recreating it would silently reset the
  // badge to zero mid-stack. React state mirrors it purely for rendering — the
  // SERVER remains the source of truth, and `refresh()` reconciles the count.
  const reviewQueueRef = useRef(null);
  if (!reviewQueueRef.current) {
    reviewQueueRef.current = createScanReviewQueue({
    });
  }
  const reviewQueue = reviewQueueRef.current;
  // Reconcile against the server on mount, so a queue left over from a previous
  // session (or a reload mid-stack) shows its real size immediately rather than
  // appearing empty until something new is queued.

  // THE SCAN SESSION. Same controller shape and the same reasoning as the review
  // queue above: created once so its count survives re-renders, mirrored into
  // React state purely for rendering, with the SERVER as the source of truth.
  //
  // Zach: "instead of auto putting in my collection. Just putting aside and at
  // the end letting me add all. That way I can ensure no weirdness occurred or
  // ensure there isn't any dupes."
  const [showStaging, setShowStaging] = useState(false);
  const [stagedCount, setStagedCount] = useState(0);
  // How many staged rows still need a printing chosen. Replaces the old
  // `flaggedCount`, which read a field the staging controller no longer
  // publishes -- it was left over from the queue merge and quietly evaluated to
  // undefined, so the badge could never show the amber "needs you" state.
  const [stagedUnresolved, setStagedUnresolved] = useState(0);
  const stagingRef = useRef(null);
  if (!stagingRef.current) {
    stagingRef.current = createScanStaging({
      onChange: (s) => { setStagedCount(s.stagedCount); setStagedUnresolved(s.unresolvedCount); },
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
  // The identity a TAP has already forced past the queue dedupe guard. Lets the
  // first tap through and refuses a second one on the same card, so a double tap
  // cannot stage two rows for one piece of cardboard. Cleared alongside
  // lastQueuedNameRef when the card leaves the frame, because at that point a
  // genuine second copy must be scannable again.
  const manualForcedNameRef = useRef(null);
  // MANUAL INTENT IS PER-SCAN, AND MUST NOT BE A SHARED MUTABLE FLAG.
  //
  // The first version of this used a single `manualScanRef` set at the top of
  // handleCapture and cleared in its finally. Review found that to be a genuine
  // duplicate-record bug, and it is worth recording why, because the mistake is
  // easy to repeat.
  //
  // handleCapture is async AND deliberately re-enterable: the tap overlay calls
  // it with force=true, which skips the `loading` guard on purpose so a wedged
  // scanner can be recovered. So two invocations overlap, and a shared flag is
  // read by whichever scan happens to be running -- not by the scan that set it.
  //
  //   auto scan A starts            manual = false
  //   A awaits /api/scan-match      (~160 lines of async work follow, with no
  //                                  staleness re-check before the queue guard)
  //   user taps -> scan T starts    manual = TRUE
  //   A resumes, reads the flag     sees TRUE, skips its dedupe guard,
  //                                 and stages a duplicate row
  //
  // That is precisely the failure Zach pays for in a physical recount, caused by
  // the change meant to protect him. The reverse interleaving is also broken: A
  // finishing inside T's window runs A's finally, clearing T's intent, so the
  // tap override silently stops working -- non-deterministically.
  //
  // The fix is structural rather than another guard: intent is a plain local
  // `const isManual = !auto` in handleCapture, captured by that scan's closure
  // and passed explicitly to applyMatches. Concurrent scans then cannot see
  // each other's intent AT ALL, so this class of interleaving becomes
  // unrepresentable rather than merely unlikely. There is no shared cell left
  // to corrupt, which is why no ref is declared here.

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
  // Scratch canvas for scoring settled preview frames. Reused rather than
  // allocated per frame: this runs several times a second on a phone.

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
  // MIRRORED INTO A REF for the capture path. handleCapture is invoked from a
  // timer closure, so reading the state variable there can see a stale value
  // from a previous render — and cropping to a stale detection would frame the
  // card's PREVIOUS position. The ref always holds the latest.
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
  // Card-in-view is STATE as well, because the UI tells Zach why it is waiting.
  // A scanner that has silently decided not to scan is indistinguishable from a
  // broken one.
  // Has the detection held still long enough to count as a deliberate
  // presentation? Drives both the capture trigger and the on-screen status, so
  // what Zach sees and what the scanner decides cannot disagree.

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
  // THE SCANNER IS FULLSCREEN, ALWAYS. Zach: "I want full screen only."
  //
  // This used to be a mode toggled by a maximize button, defaulting to
  // fullscreen only on narrow viewports. He scans on a phone, always in
  // fullscreen, so the windowed path was a second layout to keep working for
  // nobody -- and it is where the "Scanned" badge tap silently failed.
  const fullscreenScan = true;

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

  // stopCamera is defined further down, so the back guard reaches it through a
  // ref rather than a use-before-define.
  const stopCameraRef = useRef(null);

  useBackGuard(scanMatches.length > 0, () => setScanMatches([]));
  // Android hardware back / iOS swipe closes the review screen instead of
  // leaving the scanner entirely, matching every other overlay here.

  useBackGuard(!!dupConfirmCard, () => setDupConfirmCard(null));
  useBackGuard(!!inspectorEntry, () => setInspectorEntry(null));
  useBackGuard(recentSelect.selectMode, recentSelect.exitSelectMode);
  // The staged list closes on back, like every other overlay here.
  useBackGuard(showStaging, () => setShowStaging(false));
  // AND SO DOES THE CAMERA ITSELF -- a SECOND way out, not the only one.
  //
  // Zach got trapped in the fullscreen scanner because the only exit was a
  // button the camera covered. The X button above is the fix; this is the
  // belt-and-braces, because "I can't back out of it" should never depend on a
  // single control rendering correctly.
  //
  // Registered LAST so it has the lowest priority: any open overlay consumes
  // the gesture first, and only a bare camera view closes the camera.
  useBackGuard(cameraActive, () => stopCameraRef.current?.());
  
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
    // `!showStaging` is a CORRECTNESS condition, not a nicety. Zach: "when I
    // look at the scanned cards, scanning should stop in the background."
    //
    // Auto-scan is permanently on and the Scanned overlay does not stop the
    // camera, so while he reviewed the list the scanner kept firing at whatever
    // the phone was pointing at -- the table, his lap, the next card in the
    // stack -- and every one of those inserted a staging row he never asked for.
    //
    // It also opened a real data-loss race (review finding S2): /scan-stage/
    // commit reads the rows to commit and then deletes ALL rows for the user.
    // A row inserted between the read and the delete is destroyed without ever
    // reaching the collection, and the symptom is a card that was scanned,
    // never arrived, and left no trace. Pausing capture while the list is open
    // closes that window at its source -- the only thing that inserts is off.
    // AUTO-SCAN IS A PLAIN LOOP NOW, LIKE UPSTREAM'S.
    //
    // Tick, read the frame, schedule the next tick. That is the whole thing.
    //
    // WHAT USED TO GATE THIS, AND WHY IT IS GONE. Capture waited on
    // `liveDetectRef` (a card is in view), `stableCountRef` (it held still for
    // N frames) and `stablePeriodConsumedRef` (this stable period has not
    // already scanned) -- all three fed by the separate YOLO detector loop that
    // no longer exists. Every one of those questions is now answered INSIDE
    // the reader, on the same frame it is about:
    //
    //   is a card in view      -> cornelius returns no quad; the pass ends in
    //                             ~15ms having read nothing.
    //   has it held still      -> requireStill on an auto pass: the pipeline
    //                             compares corner drift between passes and
    //                             refuses a moving card itself.
    //   is it the same card    -> the reader TRACKS identity by art signature,
    //                             and the duplicate guard below
    //                             (lastQueuedNameRef) refuses a repeat by name.
    //
    // Keeping the old gates would have been three more questions asked of a
    // detector that is not running -- `liveDetectRef.current` is now always
    // null, so `if (!liveDetectRef.current) return;` would have silently
    // disabled auto-scan completely while every test still passed.
    if (cameraActive && autoScan && !isDrawerOpen && !loading && scanMatches.length === 0 && !autoAddTargetCard && !dupConfirmCard && !showStaging) {
      const outcome = lastTickOutcomeRef.current;
      const delay = outcome === 'rejected' ? SCAN_RETRY_REJECTED_MS
        : outcome === 'error' ? SCAN_RETRY_ERROR_MS
        : SCAN_RETRY_SETTLE_MS;
      timerId = setTimeout(() => {
        handleCaptureRef.current?.(true);   // auto: the reader gates the frame
      }, delay);
    }
    return () => {
      if (timerId) clearTimeout(timerId);
    };
  // cardPresent/steady are gone from the deps with the detector that set them:
  // a dep that never changes cannot wake an effect, and leaving them in would
  // have implied a liveness this loop no longer has.
  }, [cameraActive, autoScan, isDrawerOpen, loading, scanMatches, autoAddTargetCard, dupConfirmCard, showStaging]);

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
    // FIRST, because it is the only pause the user deliberately caused. A
    // scanner that has silently stopped is indistinguishable from a broken one,
    // and this one stops for a whole minute at a time while he reads the list.
    if (showStaging) return 'Paused — reviewing scanned cards';
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
    // No detector loop any more, so there is no continuous "is a card there"
    // signal to render. The reader answers that per pass and setScanStatus
    // reports it, so this returns the idle prompt rather than inventing state.
    return t('scan.waitingForCard');
  })();

  // THE READER'S DOWNLOAD STARTS WHEN THE CAMERA OPENS.
  //
  // The first open is when a user is willing to wait, not the first card they
  // hold up. ~28 MB on a first run, then served from the Cache API for ever.
  //
  // Fire-and-forget: loadClientScan resolves {ok:false} rather than throwing,
  // and every scan checks readiness itself, so a device that cannot load it
  // falls back to the server path.
  //
  // resetOnDevice clears the tracked card and the pooled cross-frame footer
  // evidence, so a new camera session cannot inherit the last one's half-read
  // card.
  //
  // WHAT USED TO BE HERE: a second ONNX detector (a 10.7 MB YOLO card
  // detector) on its own 140ms loop, drawing the live outline. It is gone.
  // cornelius -- inside the reader -- already predicts the card's four corners
  // and carries a sharpness head, so the two models were asking the SAME
  // QUESTION and competing for the one wasm thread the browser gives us (no
  // COOP/COEP, so no SharedArrayBuffer, so no threads). Every scan queued
  // behind a detector hunting for the card the scan had already found. Zach:
  // "His scans worked way quicker than ours" -- this contention was the
  // largest single reason.
  useEffect(() => {
    if (!cameraActive) return undefined;
    loadClientScan();
    resetOnDevice();
    return undefined;
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
  // Keep the back-gesture handler pointing at the current stopCamera closure.
  stopCameraRef.current = stopCamera;

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



  // WHAT HAPPENS AFTER submitScan SAYS WHAT IT DID, for an IDENTIFIED card.
  //
  // Extracted so the on-device reader can be a second CALLER rather than a
  // second COPY. Both paths reach the same place -- a proven card that should
  // land in the Scanned list -- and the rule for what the badge, the toast and
  // the recent-scans list do is one rule.
  //
  // DELIBERATELY NOT SHARED WITH THE UNIDENTIFIED PATH. That caller (the one
  // below that submits with no name) looks similar and is a different
  // question: it has nothing to name, so its only outcome is "needs a printing
  // chosen" and it says 'Unidentified card' instead of echoing raw OCR text.
  // Merging the two would force a path through branches that cannot apply to
  // it. Two questions, two answers -- the resemblance is not duplication.
  //
  // `identified` is what to call the card when the server's own row has no
  // name to offer.
  const applyScanOutcome = (outcome, identified) => {
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
      staging.noteStaged(false);   // resolved: a printing was chosen
      setRecentScans(prev => [{
        ...outcome.card, card_id: outcome.card?.id, entry_id: null,
        quantity: 1, condition: 'Near Mint', printing: 'nonfoil', location_id: null,
        staged: true,
      }, ...prev].slice(0, 10));
      // No flag variant any more -- the advisory flags are gone.
      showToast(t('scan.stagedToast', { name: outcome.card?.name || identified }));
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
    } else if (outcome.action === 'staged_unresolved') {
      // SCANNED AND HELD, but we could not tell which printing.
      // It sits in the SAME Scanned list as everything else,
      // outlined and sorted to the top, and Add All refuses until
      // he picks. Nothing is owned, so no modal interrupts the
      // stack -- he resolves them when he is done scanning.
      staging.noteStaged(true);
      setScanStatus(`${identified} — needs a printing chosen`);
      showToast(`${identified} — pick a printing in Scanned`);
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
  };

  // Present the image-match results: show the picker, and on a single result
  // take the fast path (auto-add / quick-
  // add per mode). autoSingle lets the caller allow the fast path for a single MTG
  // result too — used when the image match is confident and the printing is
  // unambiguous (only one printing, or the set code narrowed it to one). Ambiguous
  // MTG (many printings, no set code) still shows the picker.
  // `manualOverride` is the calling scan's own intent, passed explicitly rather
  // than read from shared state -- see the note by lastQueuedNameRef for the
  // duplicate-record bug that a shared flag caused here.
  const applyMatches = async (matches, notFoundMsg, autoSingle = false, matchInliers = null, manualOverride = false) => {
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

        // A MANUAL TAP OVERRIDES EVERY DEDUPE GUARD.
        //
        // Zach: "no card would scan twice even with a tap trying to override
        // it."
        //
        // The tap path already clears the capture-side latches
        // (stablePeriodConsumedRef, loading, currentScanId) -- but the scan then
        // completed and died HERE instead, in the match-side guards, showing
        // "Same card still in view". So the tap did fire a real scan and its
        // result was thrown away, which looks identical to the tap doing
        // nothing.
        //
        // The guards exist to stop a card LINGERING in frame from being counted
        // twice on its own. A tap is not lingering -- it is Zach explicitly
        // asserting "this is a new card, scan it". He is holding the cardboard;
        // the app is inferring from 64 brightness samples. He wins.
        //
        // This is deliberately NOT extended to the auto path: there, a repeat
        // identity really is ambiguous, and a wrong count against physical
        // cardboard costs a recount while a missed card costs a tap.
        if (identityIsTrusted && manualOverride && id === resolvedDupIdRef.current) {
          resolvedDupIdRef.current = null;
        }
        if (identityIsTrusted && !manualOverride && id === resolvedDupIdRef.current) {
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

    // THE INTENT BEHIND THIS SCAN, as a local. `auto === false` means a tap.
    // Captured by this invocation's closure, so a concurrent scan starting
    // mid-flight cannot change what this one believes about itself.
    const isManual = !auto;

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
    // ONE FRAME, STRAIGHT OFF THE PREVIEW. Nothing else.
    //
    // Zach: "I want the scanner to match scrybox exactly so remove anything
    // scrybox isn't using." Everything that used to sit between here and the
    // read has been deleted, because the reader already does its job:
    //
    //   getOrientedVideoCanvas + cropGuideRegion + the locked-detection crop
    //     -> cornelius predicts the card's four corners from the FULL frame.
    //        Cropping first fed it a picture of a crop and cost three canvas
    //        draws per tick to do it.
    //
    //   the laplacian sharpness gate (frameSharpness.js)
    //     -> the pipeline has its own blur gate, measured on 506 real frames:
    //        every card it ever proved scored >= 2161 on the title band and
    //        nothing below 500 ever read. It gates the strip that has to be
    //        legible, not the whole frame.
    //
    //   the separate YOLO live detector on its own 140ms loop
    //     -> the SAME QUESTION cornelius answers, asked twice, by two ONNX
    //        models competing for one wasm thread. That contention is most of
    //        why this felt slow: the scan's own model queued behind a detector
    //        looking for the card it had already found.
    //
    // The reader takes the video element directly; clientScan draws the two
    // canvases it needs (full frame at FRAME_MAX, plus a 384x384 copy for
    // cornelius) from the same instant, so corners and pixels can never come
    // from different moments.
    const sw = video.videoWidth, sh = video.videoHeight;
    if (!sw || !sh) { setLoading(false); return; }

    // ASK THE PHONE FIRST, OFF THE LIVE PREVIEW, BEFORE PAYING FOR ANYTHING.
    //
    // THIS ORDER IS THE WHOLE POINT. Everything below this block -- the
    // ImageCapture still, the 2000px downscale, the main-thread JPEG encode --
    // exists to produce an UPLOAD. When the phone can read the card itself,
    // none of it is needed, and doing it first is pure latency on every scan.
    //
    // Zach, comparing against the app this pipeline came from: "His scans
    // worked way quicker than ours." He was right, and this was why: the
    // reader was identical, but it had been wired INSIDE the old server-scan
    // preamble, so every scan paid the full cost of both pipelines. That app
    // reads straight off the <video> element and only encodes a JPEG if the
    // local read fails. So does this now.
    //
    // The reader is handed the VIDEO ELEMENT, exactly as upstream does it.
    // clientScan draws both canvases it needs from that one source at one
    // instant. The corpus replay that measured this pipeline (92.6%
    // identified, zero wrong cards on 271 of Zach's frames) ran on saved
    // PREVIEW frames, not ImageCapture stills -- so this is the input it was
    // validated against, not a downgrade from it.
    let deviceCard = null;
    let deviceTitle = null;
    {
      try {
        const dev = await readOnDevice(video, sw, sh, { requireStill: !isManual });
        if (scanId !== currentScanId.current) return;
        // needsServer is unit-tested (fastScan.test.js): a proven card never
        // goes up; an unproven one always does; an auto pass with no card at
        // all does NOT -- that is the stillness gate working, and the next
        // pass retries rather than uploading an empty desk.
        if (!needsServer(dev, { autoPass: !isManual })) {
          const hydratedResults = await hydrateResults(dev.results || []);
          if (scanId !== currentScanId.current) return;
          const hit = hydratedResults.find(r => r.ok && r.card);
          if (hit) { deviceCard = hit.card; deviceTitle = hit.title || null; }
        } else if (dev?.error) {
          console.warn('[scan] on-device read failed, using server:', dev.error);
        }
      } catch (e) {
        // Every failure path falls through to the server, exactly as before
        // this block existed.
        console.warn('[scan] on-device path unavailable, using server:', e?.message || e);
      }
    }

    if (deviceCard) {
      lastTickOutcomeRef.current = 'settle';
      signal('capture');
      setCaptureSource('video');
      console.log('Scan candidates: on-device', deviceCard.name, deviceCard.set_id, deviceCard.number);
      setDebugScoped(false);
      setDebugCandidates([{
        name: deviceCard.name, set: deviceCard.set_id, number: deviceCard.number,
        inliers: 100, score: 1, verified: true, card: deviceCard,
      }]);
      const identified = deviceCard.name;
      // THE DUPLICATE GUARD, SAME THREE RULES AS THE SERVER PATH. A second
      // physical copy is legitimate, so a MANUAL tap overrides -- but only once
      // per card, which is what manualForcedNameRef tracks.
      const repeatIdentity = identified === lastQueuedNameRef.current;
      if (repeatIdentity && isManual && identified === manualForcedNameRef.current) {
        setScanStatus('Already scanned this card — lift it and place it again to add another copy.');
        setLoading(false);
        return;
      }
      if (repeatIdentity && !isManual) {
        setScanStatus(t('scan.sameCardAgain'));
        setLoading(false);
        return;
      }
      if (repeatIdentity && isManual) manualForcedNameRef.current = identified;
      setScanStatus('');
      try {
        // THE SAME SUBMIT AND THE SAME HANDLER AS A SERVER SCAN.
        //
        // printingHint carries the printing the phone PROVED by reading the
        // footer, so set + number are evidence rather than a guess. The server
        // still validates it against the catalogue and ignores it unless it
        // resolves to exactly one real printing -- nothing is added on the
        // client's say-so.
        //
        // stage: true because Zach chose staging for on-device reads: nothing
        // enters the collection until he presses Add All.
        const outcome = await reviewQueue.submitScan({
          matchInliers: 100,
          match_inliers: 100,
          name: identified,
          titleText: deviceTitle || identified,
          ocrText: '',
          printingHint: { set: deviceCard.set_id, number: deviceCard.number },
          stage: true,
          crop: null,
          quantity: 1,
        });
        if (scanId !== currentScanId.current) return;
        applyScanOutcome(outcome, identified);
      } catch (err) {
        console.error('on-device submit failed:', err);
        lastTickOutcomeRef.current = 'error';
        if (scanId === currentScanId.current) setScanStatus('Scan failed. Please search manually.');
      } finally {
        setLoading(false);
      }
      return;
    }

    // THE PHONE COULD NOT PROVE IT -- the server gets the same frame.
    //
    // lastFrameJpeg() encodes the canvas clientScan ALREADY drew for the read,
    // so the server sees exactly the pixels the phone looked at and no second
    // capture happens. That is upstream's behaviour and it is also the honest
    // one: a server answer about a different frame is not a fallback, it is a
    // second opinion on a different question.
    //
    // takeStillPhoto / ImageCapture is GONE. It cost a real shutter
    // (~0.3-1s on iOS) on every scan, and upstream never calls it -- the
    // reader proves the card from preview pixels, and the ~7% it cannot prove
    // are cards a sharper still would not have rescued either (no readable
    // title, or a footer the catalogue cannot narrow to one printing).
    setCaptureSource('video');

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
          // REUSE THE FRAME THE READER ALREADY DREW.
          //
          // lastFrameJpeg() encodes clientScan's own full-frame canvas -- the
          // exact pixels cornelius and the recognizer just looked at. No second
          // capture, no third canvas, and the server is answering about the
          // same frame that failed rather than a fresh one.
          //
          // This replaces a downscale + toDataURL on the MAIN THREAD, which
          // blocked the UI on every scan including the ~93% that never upload.
          // convertToBlob on an OffscreenCanvas does the encode off-thread
          // where the browser supports it.
          const blob = await lastFrameJpeg();
          if (!blob) { setScanStatus('No confident match. Try again or search manually.'); signal('error'); return; }
          const imageData = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = () => rej(fr.error);
            fr.readAsDataURL(blob);
          });
          // WHAT WE ACTUALLY SENT, for the diagnostics panel. KB is the
          // Tailscale cost, measured rather than predicted; base64 is ~4/3 of
          // the bytes, so that factor is removed.
          setUploadInfo({
            cropW: sw,
            sentW: Math.min(sw, FRAME_MAX),
            kb: Math.round(blob.size / 1024),
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
                  // A TAP OVERRIDES THIS GUARD -- BUT ONLY ONCE PER CARD.
                  //
                  // The guard exists so a card LINGERING in frame is not staged
                  // repeatedly on its own. A tap is Zach asserting "this is a
                  // new card", so it must get through; that is the whole point
                  // of the escape hatch.
                  //
                  // But an unconditional override means a double tap -- or one
                  // stray double-click on the full-bleed transparent overlay --
                  // stages TWO rows for one piece of cardboard, with no
                  // confirmation anywhere on this path. Given his stated cost
                  // asymmetry (a duplicate costs a recount against cardboard, a
                  // miss costs a tap) that trade is the wrong way round.
                  //
                  // So: the first tap on an identity forces through, a second
                  // tap on the SAME identity is refused AND SAYS SO. If it
                  // really is a second physical copy, the message tells him to
                  // lift and re-present the card, which clears the guard
                  // legitimately. That costs a tap in the rare case and prevents
                  // a recount in the likely one.
                  const repeatIdentity = identified === lastQueuedNameRef.current;
                  if (repeatIdentity && isManual && identified === manualForcedNameRef.current) {
                    setScanStatus('Already scanned this card — lift it and place it again to add another copy.');
                    return;
                  }
                  if (repeatIdentity && !isManual) {
                    setScanStatus(t('scan.sameCardAgain'));
                    return;
                  }
                  // Claim the override BEFORE the await, so a second tap that
                  // arrives while this submit is in flight sees it.
                  if (repeatIdentity && isManual) manualForcedNameRef.current = identified;
                  setScanStatus('');
                  // DO NOT WRITE ON BEHALF OF A SUPERSEDED SCAN. This check used
                  // to sit only AFTER submitScan returned, which is too late --
                  // the row already exists. Two rapid taps both reach here, and
                  // the second bumps currentScanId, so the first must abandon.
                  if (scanId !== currentScanId.current) return;
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

                  applyScanOutcome(outcome, identified);
                  return;
                }

                if (confident && !ambiguousPrinting) {
                  // Instant path: if scan-match pre-hydrated the card from local card_cache,
                  // apply it directly without waiting for a second /api/search HTTP round-trip!
                  if (top.card) {
                    await applyMatches([top.card], '', true, top.inliers, isManual);
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
                  // A CONFIDENT MATCH WITH SEVERAL PRINTINGS IS STILL A QUESTION,
                  // so it must not interrupt a stack either.
                  //
                  // applyMatches shows the picker whenever it receives more than
                  // one card. This call passes autoSingle, so ONE result
                  // auto-adds -- but the by-name fallback above deliberately
                  // fetches every printing, and that reopens the modal on a card
                  // the matcher was actually sure about. Same interruption, a
                  // different door.
                  //
                  // One result: take it, that is the fast path working.
                  // Several: fall through to the queue with the candidates, and
                  // he picks the printing when the stack is done.
                  // One result: take it, that is the fast path working.
                  // Several: fall through to the queue with the candidates.
                  //
                  // There was a second line here for the auto-scan-OFF case,
                  // which showed the picker. Auto-scan is permanent now, so it
                  // was unreachable -- and leaving it would imply a mode that
                  // no longer exists.
                  if (matches.length === 1) { await applyMatches(matches, '', true, null, isManual); return; }
                }

                // A LOW-CONFIDENCE MATCH GOES TO THE QUEUE, NOT A POPUP.
                //
                // Zach, on the "Identified Cards Found" modal: "Why does this
                // screen still pop up? Feels like it doesn't belong with the
                // scanned section now... a low confidence match should go to
                // the queue with maybe the top 3 cards it thinks and I can
                // search for it otherwise."
                //
                // He is right, and the screenshot proves the modal was never a
                // real question: it offered Katerina of Myra's Marvels next to
                // Twisted Experiment -- unrelated cards, not two printings of
                // one. That is the matcher saying "I don't know" while looking
                // like a choice, and it stops a stack mid-flow to ask.
                //
                // The queue already does this properly: it stores the
                // candidates, the review screen renders them to pick from, and
                // it offers a manual search when none of them are right. So
                // this path submits and moves on, and he reviews the whole
                // queue when the stack is done -- which is the entire point of
                // having a queue.
                //
                // NOTHING IS ADDED TO THE COLLECTION HERE. A queue entry costs
                // a tap later; a wrong card costs a recount against cardboard.
                // THE GATE IS THE QUEUE'S, NOT A GUESS AT ONE.
                //
                // This first read `if (autoScan && (clipName || titleText))`,
                // which is why Zach still saw the modal after the last deploy:
                // the popup fires precisely when the matcher is LEAST sure, and
                // those are exactly the scans with no CLIP name and no readable
                // title. His screenshot -- Ceremonial Knife beside Inspiring
                // Call, an artifact and an instant from unrelated sets -- is a
                // scan where nothing was identified at all.
                //
                // The server accepts a staging row on name, title_text OR
                // ocr_text (collection.js:730), so a scan with only OCR text is
                // queueable. Gating on name/title alone rejected the very cases
                // this change exists to capture and dropped them back into the
                // picker.
                //
                // Anything the queue will accept goes to the queue.
                // `ocr.raw`, NOT `ocr.text`. The server builds this object from
                // parseCollectorStrip (collection.js:608) whose field is `raw`;
                // there has never been a `text` key, so this read was always
                // undefined and the whole condition below collapsed to
                // (clipName || titleText).
                //
                // CONSEQUENCE, and it is the worst kind: exactly the scans this
                // fallback was added for -- no CLIP name, no readable title, but
                // a legible collector strip, i.e. the glare and foil cases --
                // fell through to "No confident match" and were SILENTLY
                // DROPPED. No staging row, no unresolved row, nothing to
                // resolve. The card simply went missing from the stack, and
                // lastQueuedNameRef is reset on that path so there was not even
                // a status trace to notice it by.
                //
                // The other call site (:2343) had it right, which is what made
                // this invisible.
                const ocrText = ocr?.raw || '';
                if (autoScan && (clipName || titleText || ocrText)) {
                  // The dedup key must survive having no name at all: fall back
                  // to the OCR text so a stack of unidentifiable cards does not
                  // share one empty key and silently skip every card after the
                  // first.
                  const identified = clipName || titleText || ocrText;
                  const repeatIdentity = identified === lastQueuedNameRef.current;
                  if (repeatIdentity && isManual && identified === manualForcedNameRef.current) {
                    setScanStatus('Already scanned this card — lift it and place it again to add another copy.');
                    return;
                  }
                  if (repeatIdentity && !isManual) {
                    setScanStatus(t('scan.sameCardAgain'));
                    return;
                  }
                  if (repeatIdentity && isManual) manualForcedNameRef.current = identified;
                  if (scanId !== currentScanId.current) return;
                  const outcome = await reviewQueue.submitScan({
                    matchInliers,
                    name: clipName,
                    titleText,
                    ocrText,
                    crop,
                    quantity: 1,
                  });
                  if (scanId !== currentScanId.current) return;
                  if (outcome.action !== 'error') lastQueuedNameRef.current = identified;
                  // Never show raw OCR text as if it were a card name -- when
                  // nothing was identified, say so plainly.
                  const label = clipName || titleText || 'Unidentified card';
                  if (outcome.action === 'staged_unresolved') staging.noteStaged(true);
                  setScanStatus(`${label} — needs a printing chosen`);
                  showToast(`${label} — pick a printing in Scanned`);
                  signal('capture');
                  setScanMatches([]);
                  return;
                }

                // THE PICKER IS GONE. There was a fallback here that fetched
                // every candidate and showed the "Identified Cards Found"
                // modal, kept for the auto-scan-OFF case. Auto-scan is
                // permanent now -- "I just want it always on no more click to
                // capture button" -- so the queue branch above always returns
                // and this was unreachable.
                //
                // Deleted rather than left behind: dead code that renders a
                // screen Zach removed twice is how it comes back.
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
      manualForcedNameRef.current = null;
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
  //
  // `showStaging` is in this list, and it is a CORRECTNESS fix rather than a
  // nicety. Zach: "when I look at the scanned cards, scanning should stop in
  // the background."
  //
  // Auto-scan is permanently on now, and the Scanned overlay does not stop the
  // camera. So while he reviewed the list, the scanner kept firing at whatever
  // the phone happened to be pointing at -- the table, his lap, the next card
  // in the stack -- and each of those inserted a staging row he never asked
  // for.
  //
  // It also created a real data-loss race (review finding S2): /scan-stage/
  // commit reads the rows to commit, then deletes ALL rows for the user. Any
  // row inserted between the read and the delete is destroyed without ever
  // reaching the collection. With the camera live behind the overlay that
  // window is wide open, and the symptom would be a card that was scanned,
  // never appeared in the collection, and left no trace anywhere.
  //
  // Pausing capture while the list is up closes the race at its source: no
  // insert can happen during a commit, because the only thing that inserts is
  // switched off. The scoped DELETE is still worth doing as defence in depth,
  // but this is the fix that makes the window not exist.
  captureBlockedRef.current = isDrawerOpen || scanMatches.length > 0
    || !!autoAddTargetCard || !!dupConfirmCard || showStaging;
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
            {/* THE WAY OUT. Zach: "there is no button to get out of the camera
                so if I go in there and scan no cards I can't back out of it."
                He was trapped, and that is my regression.
                
                A Stop button has always existed -- but it lives in the control
                bar BELOW the preview, which the fullscreen camera covers. In
                windowed mode that was fine and the maximize toggle was the
                secondary escape. Making fullscreen permanent removed the toggle
                and left the only exit off-screen, so the scanner became a room
                with no door unless a scan happened to produce a modal.
                
                Top-LEFT, where the fullscreen toggle used to be: the corner a
                thumb already reaches for to leave a screen, and diagonally
                opposite the torch so it cannot repeat the overlap that made the
                Scanned badge untappable. */}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={(e) => { e.stopPropagation(); stopCamera(); }}
              aria-label={t('scan.stopCamera')}
              title={t('scan.stopCamera')}
              style={{
                position: 'absolute',
                top: `calc(1rem + env(safe-area-inset-top))`,
                left: '1rem',
                zIndex: 22,
                borderRadius: '50%',
                padding: '0.6rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              }}
            >
              <X size={18} />
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
                  // BELOW THE TORCH, NOT UNDERNEATH IT.
                  //
                  // Zach: "for the scanned button when I click it on full
                  // screen mode nothing happens."
                  //
                  // This badge and the torch button were BOTH top:1rem
                  // right:1rem. They overlapped, and the torch (rendered later
                  // in the same stacking context) took the tap -- so pressing
                  // "N scanned" toggled the torch instead of opening the list.
                  // A higher zIndex does not help when the elements are
                  // literally stacked on the same coordinates; they have to not
                  // share the spot.
                  right: '1rem',
                  top: `calc(4.5rem + env(safe-area-inset-top))`,
                  zIndex: 21,
                  padding: '0.35rem 0.8rem',
                  borderRadius: 999,
                  background: 'rgba(0,0,0,0.72)',
                  border: `1px solid ${stagedUnresolved ? 'var(--accent-yellow)' : 'var(--type-grass)'}`,
                  color: stagedUnresolved ? 'var(--accent-yellow)' : 'var(--type-grass)',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {stagedUnresolved
                  ? `${stagedCount} scanned · ${stagedUnresolved} need a printing`
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


          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
            <button className="btn btn-secondary" onClick={stopCamera} style={{ flex: 1 }} title={t('scan.stopCamera')}>
              {t('scan.stop')}
            </button>
            {/* NO CAPTURE BUTTON. Zach: "I just want it always on no more
                click to capture button." Auto-scan fires on its own, and
                tapping the preview forces a scan when the detector will not
                volunteer one -- that tap target is the full-screen overlay
                above, which is the control he actually uses.

                Cancel stays: a scan in flight has to be interruptible. */}
            {loading && (
              <button className="btn btn-primary" onClick={handleCancelScan} style={{ flex: 2, backgroundColor: 'var(--accent-red)', borderColor: 'var(--accent-red)' }}>
                {t('scan.cancelScan')}
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
                  // Suppress THIS card rather than switching auto-scan off.
                  // Auto is permanent now, so the old setAutoScan(false) would
                  // be a no-op -- resolvedDupIdRef is what actually stops the
                  // same card being scanned again while it sits in frame.
                  resolvedDupIdRef.current = dupConfirmCard.id;
                  setDupConfirmCard(null);
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

    </div>
  );
}

export default CameraScanner;
