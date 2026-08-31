// PHASE 1a — BUILD THE rgbArt HASH INDEX.
//
// Produces the artefact the whole rebuild rests on: one 378-bit perceptual hash
// per card artwork, for every PAPER Magic card.
//
// THREE DECISIONS, each measured rather than assumed (see SCANNER_REBUILD_PLAN.md):
//
// 1. game:paper ONLY. This filter is LOAD-BEARING, not housekeeping. Every one
//    of the 17 hash collisions observed in testing was an Arena rebalanced card
//    ('A-Elven Bow' vs 'Elven Bow') — digital-only variants that reuse the paper
//    artwork with tweaked rules text. They cannot be physically scanned. With
//    them excluded, ZERO pairs collided within photo-noise range.
//
// 2. DEDUPE BY illustration_id. Recall's job is the CARD; the collector number
//    picks the printing. Printings sharing artwork share a hash, so storing one
//    row per artwork shrinks the index ~3x (104,535 printings -> ~35k artworks)
//    and removes collisions that are harmless by construction.
//
// 3. rgbArt = RGB hash of the WHOLE CARD ++ RGB hash of the ART BOX. Measured
//    against Zach's real photos: greyscale 7/12, rgb-whole-card 10/12,
//    rgbArt 12/12 with the widest confidence margin of any method tried.
//
// Run on a host that can reach the Scryfall CDN. The dev box cannot, and has no
// local image cache — the finished index ships to it, images never do.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const sharp = require('sharp');

const OUT = process.env.HASH_INDEX_OUT || path.join(__dirname, '../../hash-index');
const LIMIT = process.env.HASH_LIMIT ? Number(process.env.HASH_LIMIT) : Infinity;
const CONCURRENCY = 6;
const UA = 'Bindarr/1.0 (collection manager; contact via github zdavis116/bindarr)';

// ---- the hash -------------------------------------------------------------
function dct1d(v) {
  const N = v.length, out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += v[n] * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
    out[k] = s;
  }
  return out;
}
function dctPlane(plane, N, side) {
  const rows = [];
  for (let y = 0; y < N; y++) {
    const row = new Float64Array(N);
    for (let x = 0; x < N; x++) row[x] = plane[y * N + x];
    rows.push(dct1d(row));
  }
  const cols = [];
  for (let x = 0; x < N; x++) {
    const col = new Float64Array(N);
    for (let y = 0; y < N; y++) col[y] = rows[y][x];
    cols.push(dct1d(col));
  }
  const vals = [];
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) if (x || y) vals.push(cols[x][y]);
  const s = [...vals].sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  return vals.map(v => (v > med ? 1 : 0));
}
async function rgbHash(buf, side, artOnly) {
  const N = side * 4;
  let img = sharp(buf);
  if (artOnly) {
    const m = await sharp(buf).metadata();
    img = sharp(buf).extract({
      left: Math.round(m.width * 0.08), top: Math.round(m.height * 0.11),
      width: Math.round(m.width * 0.84), height: Math.round(m.height * 0.43),
    });
  }
  const { data } = await img.removeAlpha().normalise().resize(N, N, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  let out = [];
  for (let c = 0; c < 3; c++) {
    const p = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) p[i] = data[i * 3 + c];
    out = out.concat(dctPlane(p, N, side));
  }
  return out;
}
async function rgbArt(buf) {
  return (await rgbHash(buf, 8, false)).concat(await rgbHash(buf, 8, true));
}
// 378 bits -> 48 bytes. Packing matters: at ~35k cards this is the difference
// between a 1.7MB download and a 13MB one.
function packBits(bits) {
  const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) bytes[i >> 3] |= (128 >> (i & 7)); });
  return bytes;
}

