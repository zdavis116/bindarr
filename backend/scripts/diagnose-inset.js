// THE DECISIVE TEST — does framing explain the high distances?
//
// Takes REAL scans, rectifies them exactly as the live route does, and hashes
// each at several crop insets. If framing is the problem, some inset should
// pull the distance to the CORRECT card down sharply. If nothing helps, the
// problem is elsewhere and this hypothesis is dead.
//
// Uses the correct answer from the live logs (where ORB and rgbArt agreed, and
// OCR confirmed the collector number) so there is a real target to measure
// against rather than just "whatever came first".
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const scanMatch = require('../src/scanMatch');
const rgbArt = require('../src/rgbArtMatch');

const SCAN_DIR = process.argv[2] || '/tmp/scans';
const IDX = path.join(__dirname, '../../hash-index/rgbart-index.json');

function ham(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = a[i] ^ b[i]; while (x) { d += x & 1; x >>= 1; } }
  return d;
}

async function insetBuf(buf, f) {
  if (!f) return buf;
  const m = await sharp(buf).metadata();
  const dx = Math.round(m.width * f), dy = Math.round(m.height * f);
  return sharp(buf).extract({ left: dx, top: dy, width: m.width - 2 * dx, height: m.height - 2 * dy })
    .png().toBuffer();
}

(async () => {
  const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));

  // MATCH THE EXACT PRINTING, NOT THE NAME. An earlier version of this script
  // looked cards up by name and produced distances of ~188 bits -- nonsense
  // against the live logs' 32-58 for the same scans. The cause: "HULK SMASH!"
  // and "Forest" have many printings with DIFFERENT ARTWORK, and the first
  // by-name hit was a different picture entirely. The truth file therefore
  // carries "name|set|number" and the lookup is exact.
  const byKey = new Map();
  for (const c of idx.cards) byKey.set(`${c.name}|${c.set}|${c.number}`, c);
  const byName = new Map();
  for (const c of idx.cards) if (!byName.has(c.name)) byName.set(c.name, c);

  // (file, known-correct card) pairs, taken from the shadow logs where ORB,
  // rgbArt and the OCR'd number all agreed -- so the answer is not in doubt.
  const truth = JSON.parse(fs.readFileSync(process.argv[3] || '/tmp/truth.json', 'utf8'));

  const INSETS = [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06];
  const totals = new Map(INSETS.map(f => [f, []]));

  for (const [file, name] of Object.entries(truth)) {
    const target = name.includes('|') ? byKey.get(name) : byName.get(name);
    const p = path.join(SCAN_DIR, file);
    if (!target) { console.log(`  SKIP ${file}: ${name} not in index`); continue; }
    if (!fs.existsSync(p)) { console.log(`  SKIP ${file}: not on disk`); continue; }
    const stored = Buffer.from(target.hash, 'base64');
    const rect = await scanMatch.rectifyCard(fs.readFileSync(p), { width: 1500, height: 2100 });
    if (!rect) continue;
    const line = [];
    for (const f of INSETS) {
      const h = rgbArt.packBits(await rgbArt.rgbArtBits(await insetBuf(rect, f)));
      const d = ham(h, stored);
      totals.get(f).push(d);
      line.push(`${(f * 100).toFixed(0)}%:${String(d).padStart(3)}`);
    }
    console.log(`  ${name.slice(0, 26).padEnd(26)} ${line.join('  ')}`);
  }

  console.log('\n=== MEDIAN DISTANCE TO THE CORRECT CARD, BY QUERY INSET ===');
  let best = null;
  for (const f of INSETS) {
    const v = totals.get(f).sort((a, b) => a - b);
    if (!v.length) continue;
    const med = v[Math.floor(v.length / 2)];
    if (!best || med < best[1]) best = [f, med];
    console.log(`  inset ${(f * 100).toFixed(0).padStart(2)}%   median ${String(med).padStart(3)}   ` +
      `min ${v[0]}  max ${v[v.length - 1]}   (n=${v.length})`);
  }
  if (best) {
    console.log(`\n  BEST: ${(best[0] * 100).toFixed(0)}% inset, median ${best[1]} bits`);
    const base = totals.get(0).sort((a, b) => a - b);
    const baseMed = base[Math.floor(base.length / 2)];
    console.log(`  vs current (0% inset): median ${baseMed} bits  ->  ` +
      `${baseMed - best[1]} bits recovered`);
  }
})().catch(e => { console.error('FAIL', e.message, e.stack); process.exit(1); });
