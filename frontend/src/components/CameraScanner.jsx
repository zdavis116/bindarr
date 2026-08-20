import { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, AlertTriangle, X, Zap, ZapOff, Settings, ScanLine } from 'lucide-react';
import confetti from 'canvas-confetti';
import { formatPrice } from '../utils/formatPrice';
import { resolveCardPrice } from '../utils/resolveCardPrice';
import { CONDITIONS, getPrintings } from '../utils/cardOptions';
import CardEntryFields from './CardEntryFields';
import CardInspectorModal from './CardInspectorModal';
import ScanReviewQueue from './ScanReviewQueue';
import { createScanReviewQueue } from './scanReviewQueue';
import { useBackGuard } from '../utils/useBackGuard';
import { useMultiSelect } from '../utils/useMultiSelect';
import { laplacianVarianceScore, decideCapture, newGateState } from '../utils/frameSharpness';

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
const SCAN_UPLOAD_W = 1280;
// Kept from the old 'Accurate' preset. Deliberately NOT collapsed to Turbo's
// values: countdown 2 leaves a window to cancel a mis-scan, and the cooldown
// paces a physical stack. Neither is an accuracy setting.
const SCAN_COOLDOWN_MS = 3000;
const SCAN_COUNTDOWN = 2;
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

  // Capture scheduler: fire the next capture SCAN_COOLDOWN_MS after the previous
  // scan finishes (loading drops).
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
      timerId = setTimeout(() => {
        handleCaptureRef.current?.(true);   // auto: subject to the sharpness gate
      }, SCAN_COOLDOWN_MS);
    }
    return () => {
      if (timerId) clearTimeout(timerId);
    };
  // The dep list is now exhaustive on its own: dropping `scanDetail` (which the
  // effect never actually read) removed the reason this needed a suppression.
  }, [cameraActive, autoScan, isDrawerOpen, loading, scanMatches, autoAddTargetCard, dupConfirmCard]);

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
  const toggleTorch = async () => {
    const track = stream?.getVideoTracks()[0];
    if (!track) { showToast(t('scan.errCameraNotReady')); return; }
    const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
    if (!caps.torch) {
      showToast(t('scan.errNoTorch'));
      return;
    }
    const next = !isTorchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setIsTorchOn(next);
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
      const constraints = {
        video: {
          facingMode: 'environment', // Use back camera on phones
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };
      
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
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
  const getOrientedVideoCanvas = (video, maxW = 0) => {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
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
    const outW = isRotated ? videoHeight : videoWidth;
    const outH = isRotated ? videoWidth : videoHeight;
    const scale = (maxW && outW > maxW) ? maxW / outW : 1;
    canvas.width = Math.max(1, Math.round(outW * scale));
    canvas.height = Math.max(1, Math.round(outH * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale); // subsequent coords are in unscaled (oriented) space

    if (isRotated) {
      ctx.translate(outW / 2, outH / 2);
      ctx.rotate(90 * Math.PI / 180);
      ctx.drawImage(video, -videoWidth / 2, -videoHeight / 2, videoWidth, videoHeight);
    } else {
      ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
    }

    return canvas;
  };

  // Present the image-match results: show the picker, and on a single result
  // take the fast path (auto-add / quick-
  // add per mode). autoSingle lets the caller allow the fast path for a single MTG
  // result too — used when the image match is confident and the printing is
  // unambiguous (only one printing, or the set code narrowed it to one). Ambiguous
  // MTG (many printings, no set code) still shows the picker.
  const applyMatches = async (matches, notFoundMsg, autoSingle = false) => {
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
        if (id === resolvedDupIdRef.current) {
          // Same card we already handled, still sitting in frame — wait for a
          // different card before doing anything.
          setScanMatches([]);
          setScanStatus('Same card still in view — swap in the next card.');
          return;
        }
        if (id === lastAddedIdRef.current) {
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
  const handleCapture = async (auto = false) => {
    if (loading || !videoRef.current || !cameraActive) return;

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

    // 1. Capture and correctly orient the video frame onto a canvas
    const orientedCanvas = getOrientedVideoCanvas(video);

    // Map the dashed guide box's rendered rect into oriented-canvas pixels through
    // the preview's object-fit:cover transform, then pad it: the box is an aim
    // hint, but a card can overhang it, so crop wider so a frame-filling card
    // isn't clipped. Server auto-detects/deskews the card inside this region.
    const CROP_PAD = 0.05; // 5% tight margin around guide box
    const oc = orientedCanvas;
    const videoRect = video.getBoundingClientRect();
    const guideRect = guideElement.getBoundingClientRect();
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
    const framedCanvas = document.createElement('canvas');
    framedCanvas.width = destW;
    framedCanvas.height = destH;
    const fctx = framedCanvas.getContext('2d');
    // Sample the (possibly rotated, off-center) box region upright: dest center
    // maps to the box center, undo the box rotation, draw the frame. Pixels past
    // the box (pad / frame overhang) come through black; server auto-detects the card.
    fctx.translate(destW / 2, destH / 2);
    fctx.rotate(-rad);
    fctx.translate(-cx, -cy);
    fctx.drawImage(oc, 0, 0);

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
        // comes around in SCAN_COOLDOWN_MS. Dropping `loading` back to false is
        // what reschedules it — the capture effect keys on `loading`.
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
          const up = document.createElement('canvas');
          const s = Math.min(1, SCAN_UPLOAD_W / framedCanvas.width);
          up.width = Math.round(framedCanvas.width * s);
          up.height = Math.round(framedCanvas.height * s);
          up.getContext('2d').drawImage(framedCanvas, 0, 0, up.width, up.height);
          const imageData = up.toDataURL('image/jpeg', 0.85);
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
                if (autoScan && confident && top?.name) {
                  const identified = top.name;
                  if (identified === lastQueuedNameRef.current) {
                    setScanStatus(t('scan.sameCardAgain'));
                    return;
                  }
                  setScanStatus('');
                  const outcome = await reviewQueue.submitScan({
                    name: identified,
                    // The RAW OCR text, not a parsed number. The server owns the
                    // parse (collectorNumberParse.js) and re-parsing it here
                    // would be a second, divergent implementation of the one
                    // rule that keeps a misread from becoming a wrong card.
                    ocrText: ocr?.raw || '',
                    // The server's rectified crop, so the queue shows the card
                    // he actually photographed rather than a catalogue image.
                    crop: crop || null,
                    quantity: 1,
                  });
                  if (scanId !== currentScanId.current) return;

                  if (outcome.action === 'added') {
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
                    await applyMatches([top.card], '', true);
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
      if (scanId === currentScanId.current) setScanStatus('Scan failed. Please search manually.');
    } finally {
      if (scanId === currentScanId.current) setLoading(false);
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
          <div className="camera-preview-wrapper camera-active">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="camera-video"
            />
            
            {/* Torch Toggle Overlay Button */}
            <button
                type="button"
                className={`btn ${isTorchOn ? 'btn-primary' : 'btn-secondary'}`}
                style={{
                  position: 'absolute',
                  top: '1rem',
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
              a crop/candidates, so an empty dashed box doesn't eat vertical space on phone. */}
          {cameraActive && (debugHashImg || debugCandidates.length > 0) && (
            <div className="glass-panel" style={{ width: '100%', padding: '0.75rem 1rem', background: 'rgba(0,0,0,0.3)', border: '1px dashed var(--border-glass-hover)', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.25rem' }}>
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
