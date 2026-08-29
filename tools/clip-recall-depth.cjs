// WHEN CLIP RECALL MISSES THE TRUE CARD, WHERE IS IT ACTUALLY?
//
// Zach: "if it's possible to adjust the CLIP recall let's do it"
//
// Measured earlier: on ~36% of scans the printing named by the collector number
// is NOT in the 50-candidate recall list at all. That is the ceiling on every
// ORB-side optimisation -- you cannot promote, reorder or early-exit your way to
// a candidate that was never recalled.
//
// But "not in the top 50" covers two completely different situations, and they
// have opposite fixes:
//
//   NEAR MISS   the true card is at rank 55, 80, 120. CLIP basically found it
//               and K is simply too small. Raising K fixes it, and costs ORB
//               time linearly -- which the agreement break now largely refunds,
//               since the break fires as soon as the right card is verified.
//
//   FAR MISS    the true card is at rank 3000 of 57583. CLIP genuinely did not
//               recognise this artwork. No K short of the whole catalogue helps,
//               and this is an EMBEDDING problem (glare, crop, foil, angle),
//               not a recall-depth problem.
//
// This measures the true card's rank across the ENTIRE 57,583-card index, so the
// distribution says which of those two we actually have. Guessing here would be
// the third prediction I got wrong today.
const fs = require('fs');
const path = require('path');

const BASE = '/opt/bindarr-dev/backend/src';
const scanMatch = require(`${BASE}/scanMatch.js`);
const embedMatch = require(`${BASE}/embedMatch.js`);

const DIR = '/var/lib/bindarr-dev/scandump';
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/^0+/, '');
const LIMIT = Number(process.env.LIMIT || 80);

(async () => {
  const jsons = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort().slice(0, LIMIT);
  const ranks = [];
  let missing = 0;

  for (const f of jsons) {
    const jpg = path.join(DIR, f.replace(/\.json$/, '.jpg'));
    if (!fs.existsSync(jpg)) continue;
    let truth;
    try { truth = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).truth; } catch { continue; }
    if (!truth?.number || !truth?.set_id) continue;

    const buf = fs.readFileSync(jpg);
    const pre = await scanMatch.preprocessCardWithDetection(buf);
    // Ask for a very deep list so the true card's real rank is visible rather
    // than censored at 50.
    const deep = await embedMatch.match(pre.buf, 'mtg', 2000);
    const i = deep.findIndex(c => norm(c.set) === norm(truth.set_id) && norm(c.number) === norm(truth.number));
    if (i < 0) missing += 1; else ranks.push(i + 1);
  }

  ranks.sort((a, b) => a - b);
  const n = ranks.length + missing;
  const at = (k) => ranks.filter(r => r <= k).length;
  const pc = (x) => `${x} (${(100 * x / n).toFixed(0)}%)`;

  console.log(`scans: ${n}   true card found within top 2000: ${ranks.length}   beyond 2000: ${missing}`);
  console.log('\nCUMULATIVE RECALL — true card within top K:');
  for (const k of [1, 3, 5, 10, 25, 50, 75, 100, 150, 200, 400, 1000, 2000]) {
    const bar = '#'.repeat(Math.round(40 * at(k) / n));
    console.log(`  K=${String(k).padStart(4)}  ${pc(at(k)).padEnd(12)} ${bar}`);
  }

  const beyond50 = ranks.filter(r => r > 50);
  if (beyond50.length) {
    console.log(`\nOf the ${beyond50.length} that miss K=50, their actual ranks:`);
    console.log(`  ${beyond50.slice(0, 40).join(', ')}${beyond50.length > 40 ? ' ...' : ''}`);
    const nearMiss = beyond50.filter(r => r <= 200).length;
    console.log(`\n  NEAR MISS (rank 51-200, raising K would fix): ${nearMiss}/${beyond50.length}`);
    console.log(`  FAR MISS (rank >200, embedding problem)     : ${beyond50.length - nearMiss}/${beyond50.length}`);
  }

  process.exit(0);
})();
