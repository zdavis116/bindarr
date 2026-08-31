// EQUIVALENCE TEST — the runtime hash must match the build-script hash exactly.
//
// rgbArtMatch.js deliberately duplicates the hashing code from
// build-hash-index.js (the build script runs on another host and must not
// depend on server code). Duplication invites drift, and drift here is
// SILENT: every Hamming distance in the system would still compute, still look
// plausible, and mean nothing. So the duplication is pinned by this test.
//
// The check is not "similar" — it is byte-for-byte identity of the packed hash.
'use strict';

const assert = require('assert');
const sharp = require('sharp');
const rgbArt = require('../src/rgbArtMatch');

// Reimplement the BUILD SCRIPT's hash here, copied from
// backend/scripts/build-hash-index.js. If someone edits one side, this diverges
// and the test fails loudly instead of the system going quietly wrong.
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
async function buildScriptHash(buf) {
  return (await rgbHash(buf, 8, false)).concat(await rgbHash(buf, 8, true));
}

// Deterministic synthetic cards. Real card images are not in the repo, and this
// test asserts agreement between two implementations, which any image exercises
// equally well.
async function synthCard(seed) {
  const w = 488, h = 680;
  const px = Buffer.alloc(w * h * 3);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Blocky regions, so the art-box crop sees different content from the frame.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const block = ((x / 40) | 0) + ((y / 40) | 0) * 13 + seed;
      px[i] = (block * 37) % 256;
      px[i + 1] = (block * 91) % 256;
      px[i + 2] = (block * 143) % 256;
    }
  }
  for (let n = 0; n < 400; n++) {
    const i = ((rnd() * h | 0) * w + (rnd() * w | 0)) * 3;
    px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
  }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

(async () => {
  let n = 0;
  for (const seed of [1, 2, 3, 42, 9999]) {
    const buf = await synthCard(seed);
    const a = rgbArt.packBits(await rgbArt.rgbArtBits(buf));
    const b = rgbArt.packBits(await buildScriptHash(buf));
    assert.strictEqual(a.length, 48, `packed hash must be 48 bytes, got ${a.length}`);
    assert.ok(a.equals(b),
      `HASH DRIFT on seed ${seed}: runtime and build script disagree.\n` +
      `  runtime: ${a.toString('base64')}\n  build:   ${b.toString('base64')}`);
    n++;
  }

  // 378 bits of signal in 48 bytes (384 bits) -- the last 6 are padding and
  // must be zero, or a stale/garbage tail would perturb every distance.
  const buf = await synthCard(7);
  const bits = await rgbArt.rgbArtBits(buf);
  assert.strictEqual(bits.length, 378, `expected 378 bits, got ${bits.length}`);
  const packed = rgbArt.packBits(bits);
  assert.strictEqual(packed[47] & 0b00111111, 0, 'padding bits must be zero');

  // A hash must be stable across calls, or nothing downstream is reproducible.
  const again = rgbArt.packBits(await rgbArt.rgbArtBits(buf));
  assert.ok(packed.equals(again), 'hashing is not deterministic');

  console.log(`rgbArt hash equivalence: PASS (${n} images, bit-identical)`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
