// Build the artwork catalogue the SERVER fallback searches, from this
// instance's own card_cache.
//
// WHY THIS EXISTS. cvScan identifies a card by comparing its artwork
// embedding against a catalogue of every printing's embedding. That catalogue
// currently comes from a PUBLISHED milo .npz -- a 2026-07-09 snapshot. It
// cannot know about anything printed since, and a card missing from it cannot
// be identified by the fallback no matter how good the photo is.
//
// Measured against Zach's collection on 2026-09-27:
//   121 of his 2,334 cards are missing from the published catalogue
//     hob  93   The Hobbit
//     fra  27   Final Fantasy  <- cards he scanned THIS WEEK
//     hoc   1
// The gap grows with every new set. Building locally from card_cache tracks
// his actual collection instead.
//
// Adapted from scrybox's backend/src/catalog.js. Its two dependencies we lack
// -- cardSets and a LANGUAGES table -- are both for the fetch stage and the
// multi-language catalogues; this fork is English-only MTG and its card_cache
// is already populated, so only the EMBED stage is ported.
//
// OUTPUT is the same shape cvScan already loads for a local catalogue:
//   milo-mtg-local.bin    float32 embeddings, n x 128, L2-normalised
//   milo-mtg-local.json   { ids, n, dim, built, source }
//
// RESUMABLE BY DESIGN. 106k artwork downloads is hours of work and something
// will interrupt it. Progress is flushed every FLUSH_EVERY cards, and a rerun
// skips ids already embedded -- so an interrupted build resumes rather than
// restarting.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MODEL_DIR = process.env.CV_MODEL_DIR;
const DB_PATH = process.env.DB_PATH;
const CONCURRENCY = Number(process.env.CATALOG_CONCURRENCY || 6);
const FLUSH_EVERY = 500;
const EMBED_SIZE = 224;
const DIM = 128;

if (!MODEL_DIR) { console.error('CV_MODEL_DIR must be set'); process.exit(2); }
if (!DB_PATH || !fs.existsSync(DB_PATH)) {
  console.error(`DB_PATH must point at a real database (got: ${DB_PATH || 'unset'})`);
  process.exit(2);
}

const binPath = path.join(MODEL_DIR, 'milo-mtg-local.bin');
const metaPath = path.join(MODEL_DIR, 'milo-mtg-local.json');
const miloPath = path.join(MODEL_DIR, 'milo.onnx');
if (!fs.existsSync(miloPath)) {
  console.error(`milo.onnx not found in ${MODEL_DIR}; run fetch-scan-models first`);
  process.exit(2);
}

const require_ = (await import('node:module')).createRequire(import.meta.url);
const sqlite3 = require_('sqlite3');
const ort = require_('onnxruntime-node');
const sharp = require_('sharp');

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
const all = (sql, args = []) => new Promise((res, rej) =>
  db.all(sql, args, (e, r) => (e ? rej(e) : res(r))));

// Resume: which ids are already embedded?
let existingIds = [];
let existingVecs = null;
if (fs.existsSync(metaPath) && fs.existsSync(binPath)) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const buf = fs.readFileSync(binPath);
    const expect = meta.ids.length * DIM * 4;
    // A truncated .bin means the last run died mid-flush. Trust the SHORTER of
    // the two rather than the metadata: reading past the end would hand cvScan
    // uninitialised memory as an embedding, which is a wrong card, not a crash.
    if (buf.length >= expect) {
      existingIds = meta.ids;
      existingVecs = new Float32Array(buf.buffer, buf.byteOffset, meta.ids.length * DIM);
      console.log(`resuming: ${existingIds.length} cards already embedded`);
    } else {
      const usable = Math.floor(buf.length / (DIM * 4));
      existingIds = meta.ids.slice(0, usable);
      existingVecs = new Float32Array(buf.buffer, buf.byteOffset, usable * DIM);
      console.log(`resuming from a truncated build: ${usable} of ${meta.ids.length} usable`);
    }
  } catch (e) {
    console.log('could not read the previous build, starting fresh:', e.message);
    existingIds = []; existingVecs = null;
  }
}
const done = new Set(existingIds);

