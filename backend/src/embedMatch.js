// Server-side card identification by CLIP image embedding.
//
// Loads the precomputed per-game embedding DB (backend/data/{game}-embed.bin +
// -meta.json, built by scripts/build-card-embeddings.mjs) and the CLIP encoder,
// then matches an uploaded card image against every card by cosine similarity.
//
// @huggingface/transformers is ESM-only, so it is imported lazily via dynamic
// import(). Model + DBs are cached singletons; the first match() pays the load.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DATA_DIR = process.env.INDEX_DATA_DIR || path.join(__dirname, '..', 'data');

let tfPromise = null;      // resolves to { pipeline, RawImage }
let extractorPromise = null;
const dbs = {};            // game -> { vecs: Float32Array, cards, n, dim } | null

// WHERE THE CLIP MODEL LIVES. Set once, before any pipeline is created.
//
// THE BUG THIS FIXES. On the dev box pipeline() hung forever and every scan
// silently fell through to ORB alone: the machine cannot reach huggingface.co,
// so the ~336MB vision model never arrived. transformers.js does NOT read
// TRANSFORMERS_CACHE or HF_HOME — those are the Python library's variables. It
// reads env.cacheDir / env.localModelPath at call time, so pointing it at a
// pre-fetched copy has to be done in code.
//
// MODEL_DIR is deliberately outside the deploy tree (/var/lib/... rather than
// /opt/bindarr-dev) so a deploy cannot wipe a 336MB download, and so a fresh
// checkout does not silently start reaching for the network again.
//
// WHY NOT THE 89MB QUANTIZED MODEL. Measured: a q8 embedding of a real scan has
// cosine 0.932 against the fp32 embedding of the same image. The card index was
// built with fp32, so q8 would be looking up vectors that do not line up with
// it — recall would degrade quietly on the exact subsystem this is fixing. A
// 4x smaller download is not worth an invisible accuracy loss. If the q8 model
// is ever wanted, the index has to be rebuilt with it.
function configureModelSource(env) {
  const dir = process.env.MODEL_DIR;
  if (!dir) return;                       // no override: behave exactly as before
  env.cacheDir = dir;
  env.localModelPath = dir;
  // Still allow remote as a fallback: a machine that CAN reach the hub should
  // not be broken by an incomplete local copy.
  env.allowLocalModels = true;
}

function loadTransformers() {
  if (!tfPromise) {
    tfPromise = import('@huggingface/transformers').then((tf) => {
      try { configureModelSource(tf.env); } catch { /* older build without env */ }
      return tf;
    });
  }
  return tfPromise;
}

// Load a game's embedding DB from disk once. Returns null if not built yet.
function loadDb(game) {
  if (game in dbs) return dbs[game];
  const binPath = path.join(DATA_DIR, `${game}-embed.bin`);
  const metaPath = path.join(DATA_DIR, `${game}-embed-meta.json`);
  if (!fs.existsSync(binPath) || !fs.existsSync(metaPath)) { dbs[game] = null; return null; }
  const meta = JSON.parse(fs.readFileSync(metaPath));
  const buf = fs.readFileSync(binPath);
  // Copy into an aligned Float32Array (fs Buffer may not be 4-byte aligned).
  const vecs = new Float32Array(buf.length / 4);
  Buffer.from(vecs.buffer).set(buf);
  dbs[game] = { vecs, cards: meta.cards, n: meta.cards.length, dim: meta.dim, model: meta.model };
  console.log(`embedMatch: loaded ${game} DB (${meta.cards.length} cards, dim ${meta.dim})`);
  return dbs[game];
}

async function getExtractor(model) {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await loadTransformers();
      console.log(`embedMatch: loading model ${model}...`);
      const t0 = Date.now();
      const p = await pipeline('image-feature-extraction', model);
      console.log(`embedMatch: model ready in ${Date.now() - t0}ms`);
      return p;
    })().catch((e) => {
      // A FAILED MODEL LOAD MUST BE LOUD, AND MUST NOT BE CACHED AS A REJECTION.
      //
      // THE BUG THIS EXISTS FOR. On the dev box this pipeline() call hangs
      // forever: the machine cannot reach huggingface.co, so the ~336MB vision
      // model never arrives. match() then returned an empty array, scanMatch
      // treated "no recall candidates" as a normal outcome, and the whole scan
      // silently fell through to ORB alone.
      //
      // ORB IS A VERIFIER, NOT A SEARCH ENGINE. It is meant to confirm which of
      // ~24 CLIP candidates geometrically matches. Made to search all 57,583
      // cards it is slow and it confuses cards with similar composition —
      // exactly the H.E.R.B.I.E. Scout Unit / Jeskai Windscout mix-up Zach hit,
      // and exactly the "GLOBAL search (not scoped to a set)" line in his
      // diagnostics.
      //
      // So the scanner has been running on half an architecture, and it looked
      // like a tuning problem for a very long time because nothing ever said
      // recall was down. A pipeline that quietly degrades to a worse algorithm
      // is indistinguishable from one that is merely badly tuned.
      console.error(
        `embedMatch: CLIP MODEL FAILED TO LOAD (${model}): ${e.message}\n` +
        '  Recall is DOWN. Every scan will fall back to ORB searching the whole\n' +
        '  catalogue, which is slower and confuses similar-looking cards.\n' +
        '  Fix: make the model available locally (see TRANSFORMERS_CACHE).');
      extractorPromise = null;   // let the next scan retry rather than fail forever
      throw e;
    });
  }
  return extractorPromise;
}

// L2-normalized embedding of an image Buffer (shape-robust; mirrors the build).
async function embedImage(imageBuffer, model) {
  const { RawImage } = await loadTransformers();
  const extractor = await getExtractor(model);
  const { data, info } = await sharp(imageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
  const out = await extractor(img, { pooling: 'mean', normalize: true });
  let v = out.tolist();
  while (Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && Array.isArray(v[0][0])) v = v[0];
  if (Array.isArray(v) && v.length === 1) v = v[0];
  if (Array.isArray(v[0])) {
    const D = v[0].length, m = new Float32Array(D);
    for (const row of v) for (let i = 0; i < D; i++) m[i] += row[i] / v.length;
    v = Array.from(m);
  }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return Float32Array.from(v.map(x => x / n));
}

// Match an image against a game's DB. Returns up to topK
// [{ name, set, number, score }] sorted by descending cosine (1 = identical),
// or [] if the DB isn't built. Both query and DB vectors are unit-length, so
// cosine is a plain dot product.
async function match(imageBuffer, game, topK = 8) {
  const db = loadDb(game);
  if (!db) return [];
  const q = await embedImage(imageBuffer, db.model);
  if (q.length !== db.dim) throw new Error(`embedding dim mismatch: query ${q.length} vs db ${db.dim}`);

  const { vecs, cards, n, dim } = db;
  const best = []; // ascending by score, length <= topK
  for (let r = 0; r < n; r++) {
    const base = r * dim;
    let s = 0;
    for (let d = 0; d < dim; d++) s += q[d] * vecs[base + d];
    if (best.length < topK || s > best[0].score) {
      const row = cards[r];
      const cand = { name: row[0], set: row[1], number: row[2], score: s };
      let pos = 0;
      while (pos < best.length && best[pos].score < s) pos++;
      best.splice(pos, 0, cand);
      if (best.length > topK) best.shift();
    }
  }
  return best.reverse(); // descending: closest first
}

// Evict a game's cached embedding DB so the next match reloads from disk.
// Called after a global rebuild swaps in fresh files.
function reload(game) { delete dbs[game]; }

module.exports = { match, reload };
