// WHY DID AGREEMENT COLLAPSE FROM 80.5% TO 25.9%?
//
// Session 1 (Marvel/msh cards): agreement 80.5%, p50 distance 82.
// Session 2 (mixed older cards): agreement 25.9%, p50 distance 112.
//
// Same code, same index. Something about session 2's CARDS is different, and
// the honest possibilities are very different in consequence:
//
//   A. rgbArt genuinely cannot rank these cards -- the correct card IS in the
//      index but sits further away than a wrong one. A ranking failure.
//   B. the correct card is NOT in the index at all, so no ranking could have
//      saved it. A coverage failure Gate 1a's 99.99% did not predict.
//   C. the rectified image is degraded on these scans, so the query hash is
//      wrong before the index is consulted. An input failure.
//
// These need different fixes, so this measures which one it is: for each scan
// where ORB is CONFIDENT (high inliers, so its answer is probably right), find
// ORB's answer in the index and compare its distance to rgbArt's own top hit.
'use strict';

const fs = require('fs');
const path = require('path');
const scanMatch = require('../src/scanMatch');
const rgbArt = require('../src/rgbArtMatch');

const SCAN_DIR = process.argv[2] || '/tmp/scans2';
const PAIRS = process.argv[3] || '/tmp/pairs3.json';
const IDX = path.join(__dirname, '../../hash-index/rgbart-index.json');

function ham(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = a[i] ^ b[i]; while (x) { d += x & 1; x >>= 1; } }
  return d;
}

(async () => {
  const idx = JSON.parse(fs.readFileSync(IDX, 'utf8'));
  const byKey = new Map();
  const byName = new Map();
  for (const c of idx.cards) {
    byKey.set(`${c.name}|${c.set}|${c.number}`, c);
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }

  const pairs = JSON.parse(fs.readFileSync(PAIRS, 'utf8'));
  let notInIndex = 0, ranking = 0, ok = 0;

  console.log('  ORB answer (confident)        | dist to ORB ans | rgbArt top | verdict');
  console.log('  ' + '-'.repeat(76));

  for (const p of pairs) {
    const file = path.join(SCAN_DIR, p.file);
    if (!fs.existsSync(file)) continue;
    const rect = await scanMatch.rectifyCard(fs.readFileSync(file), { width: 1500, height: 2100 });
    if (!rect) { console.log(`  ${p.orbName}: no rectify`); continue; }
    const q = rgbArt.packBits(await rgbArt.rgbArtBits(rect));

    // EVERY printing of ORB's answer -- the same card can appear under many
    // artworks, and recall only has to find ONE of them.
    const cands = byName.get(p.orbName) || [];
    if (!cands.length) {
      notInIndex++;
      console.log(`  ${p.orbName.slice(0, 28).padEnd(28)}  | NOT IN INDEX    |            | COVERAGE`);
      continue;
    }
    let best = Infinity;
    for (const c of cands) best = Math.min(best, ham(q, Buffer.from(c.hash, 'base64')));

    const top = rgbArt.nearest(q, 1)[0];
    const verdict = best <= top.dist ? 'ok(ranked first)' :
      (best <= top.dist + 20 ? 'RANKING (near miss)' : 'RANKING (far)');
    if (best <= top.dist) ok++; else ranking++;
    console.log(`  ${p.orbName.slice(0, 28).padEnd(28)}  | ${String(best).padStart(3)} (${cands.length} prints) | ` +
      `${String(top.dist).padStart(3)} ${top.name.slice(0, 14).padEnd(14)} | ${verdict}`);
  }

  console.log(`\n  correct card ranked first : ${ok}`);
  console.log(`  correct card in index but OUTRANKED : ${ranking}   <- ranking failure`);
  console.log(`  correct card NOT IN INDEX : ${notInIndex}   <- coverage failure`);
})().catch(e => { console.error('FAIL', e.message, e.stack); process.exit(1); });
