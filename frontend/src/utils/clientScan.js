// Main-thread side of on-device Scan Cards (see clientScanWorker.js).
//
// One worker, one frame in flight. The frame is grabbed at the SAME ceiling the
// server path uploads (FRAME_MAX), because that is the resolution the pipeline
// was validated at against saved phone frames; the 384x384 copy for cornelius
// is scaled by the canvas (GPU) rather than in JS.
//
// Two phases per frame: corners first from the 384px copy, and only when there
// is a card does the full frame get read back (~8 MB at 1920x1080). Empty desk
// and hand-in-motion frames, which are most auto passes, never pay for it.
//
// Every worker call has a deadline. A worker that crashes or wedges is torn
// down and the next call gets a fresh one, so a single bad frame can never
// leave the scanner "busy" forever.
import { FRAME_MAX } from './fastScan';
export { needsServer } from './fastScan';
import { CORN_SIZE } from '../../../shared/clientScan/pipeline.mjs';
import { isNative, getServerUrl } from '../apiBase';

const LOAD_TIMEOUT_MS = 120000;   // first download of ~40 MB on a slow phone
const READ_TIMEOUT_MS = 8000;     // a normal read is well under 2 s
const LOAD_RETRY_MS = 30000;      // after a failed load, try again this much later

let worker = null;
let ready = null;          // Promise<{ok, loadMs, error}>
let readyFailedAt = 0;
let nextId = 1;
const waiting = new Map(); // id -> {resolve, timer}

function killWorker(reason) {
  if (worker) { worker.terminate(); worker = null; }
  for (const { resolve, timer } of waiting.values()) { clearTimeout(timer); resolve({ error: reason }); }
  waiting.clear();
  // The models lived in that worker; the next load must start over.
  ready = null;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./clientScanWorker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id); clearTimeout(w.timer);
    w.resolve(e.data);
  };
  worker.onerror = (e) => killWorker(e?.message || 'scan worker failed');
  return worker;
}

function call(msg, transfer = [], timeoutMs = READ_TIMEOUT_MS) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => killWorker('scan worker timed out'), timeoutMs);
    waiting.set(id, { resolve, timer });
    ensureWorker().postMessage({ ...msg, id }, transfer);
  });
}

// Where the worker fetches models and the index from. On the web that is this
// origin; in the native app it is the user's own server — the window.fetch shim
// in apiBase does not reach into workers, so it has to be passed explicitly.
function assetBase() {
  return isNative ? getServerUrl() : '';
}

// Start the one-time download. Resolves {ok:false} rather than throwing: a
// phone that cannot run it simply keeps the server scanner. A failure is
// retried after LOAD_RETRY_MS instead of being remembered until reload.
export function loadClientScan() {
  if (ready && readyFailedAt && Date.now() - readyFailedAt > LOAD_RETRY_MS) ready = null;
  if (!ready) {
    readyFailedAt = 0;
    const supported = typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined'
      && typeof DecompressionStream !== 'undefined' && (!isNative || !!getServerUrl());
    ready = !supported
      ? Promise.resolve({ ok: false, error: 'unsupported browser' })
      : call({ type: 'load', base: assetBase() }, [], LOAD_TIMEOUT_MS)
        .then(r => ({ ok: !!r.ready, loadMs: r.loadMs, error: r.error }));
    ready.then(r => { if (!r.ok) readyFailedAt = Date.now(); });
  }
  return ready;
}

let frameCanvas = null, smallCanvas = null;
// The quad of the card in the CURRENT frameCanvas, kept so a staged row can be
// cropped to the card afterwards. Cleared when a pass finds no card, so a crop
// can never be taken against a stale outline from a previous frame.
let lastQuad = null;
function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }
function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
// getImageData allocates every call; its buffer is transferred, never copied.
function pixels(ctx, w, h) { return ctx.getImageData(0, 0, w, h).data.buffer; }

// One capture -> probe -> read transaction at a time, module-wide. The canvases
// are shared, so a second scanner instance (remount) or an overlapping call
// must wait its turn rather than redraw the frame between the two phases.
let chain = Promise.resolve();
function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// Forget the tracked card and pooled footer evidence (auto stop/start).
export function resetOnDevice() {
  lastQuad = null;
  if (worker) worker.postMessage({ type: 'reset' });
}

// Read one frame on-device. Returns the pipeline's server-shaped output
// ({frame, candidates, results:[{ok, scryfallId, ...}]}), or {error}.
export function readOnDevice(source, sw, sh, opts = {}) {
  return serialized(() => readOnce(source, sw, sh, opts));
}

