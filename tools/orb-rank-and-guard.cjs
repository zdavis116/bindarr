// WHERE DOES THE CORRECT CARD SIT IN THE ORB CANDIDATE LIST?
//
// Two questions, and the second one decides whether any early exit is safe.
//
// Zach: "on the 10 wrong reads, does ORB disagree early?" -- and, correctly:
// "I thought orb went first though so how can we stop orb if it agrees with
// the number?"
//
// He is right about the ordering. routes/collection.js runs scanMatch.match()
// at line 350 and only reads the collector strip at line 496, so the number is
// NOT available while ORB is deciding whether to keep going. Any scheme that
// stops ORB "once it agrees with the number" requires reading the strip FIRST.
//
// That reorder is only worth proposing if the numbers below support it:
//
//   Q1. RANK OF TRUTH. When ORB is left to run all 50 candidates, at what rank
//       does the correct card actually appear? If it is almost always rank 1-3,
//       then stopping early is cheap and safe. If the correct card is regularly
//       at rank 20+, every early exit is a wrong-card risk.
//
//   Q2. THE DANGEROUS SCANS. On the scans where OCR read a confident but WRONG
//       printing, does ORB's top candidate disagree with that read? ORB is the
//       only thing that catches those today. If the disagreement shows up at
//       rank 1, a cross-check survives an early exit. If it only shows up deep
//       in the list, then early exit blinds the one guard that works.
//
// Measured on the labelled corpus, through the real match path.
const fs = require('fs');
const path = require('path');

const BASE = '/opt/bindarr-dev/backend/src';
const scanMatch = require(`${BASE}/scanMatch.js`);
const collectorNumberOcr = require(`${BASE}/utils/collectorNumberOcr.js`);
const { parseCollectorStrip } = require(`${BASE}/utils/collectorNumberParse.js`);

const DIR = '/var/lib/bindarr-dev/scandump';
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/^0+/, '');

(async () => {
  const jsons = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  const items = [];
  for (const f of jsons) {
    const jpg = path.join(DIR, f.replace(/\.json$/, '.jpg'));
    if (!fs.existsSync(jpg)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (d?.truth?.number && d?.truth?.set_id) items.push({ jpg, truth: d.truth });
    } catch { /* skip */ }
  }

  const ranks = [];
  const rank1Correct = [];
  const dangerous = [];   // OCR confidently wrong -- does ORB rank 1 disagree?
  let noCandidates = 0;

  for (const it of items) {
    const buf = fs.readFileSync(it.jpg);
    let m = null;
    try {
      m = await scanMatch.match(buf, 'mtg', 50, '', { recallK: 50, orb: 500 });
    } catch { continue; }
    const cands = m?.candidates || [];
    if (!cands.length) { noCandidates += 1; continue; }

    const wantSet = norm(it.truth.set_id);
    const wantNum = norm(it.truth.number);

    // Rank of the correct card among the ORB-verified candidates.
    const idx = cands.findIndex(c => norm(c.set) === wantSet && norm(c.number) === wantNum);
    if (idx >= 0) ranks.push(idx + 1);

    const top = cands[0];
    const topIsTruth = norm(top.set) === wantSet && norm(top.number) === wantNum;
    rank1Correct.push(topIsTruth);

    // Now the OCR read for this same scan.
    let raw = '';
    try {
      const strip = await scanMatch.rectifyCard(buf, {
        width: collectorNumberOcr.OCR_W,
        height: collectorNumberOcr.OCR_H,
        detection: m.detection || undefined,
        region: collectorNumberOcr.STRIP,
      });
      if (strip) raw = await collectorNumberOcr.readCollectorStrip(strip, { preCropped: true });
    } catch { /* no read */ }

    const p = parseCollectorStrip(raw || '');
    const nums = [p.number, p.numberAlt].filter(Boolean).map(norm);
    const sets = (p.setCandidates?.length ? p.setCandidates : [p.set]).filter(Boolean).map(norm);
    if (!nums.length) continue;

    const ocrRight = nums.includes(wantNum) && sets.includes(wantSet);
    if (!ocrRight && p.confident) {
      // The OCR read a confident printing that is NOT the card. Does ORB's top
      // candidate contradict it?
      const ocrMatchesTop = nums.includes(norm(top.number)) && sets.includes(norm(top.set));
      dangerous.push({
        truth: `${it.truth.set_id}#${it.truth.number}`,
        ocr: `${sets.join('/')}#${nums.join('/')}`,
        orbTop: `${top.set}#${top.number}`,
        orbTopInliers: top.inliers,
        orbTopDisagreesWithOcr: !ocrMatchesTop,
        orbTopIsTruth: topIsTruth,
      });
    }
  }

  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  console.log(`scans measured: ${items.length}  (no candidates: ${noCandidates})`);
  console.log(`\nQ1. RANK OF THE CORRECT CARD (of ${ranks.length} where it appeared at all)`);
  if (ranks.length) {
    console.log(`   rank 1: ${ranks.filter(r => r === 1).length}  (${(100 * ranks.filter(r => r === 1).length / ranks.length).toFixed(0)}%)`);
    console.log(`   <=3   : ${ranks.filter(r => r <= 3).length}  (${(100 * ranks.filter(r => r <= 3).length / ranks.length).toFixed(0)}%)`);
    console.log(`   p50 ${q(ranks, 0.5)}  p90 ${q(ranks, 0.9)}  max ${Math.max(...ranks)}`);
  }
  const okTop = rank1Correct.filter(Boolean).length;
  console.log(`   ORB top candidate was the truth: ${okTop}/${rank1Correct.length} (${(100 * okTop / Math.max(1, rank1Correct.length)).toFixed(0)}%)`);

  console.log(`\nQ2. THE DANGEROUS SCANS (OCR confident but wrong): ${dangerous.length}`);
  let caught = 0;
  for (const d of dangerous) {
    if (d.orbTopDisagreesWithOcr) caught += 1;
    console.log(`   truth ${d.truth.padEnd(11)} ocr ${d.ocr.padEnd(22)} orbTop ${String(d.orbTop).padEnd(12)} inliers ${String(d.orbTopInliers).padStart(4)}  topDisagreesWithOCR=${d.orbTopDisagreesWithOcr}`);
  }
  console.log(`\n   caught by ORB's TOP candidate alone: ${caught}/${dangerous.length}`);
  console.log('   (if this is all of them, an early exit keeps the cross-check)');

  await collectorNumberOcr.shutdown().catch(() => {});
  process.exit(0);
})();
