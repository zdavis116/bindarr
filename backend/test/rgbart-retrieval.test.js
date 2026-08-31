// RETRIEVAL TEST — does the index actually find the right card?
//
// The equivalence test proves the runtime hash matches the build script's.
// That is necessary but not sufficient: two implementations can agree perfectly
// and still be wired to an index that returns nonsense. This exercises the
// real lookup path against the real index.
//
// SKIPS (does not fail) when the index is absent -- it is a 9MB build artefact
// that is deliberately not in git, so CI without it must not go red.
'use strict';

const assert = require('assert');
const rgbArt = require('../src/rgbArtMatch');

(async () => {
  if (!rgbArt.available()) {
    console.log('rgbArt retrieval: SKIP (no index; run backend/scripts/pack-hash-index.js)');
    return;
  }

  // Reach into the loaded index and re-query it with hashes it already holds.
  // A row's own hash must come back at distance 0, in first place. If this
  // fails, the packing offsets or the scan loop are wrong.
  const fs = require('fs');
  const path = require('path');
  const p = process.env.RGBART_INDEX
    || path.join(__dirname, '../../hash-index/rgbart-index.bin');
  const buf = fs.readFileSync(p);
  const hlen = buf.readUInt32LE(0);
  const header = JSON.parse(buf.slice(4, 4 + hlen).toString('utf8'));
  const hashes = buf.slice(4 + hlen);
  const bph = header.bytesPerHash;

  const probes = [0, 1, 500, 12345, header.count - 1];
  for (const r of probes) {
    const q = hashes.slice(r * bph, (r + 1) * bph);
    const hits = rgbArt.nearest(q, 3);
    assert.ok(hits && hits.length, `no hits for row ${r}`);
    assert.strictEqual(hits[0].dist, 0, `row ${r} did not match itself at distance 0`);
    const expect = header.cards[r];
    assert.strictEqual(hits[0].name, expect.n,
      `row ${r}: got ${hits[0].name}, expected ${expect.n}`);
  }

  // A CORRUPTED query must NOT come back at distance 0. Without this, a lookup
  // that always returned the first row would pass every assertion above.
  const q = Buffer.from(hashes.slice(0, bph));
  for (let i = 0; i < 12; i++) q[i] ^= 0xff;         // flip 96 bits
  const far = rgbArt.nearest(q, 3);
  assert.ok(far[0].dist > 0,
    'a heavily corrupted query still matched at distance 0 — lookup is not discriminating');

  // Distances must be ordered: the top-K contract is what the margin/confidence
  // logic relies on.
  const hits = rgbArt.nearest(hashes.slice(0, bph), 3);
  assert.ok(hits[0].dist <= hits[1].dist && hits[1].dist <= hits[2].dist,
    'top-K results are not sorted by distance');

  console.log(`rgbArt retrieval: PASS (${probes.length} exact, corruption detected, ordering held)`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
