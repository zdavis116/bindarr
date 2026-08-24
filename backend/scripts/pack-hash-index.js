// PHASE 1b — PACK THE INDEX FOR THE SERVER.
//
// The build script emits 16MB of JSON. The server needs three things per row:
// the 48-byte hash, and enough identity to name the card. Parsing 16MB of JSON
// on every boot to recover 2.5MB of bits is waste the dev box (4GB, and it has
// wedged under memory pressure before) does not need to carry.
//
// Layout: a small JSON header describing the rows, then the hashes as one flat
// Buffer. The hashes stay contiguous so the nearest-neighbour scan walks memory
// in order instead of chasing 51k separate objects.
//
//   [4 bytes  ] header length, uint32LE
//   [N bytes  ] JSON header: { version, bits, bytesPerHash, count, cards: [...] }
//   [48*C     ] hashes, row-major, no delimiters
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || path.join(__dirname, '../../hash-index/rgbart-index.json');
const OUT = process.argv[3] || path.join(__dirname, '../../hash-index/rgbart-index.bin');

const idx = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const rows = idx.cards;
const bytesPerHash = Buffer.from(rows[0].hash, 'base64').length;

const hashes = Buffer.alloc(rows.length * bytesPerHash);
const meta = new Array(rows.length);
rows.forEach((c, i) => {
  const b = Buffer.from(c.hash, 'base64');
  if (b.length !== bytesPerHash) throw new Error(`ragged hash at row ${i}`);
  b.copy(hashes, i * bytesPerHash);
  // `img` is dropped: the server never fetches card images, and it is over half
  // the JSON's weight.
  meta[i] = { k: c.key, i: c.id, n: c.name, s: c.set, c: c.number };
});

const header = Buffer.from(JSON.stringify({
  version: idx.version, bits: idx.bits, bytesPerHash,
  count: rows.length, built: idx.built, cards: meta,
}), 'utf8');
const len = Buffer.alloc(4);
len.writeUInt32LE(header.length, 0);

fs.writeFileSync(OUT, Buffer.concat([len, header, hashes]));
const mb = fs.statSync(OUT).size / 1e6;
console.log(`packed ${rows.length} rows x ${bytesPerHash}B -> ${OUT} (${mb.toFixed(1)} MB)`);
