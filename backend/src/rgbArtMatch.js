// PHASE 1b — rgbArt HASHING IN SHADOW MODE.
//
// Computes the rgbArt hash of a scanned photo and finds its nearest neighbours
// in the index built in Phase 1a. During Phase 1b the answer is LOGGED ONLY and
// never returned to the client: the whole point is to measure rgbArt against
// the live ORB path on Zach's real scans before trusting it with anything.
//
// TWO RULES THIS MODULE IS BUILT AROUND
//
// 1. IT CANNOT FAIL A SCAN. Every entry point is wrapped and returns null on
//    any error. Zach is holding a physical card; a measurement feature that can
//    break identification is worse than no measurement. This is the same
//    discipline as the SCAN_DUMP/SCAN_TRACE paths in collection.js.
//
// 2. IT CANNOT SLOW A SCAN NOTICEABLY. Loading is lazy and once; the scan is a
//    linear pass over 2.5MB of contiguous bytes. If the index is absent the
//    module disables itself permanently rather than retrying per request.
//
// WHY A LINEAR SCAN AND NOT AN ANN STRUCTURE. 51,424 x 48 bytes is 2.5MB —
// it fits in L2/L3 and a full pass is a few milliseconds, against a ~1.6s scan.
// An LSH or BK-tree would add a failure mode and a tuning parameter to save
// time that is already invisible. Revisit only if measurement says otherwise.
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ---- hashing --------------------------------------------------------------
// Must stay BIT-IDENTICAL to backend/scripts/build-hash-index.js. If the two
// ever diverge, every distance in the system is silently meaningless — so this
// is duplicated deliberately rather than imported: the build script runs on a
// different host and must not depend on server code.
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
  return vals.map((v) => (v > med ? 1 : 0));
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

async function rgbArtBits(buf) {
  return (await rgbHash(buf, 8, false)).concat(await rgbHash(buf, 8, true));
}

function packBits(bits) {
  const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) bytes[i >> 3] |= (128 >> (i & 7)); });
  return bytes;
}

// ---- index ----------------------------------------------------------------
const POP = new Uint8Array(256);
for (let i = 0; i < 256; i++) POP[i] = (i.toString(2).match(/1/g) || []).length;

let state = null;   // null = not tried, false = unavailable, object = loaded

function indexPath() {
  return process.env.RGBART_INDEX
    || path.join(__dirname, '../../hash-index/rgbart-index.bin');
}

function load() {
  if (state !== null) return state;
  try {
    const p = indexPath();
    if (!fs.existsSync(p)) { state = false; return state; }
    const buf = fs.readFileSync(p);
    const hlen = buf.readUInt32LE(0);
    const header = JSON.parse(buf.slice(4, 4 + hlen).toString('utf8'));
    const hashes = buf.slice(4 + hlen);
    const bph = header.bytesPerHash;
    if (hashes.length !== header.count * bph) throw new Error('index size mismatch');
    state = { header, hashes, bph, count: header.count };
    console.log(`rgbArt index loaded: ${header.count} artworks, ${header.bits} bits, built ${header.built}`);
  } catch (e) {
    console.warn('rgbArt index unavailable:', e.message);
    state = false;    // permanent: do not retry per request
  }
  return state;
}

// Nearest K by Hamming distance. One linear pass, no allocation per row.
function nearest(queryBuf, k = 3) {
  const st = load();
  if (!st) return null;
  const { hashes, bph, count, header } = st;
  // A tiny insertion-sorted top-K beats sorting 51k results when k is 3.
  const bestD = new Int32Array(k).fill(0x7fffffff);
  const bestI = new Int32Array(k).fill(-1);
  for (let r = 0; r < count; r++) {
    const off = r * bph;
    let d = 0;
    for (let b = 0; b < bph; b++) d += POP[queryBuf[b] ^ hashes[off + b]];
    if (d >= bestD[k - 1]) continue;
    let j = k - 1;
    while (j > 0 && bestD[j - 1] > d) { bestD[j] = bestD[j - 1]; bestI[j] = bestI[j - 1]; j--; }
    bestD[j] = d; bestI[j] = r;
  }
  const out = [];
  for (let i = 0; i < k; i++) {
    if (bestI[i] < 0) continue;
    const c = header.cards[bestI[i]];
    out.push({ name: c.n, set: c.s, number: c.c, id: c.i, key: c.k, dist: bestD[i] });
  }
  return out;
}

// ---- public ---------------------------------------------------------------
// Returns null on ANY failure. Callers must treat null as "no opinion" and
// carry on; nothing here is allowed to change what the user sees in Phase 1b.
async function identify(rectifiedBuf, k = 3) {
  try {
    if (!rectifiedBuf) return null;
    if (!load()) return null;
    const t0 = Date.now();
    const q = packBits(await rgbArtBits(rectifiedBuf));
    const hits = nearest(q, k);
    if (!hits || !hits.length) return null;
    // CONFIDENCE = SEPARATION, not an absolute threshold (plan S2.2). A hit at
    // 40 bits is trustworthy if the runner-up is at 90 and worthless if the
    // runner-up is at 42. The margin is what carries information.
    const margin = hits.length > 1 ? hits[1].dist - hits[0].dist : null;
    return { top: hits[0], hits, margin, ms: Date.now() - t0 };
  } catch (e) {
    console.warn('rgbArt identify failed:', e.message);
    return null;
  }
}

function available() { return !!load(); }

module.exports = { identify, available, rgbArtBits, packBits, nearest, _reset: () => { state = null; } };
