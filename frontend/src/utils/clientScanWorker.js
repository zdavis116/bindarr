// On-device card reading for the scanner, off the main thread.
//
// Runs shared/clientScan/pipeline.mjs -- the same module
// backend/scripts/client-scan-replay.mjs validates against Zach's 271 labelled
// frames. Models and the title/printing index are fetched once from
// /scan-assets/ and kept in the Cache API, so a returning phone starts reading
// without touching the network.
//
// ORT IS A BUNDLED IMPORT, EXACTLY AS UPSTREAM DOES IT.
//
// I originally deviated here: this repo already vendored an onnxruntime build
// at /models/ for the old card detector, so reusing it looked like the tidy
// choice -- one runtime, no new dependency, no second 13.5 MB wasm.
//
// It did not work. `await import('/models/ort.webgpu.min.mjs')` inside a
// module worker fails with "Failed to resolve module specifier", because a
// worker resolves bare/absolute specifiers against its own module scope, not
// the page. The reader therefore never loaded, every scan fell through to the
// server, and the symptom Zach saw was "always says no confident match" and
// then "stuck on scanner is still loading".
//
// Zach: "If scrybox's scanning works why isn't ours because we should be using
// identical code. How many times do I have to say it?" -- and he is right. The
// one place I chose not to copy them is the one place that broke. A static
// import is resolved by the bundler at build time, so there is no runtime
// specifier to fail.
//
// scripts/copy-ort.mjs stages the wasm into public/ort (prebuild + predev) and
// the vite `onnxruntime-web-use-extern-wasm` condition keeps a single copy of
// it in the build.
import * as ort from 'onnxruntime-web/wasm';
import { createReader } from '../../../shared/clientScan/pipeline.mjs';
import { buildCharset, loadIndex } from '../../../shared/clientScan/text.mjs';

ort.env.wasm.wasmPaths = '/ort/';
// One thread: there is no COOP/COEP on a self-hosted tailnet origin, so
// SharedArrayBuffer is unavailable and asking for threads fails confusingly
// rather than obviously.
ort.env.wasm.numThreads = 1;

// Set from the load message: '' on the web (same origin), the user's server URL
// in the native app, where relative paths would resolve inside the app bundle.
let ORIGIN = '';
const BASE = '/scan-assets/';
const CACHE = 'bindarr-scan-assets';
let readerPromise = null;
let pendingReset = false;

async function cachedBytes(cache, url) {
  let res = cache ? await cache.match(url) : null;
  if (!res) {
    res = await fetch(ORIGIN + url);
    const type = res.headers.get('content-type') || '';
    // An SPA serves index.html for an unknown path, so a missing asset arrives
    // as a cheerful 200 of HTML. Without this check that HTML reaches
    // InferenceSession.create as a "model" and fails with a protobuf error
    // that names nothing.
    if (!res.ok || type.includes('text/html')) throw new Error(`${url} not served (${res.status})`);
    if (cache) await cache.put(url, res.clone()).catch(() => {});
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function gunzip(bytes) {
  // Served as a .gz FILE (not Content-Encoding), so the browser does not
  // transparently decompress it; that happens here.
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function load() {
  const t0 = performance.now();
  // Revalidated, not refetched: a returning phone gets a 304 on the manifest
  // and then reads every hashed asset straight out of the Cache API.
  const manifest = await (await fetch(`${ORIGIN}${BASE}manifest.json`, { cache: 'no-cache' })).json();
  const urls = [manifest.index, manifest.rec, manifest.dict].map(n => BASE + n);
  const cache = typeof caches !== 'undefined' ? await caches.open(CACHE).catch(() => null) : null;
  if (cache) {
    // Drop assets a newer manifest no longer names, so a rebuilt index does not
    // leave the old one pinned in the cache forever.
    for (const req of await cache.keys()) {
      if (!urls.includes(new URL(req.url).pathname)) cache.delete(req);
    }
  }
  const [indexGz, recBytes, dictBytes, cornBytes] = await Promise.all([
    cachedBytes(cache, urls[0]), cachedBytes(cache, urls[1]), cachedBytes(cache, urls[2]),
    cachedBytes(cache, `${BASE}cornelius.onnx`),
  ]);

  // WASM only. WebGPU is faster for a single big model, but this pipeline runs
  // many small recognizer batches per card and the per-run WebGPU overhead
  // dominates; the wasm path is also the one the corpus replay measured.
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const [rec, cornelius] = await Promise.all([
    ort.InferenceSession.create(recBytes, opts),
    ort.InferenceSession.create(cornBytes, opts),
  ]);
  const index = loadIndex(JSON.parse(await gunzip(indexGz)));
  const chars = buildCharset(new TextDecoder().decode(dictBytes));
  const reader = createReader({ ort, cornelius, rec, chars, index });
  return { reader, loadMs: Math.round(performance.now() - t0) };
}

self.onmessage = async (e) => {
  const { type, id } = e.data;
  if (type === 'load') {
    ORIGIN = e.data.base || '';
    readerPromise ||= load();
    try {
      const { loadMs } = await readerPromise;
      self.postMessage({ id, ready: true, loadMs });
    } catch (err) {
      readerPromise = null;
      self.postMessage({ id, ready: false, error: err?.message || String(err) });
    }
    return;
  }
  // Applied at the start of the next read rather than immediately, so a read
  // still in flight when auto restarts cannot repopulate state afterwards.
  if (type === 'reset') { pendingReset = true; return; }

  // Phase 1: corners from the 384px copy. When there is no card this is the
  // whole answer, and the main thread never reads back the full frame.
  if (type === 'probe') {
    const { small, w, h } = e.data;
    try {
      if (!readerPromise) throw new Error('reader not loaded');
      const { reader } = await readerPromise;
      if (pendingReset) { pendingReset = false; reader.reset(); }
      const quad = await reader.probe(new Uint8ClampedArray(small), 4, w, h);
      const out = quad ? null : { ok: true, engine: 'client', frame: { width: w, height: h }, candidates: [], results: [], timings: {} };
      self.postMessage({ id, quad, out, small }, [small]);
    } catch (err) {
      self.postMessage({ id, error: err?.message || String(err), small }, [small]);
    }
    return;
  }

  // Phase 2: the full read, reusing the corners phase 1 found for this frame.
  if (type === 'read') {
    const { frame, w, h, quad, requireStill } = e.data;
    try {
      if (!readerPromise) throw new Error('reader not loaded');
      const { reader } = await readerPromise;
      const out = await reader.read(
        { data: new Uint8ClampedArray(frame), width: w, height: h },
        null, { requireStill, quad });
      self.postMessage({ id, out, frame }, [frame]);
    } catch (err) {
      self.postMessage({ id, error: err?.message || String(err), frame }, [frame]);
    }
  }
};
