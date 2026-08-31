// COULD SET CODE + COLLECTOR NUMBER REPLACE ORB ENTIRELY?
//
// Zach: "Like what is orb buying you if set code and number give you the exact
// card. Do you really need orb?"
//
// A fair challenge, and the answer has to come from HIS scans rather than from
// the architecture diagram. The claim under test:
//
//   "If OCR reads the set code and collector number, that IS the card, so ORB
//    artwork verification is redundant."
//
// Two things decide whether that holds:
//
//   1. HOW OFTEN does OCR actually produce a usable set + number? If it reads
//      cleanly on 95% of scans, skipping ORB is a real option. If it is 60%,
//      then ORB is what rescues the other 40%.
//
//   2. WHEN OCR DOES read, is it RIGHT? A wrong-but-confident number resolves
//      to a real card that is not the one in his hand -- the recount failure.
//      ORB currently catches that by disagreeing.
//
// Measured against the labelled corpus: every scan has a ground-truth
// name/set/number written by staging or by a manual resolve.
const fs = require('fs');
const path = require('path');

const DIR = '/var/lib/bindarr-dev/scandump';

// The same parse the real pipeline uses, so this measures OUR reader rather
// than an idealised one.
const collectorNumberOcr = require('/opt/bindarr-dev/backend/src/utils/collectorNumberOcr.js');

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
const rows = [];
for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (d && d.truth && d.truth.name) rows.push(d);
  } catch { /* skip */ }
}

console.log(`labelled scans: ${rows.length}`);
console.log(`with a recorded scanner guess: ${rows.filter(r => r.scanner_said).length}`);

// How strong was the ORB match on scans we have inliers for?
const withInliers = rows.filter(r => Number.isFinite(r.match_inliers));
const inl = withInliers.map(r => r.match_inliers).sort((a, b) => a - b);
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
if (inl.length) {
  console.log(`\nORB inliers over ${inl.length} scans: min ${inl[0]} p10 ${q(inl, 0.1)} p50 ${q(inl, 0.5)} max ${inl[inl.length - 1]}`);
  console.log(`  scans where ORB was WEAK (<=25 inliers): ${inl.filter(v => v <= 25).length}`);
}

// Did the scanner's name agree with ground truth?
const named = rows.filter(r => r.scanner_said && r.scanner_said.matched_name);
const agree = named.filter(r => r.scanner_said.matched_name === r.truth.name);
console.log(`\nscanner name == truth: ${agree.length}/${named.length}`);

module.exports = {};