async function readOnce(source, sw, sh, { requireStill = false } = {}) {
  // Re-loads transparently if a crash or deadline tore the last worker down.
  const st = await loadClientScan();
  if (!st.ok) return { error: st.error || 'on-device reader unavailable' };
  const k = Math.min(1, FRAME_MAX / Math.max(sw, sh));
  const w = Math.round(sw * k), h = Math.round(sh * k);
  if (!frameCanvas || frameCanvas.width !== w || frameCanvas.height !== h) frameCanvas = canvas(w, h);
  if (!smallCanvas) smallCanvas = canvas(CORN_SIZE, CORN_SIZE);
  // Both canvases are drawn from the same video frame now, so the corners and
  // the pixels they are applied to can never come from different moments.
  const fc = ctx2d(frameCanvas); fc.drawImage(source, 0, 0, w, h);
  const sc = ctx2d(smallCanvas); sc.drawImage(source, 0, 0, CORN_SIZE, CORN_SIZE);
  const small = pixels(sc, CORN_SIZE, CORN_SIZE);
  const p = await call({ type: 'probe', small, w, h }, [small]);
  if (p.error) return { error: p.error };
  if (!p.quad) { lastQuad = null; return p.out; }   // no card: skip the full-frame readback
  lastQuad = p.quad;
  const frame = pixels(fc, w, h);
  const r = await call({ type: 'read', frame, w, h, quad: p.quad, requireStill }, [frame]);
  return r.error ? { error: r.error } : r.out;
}

// Server fallback wants a JPEG of the same frame the client just looked at.
export function lastFrameJpeg() {
  if (!frameCanvas) return null;
  if (frameCanvas.convertToBlob) return frameCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  return new Promise((res, rej) => frameCanvas.toBlob(b => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.88));
}

// The card the reader just looked at, as a small data URL for the staging
// review list.
//
// THE BUG THIS FIXES (Zach): "the cards added to the add review list now have
// no card image, why is that?" The old server path returned a crop with every
// match and the review row rendered it; the on-device path submitted
// `crop: null`, so every row drew an empty grey box. Forty rows of names with
// no way to tell which piece of cardboard each one was -- which is exactly
// what the crop is for when a printing looks wrong.
//
// Cropped to the card's own quad (with a small margin) rather than the whole
// frame, so the thumbnail is the CARD and not the table around it. Bounded
// hard: the backend rejects anything over 512KB, and a scan must never fail
// because its thumbnail was too big.
const CROP_W = 210;    // ~2.5x the 52x73 render box, so it stays sharp
const CROP_H = 294;
export function lastCardCrop() {
  if (!frameCanvas || !lastQuad) return null;
  try {
    const xs = lastQuad.map(p => p.x);
    const ys = lastQuad.map(p => p.y);
    const pad = 0.04;
    const x0 = Math.max(0, Math.min(...xs) - (Math.max(...xs) - Math.min(...xs)) * pad);
    const y0 = Math.max(0, Math.min(...ys) - (Math.max(...ys) - Math.min(...ys)) * pad);
    const x1 = Math.min(frameCanvas.width, Math.max(...xs) + (Math.max(...xs) - Math.min(...xs)) * pad);
    const y1 = Math.min(frameCanvas.height, Math.max(...ys) + (Math.max(...ys) - Math.min(...ys)) * pad);
    const w = x1 - x0, h = y1 - y0;
    if (!(w > 8 && h > 8)) return null;

    const c = document.createElement('canvas');
    c.width = CROP_W; c.height = CROP_H;
    c.getContext('2d').drawImage(frameCanvas, x0, y0, w, h, 0, 0, CROP_W, CROP_H);
    // 0.7 keeps a 210x294 JPEG around 10-15KB: well inside the server's limit
    // even for a long stack, and plenty for a 52px-wide thumbnail.
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    // A crop is a nicety; a scan is not. Never let this path throw.
    return null;
  }
}

// Turn on-device answers into card_cache rows (prices, image, set) via the
// backend, so the tray and Send flow see exactly what a server scan returns.
const hydrated = new Map();   // scryfallId -> hydrated result (auto passes re-see cards)
const HYDRATE_TIMEOUT_MS = 8000;
export async function hydrateResults(results, signal) {
  results = results.map(x => (x.ok && hydrated.has(x.scryfallId) ? { ...x, ...hydrated.get(x.scryfallId), number: x.number } : x));
  const hits = results.filter(r => r.ok && r.scryfallId && !r.card);
  if (!hits.length) return results;
  // Aborted with the scan, and never allowed to hold the scanner busy forever.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HYDRATE_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let r, j;
  try {
    r = await fetch('/api/cardscan/cards', {
      signal: ctl.signal,
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: hits.map(h => ({ number: h.number, scryfallId: h.scryfallId, title: h.title, via: h.via })) }),
    });
    // The body is part of the request: a stalled stream is still covered by
    // the deadline and the scan's abort.
    j = await r.json().catch((e) => { if (e?.name === 'AbortError') throw e; return {}; });
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  if (!r.ok || !j.ok) throw new Error(j.error || 'hydrate failed');
  const byNumber = new Map(j.results.map(x => [x.number, x]));
  for (const h of hits) { const x = byNumber.get(h.number); if (x?.ok && x.card) hydrated.set(h.scryfallId, x); }
  const out = results.map(x => (x.ok && byNumber.has(x.number) ? { ...x, ...byNumber.get(x.number) } : x));
  // A card the phone proved but the backend could not turn into a row is not
  // a result the tray can use. Throw so the caller takes the server path
  // instead of accepting an answer with nothing in it.
  if (out.some(x => x.scryfallId && !(x.ok && x.card))) throw new Error('hydrate incomplete');
  return out;
}