// ---- fetching -------------------------------------------------------------
function get(url, asJson) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, Accept: asJson ? 'application/json' : '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, asJson));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url.slice(0, 80)}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(asJson ? JSON.parse(buf.toString('utf8')) : buf);
      });
    }).on('error', reject);
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const bulkPath = path.join(OUT, 'default_cards.json');

  if (!fs.existsSync(bulkPath)) {
    console.log('fetching Scryfall bulk index...');
    const meta = await get('https://api.scryfall.com/bulk-data', true);
    const entry = meta.data.find((d) => d.type === 'default_cards');
    // Scryfall now serves JSONL (one card per line), gzipped, and exposes it as
    // `jsonl_download_uri` with `compressed_size`. The older `download_uri` +
    // `size` fields are gone — reading them yielded 'NaN MB' and an undefined
    // URL. Prefer JSONL, fall back to the legacy field if it ever returns.
    const uri = entry.jsonl_download_uri || entry.download_uri;
    const mb = (entry.compressed_size || entry.size || 0) / 1e6;
    console.log(`downloading default_cards (${mb.toFixed(0)} MB compressed)...`);
    fs.writeFileSync(bulkPath, await get(uri, false));
  }
  console.log('parsing bulk data...');
  // STREAM IT. The decompressed JSONL is >512MB, which exceeds Node's maximum
  // string length (0x1fffffe8) — reading it into one string throws. Stream the
  // gunzip and parse line by line, keeping peak memory flat and never
  // materialising the whole file as a string.
  const all = await new Promise((resolve, reject) => {
    const cards = [];
    let tail = '';
    const src = fs.createReadStream(bulkPath);
    const head = Buffer.alloc(2);
    const fd = fs.openSync(bulkPath, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    const stream = (head[0] === 0x1f && head[1] === 0x8b) ? src.pipe(zlib.createGunzip()) : src;
    stream.on('data', (chunk) => {
      const text = tail + chunk.toString('utf8');
      const lines = text.split('\n');
      tail = lines.pop();
      for (const line of lines) {
        const t = line.trim().replace(/,$/, '');
        if (!t || t === '[' || t === ']') continue;
        try { cards.push(JSON.parse(t)); } catch { /* partial line, skipped */ }
      }
    });
    stream.on('end', () => {
      const t = tail.trim().replace(/,$/, '');
      if (t && t !== ']') { try { cards.push(JSON.parse(t)); } catch { /* trailing */ } }
      resolve(cards);
    });
    stream.on('error', reject);
  });
  console.log(`  ${all.length} total printings`);

  // THE FILTER. See decision 1 above — this removed 100% of observed collisions.
  const paper = all.filter((c) => Array.isArray(c.games) && c.games.includes('paper'));
  console.log(`  ${paper.length} paper printings (dropped ${all.length - paper.length} digital-only)`);

  // THE DEDUPE. See decision 2 — one row per artwork, not per printing.
  const byArt = new Map();
  for (const c of paper) {
    const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal;
    if (!img) continue;
    const key = c.illustration_id || c.card_faces?.[0]?.illustration_id || c.id;
    if (!byArt.has(key)) {
      byArt.set(key, { key, id: c.id, name: c.name, set: c.set, number: c.collector_number, img });
    }
  }
  let targets = [...byArt.values()];
  if (Number.isFinite(LIMIT)) targets = targets.slice(0, LIMIT);
  console.log(`  ${targets.length} distinct artworks to hash\n`);

  const rows = [];
  let done = 0, failed = 0;
  const t0 = Date.now();
  const queue = [...targets];

  async function worker() {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      try {
        const bits = await rgbArt(await get(c.img, false));
        rows.push({ ...c, hash: packBits(bits).toString('base64') });
      } catch (e) {
        failed++;
        if (failed <= 5) console.warn(`  fail ${c.name}: ${e.message.slice(0, 60)}`);
      }
      done++;
      if (done % 500 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = ((targets.length - done) / rate / 60).toFixed(0);
        console.log(`  ${done}/${targets.length}  ${rate.toFixed(1)}/s  eta ${eta}m  (${failed} failed)`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const outFile = path.join(OUT, 'rgbart-index.json');
  fs.writeFileSync(outFile, JSON.stringify({
    version: 1, bits: 378, built: new Date().toISOString(), count: rows.length, cards: rows,
  }));
  const mb = fs.statSync(outFile).size / 1e6;
  console.log(`\n${rows.length} hashed, ${failed} failed`);
  console.log(`-> ${outFile}  (${mb.toFixed(1)} MB raw)`);
}

main().catch((e) => { console.error('BUILD FAILED', e.message); process.exit(1); });