const rows = await all(
  `SELECT id, image_url FROM card_cache
    WHERE image_url IS NOT NULL AND image_url != ''
    ORDER BY id`);
const todo = rows.filter(r => !done.has(r.id));
console.log(`card_cache: ${rows.length} printings with artwork`);
console.log(`to embed   : ${todo.length}`);
if (!todo.length) { console.log('nothing to do'); db.close(); process.exit(0); }

const session = await ort.InferenceSession.create(miloPath, {
  executionProviders: ['cpu'], graphOptimizationLevel: 'all',
});

// Accumulate into plain arrays; flushed to disk periodically.
const ids = [...existingIds];
const vecs = [];
if (existingVecs) vecs.push(existingVecs);

const flush = () => {
  const total = ids.length;
  const out = new Float32Array(total * DIM);
  let off = 0;
  for (const chunk of vecs) { out.set(chunk, off); off += chunk.length; }
  // Write to a temp file and rename: a crash mid-write must not leave a
  // half-written .bin that the resume logic would read as complete.
  fs.writeFileSync(`${binPath}.tmp`, Buffer.from(out.buffer, 0, total * DIM * 4));
  fs.renameSync(`${binPath}.tmp`, binPath);
  fs.writeFileSync(`${metaPath}.tmp`, JSON.stringify({
    game: 'mtg', lang: 'English', dim: DIM, n: total, ids,
    built: new Date().toISOString(), source: 'card_cache',
  }));
  fs.renameSync(`${metaPath}.tmp`, metaPath);
};

async function embedOne(row) {
  const resp = await fetch(row.image_url, { signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const { data } = await sharp(buf)
    .resize(EMBED_SIZE, EMBED_SIZE, { fit: 'fill' })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // HWC uint8 -> CHW float32, same normalisation cvScan uses at scan time. A
  // mismatch here would not throw; it would just make every comparison wrong.
  const x = new Float32Array(3 * EMBED_SIZE * EMBED_SIZE);
  const plane = EMBED_SIZE * EMBED_SIZE;
  for (let i = 0; i < plane; i++) {
    x[i] = data[i * 3] / 255;
    x[plane + i] = data[i * 3 + 1] / 255;
    x[2 * plane + i] = data[i * 3 + 2] / 255;
  }
  const t = new ort.Tensor('float32', x, [1, 3, EMBED_SIZE, EMBED_SIZE]);
  const out = await session.run({ [session.inputNames[0]]: t });
  const v = out[session.outputNames[0]].data;
  // L2-normalise so a dot product IS cosine similarity, which is what cvScan
  // assumes when it compares scores against STRONG_SIM.
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const unit = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) unit[i] = v[i] / n;
  return unit;
}

let ok = 0, failed = 0, sinceFlush = 0;
const t0 = Date.now();
for (let i = 0; i < todo.length; i += CONCURRENCY) {
  const batch = todo.slice(i, i + CONCURRENCY);
  const results = await Promise.allSettled(batch.map(embedOne));
  for (let k = 0; k < batch.length; k++) {
    const r = results[k];
    if (r.status === 'fulfilled') {
      ids.push(batch[k].id); vecs.push(r.value); ok++; sinceFlush++;
    } else {
      // A card whose art will not download is SKIPPED, not fatal. It simply
      // stays unidentifiable by the fallback, exactly as it is today.
      failed++;
      if (failed <= 10) console.warn(`  skip ${batch[k].id}: ${r.reason?.message || r.reason}`);
    }
  }
  if (sinceFlush >= FLUSH_EVERY) {
    flush(); sinceFlush = 0;
    const rate = ok / ((Date.now() - t0) / 1000);
    const left = todo.length - ok - failed;
    console.log(`  ${ok}/${todo.length} embedded (${rate.toFixed(1)}/s, ~${Math.round(left / rate / 60)}min left)`);
  }
}
flush();
db.close();

const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\ndone: ${ids.length} cards in the catalogue (${ok} new, ${failed} skipped) in ${mins}min`);
console.log(`  ${binPath}`);
console.log(`  ${metaPath}`);
console.log('\nRestart the app to pick it up: cvScan prefers the local catalogue.');
