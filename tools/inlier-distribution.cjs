// WHAT DO *WRONG* ORB MATCHES ACTUALLY SCORE?
//
// Zach: "What if we changed the check to 50 instead of 35?"
//
// The whole safety question for the ocrHint break is one number: how high can a
// WRONG card score? The break stops the search as soon as a candidate clears the
// threshold AND matches the OCR'd collector number. So the threshold is only
// safe if a wrong card essentially never reaches it.
//
// Prior claims in this repo, which is exactly the kind of thing I should stop
// trusting without re-measuring:
//   - "WRONG matches top out at 30, RIGHT matches run 35-162"  (CERTAIN_INLIERS comment)
//   - review found a plausible wrong match at 40
//
// Those disagree, and the difference decides 35 vs 50 vs 80.
//
// METHOD: for every labelled scan, run the real match and record the inlier
// score of (a) the candidate that IS the true card, and (b) every candidate that
// is NOT. The distribution of (b) is the answer.
const fs = require('fs');
const path = require('path');

const BASE = '/opt/bindarr-dev/backend/src';
const scanMatch = require(`${BASE}/scanMatch.js`);

const DIR = '/var/lib/bindarr-dev/scandump';
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/^0+/, '');
const LIMIT = Number(process.env.LIMIT || 120);

(async () => {
  const jsons = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort().slice(0, LIMIT);
  const right = [];
  const wrong = [];

  for (const f of jsons) {
    const jpg = path.join(DIR, f.replace(/\.json$/, '.jpg'));
    if (!fs.existsSync(jpg)) continue;
    let truth;
    try { truth = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).truth; } catch { continue; }
    if (!truth?.number || !truth?.set_id) continue;

    const buf = fs.readFileSync(jpg);
    let m;
    try { m = await scanMatch.match(buf, 'mtg', 50, '', { recallK: 50, orb: 500 }); } catch { continue; }

    for (const c of (m.candidates || [])) {
      if (!Number.isFinite(c.inliers)) continue;
      const isTruth = norm(c.set) === norm(truth.set_id) && norm(c.number) === norm(truth.number);
      const BASICS=new Set(['plains','island','swamp','mountain','forest','wastes']);
      const isBasic=BASICS.has(String(c.name||'').toLowerCase().replace('snow-covered ',''));
      (isTruth ? right : wrong).push({ inliers: c.inliers, name: c.name, set: c.set, number: c.number, isBasic });
    }
  }

  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const ri = right.map(x => x.inliers);
  const wi = wrong.map(x => x.inliers);

  console.log(`RIGHT matches (n=${ri.length}): p50 ${q(ri, 0.5)}  p90 ${q(ri, 0.9)}  max ${Math.max(...ri)}`);
  console.log(`WRONG matches (n=${wi.length}): p50 ${q(wi, 0.5)}  p90 ${q(wi, 0.9)}  p99 ${q(wi, 0.99)}  max ${Math.max(...wi)}`);

  console.log('\nHOW MANY WRONG CARDS CLEAR EACH THRESHOLD:');
  for (const t of [30, 35, 40, 50, 60, 70, 80]) {
    const n = wi.filter(v => v >= t).length;
    const pct = (100 * n / wi.length).toFixed(2);
    console.log(`  >= ${String(t).padStart(3)}: ${String(n).padStart(5)} wrong candidates (${pct}%)`);
  }

  const wnb=wrong.filter(x=>!x.isBasic).map(x=>x.inliers);
  console.log("\nWRONG matches EXCLUDING basic lands (n="+wnb.length+"):");
  for (const t of [35,40,50,60,80]) { const n=wnb.filter(v=>v>=t).length; console.log("  >= "+String(t).padStart(3)+": "+String(n).padStart(4)+" ("+(100*n/wnb.length).toFixed(2)+"%)"); }
  console.log("  worst non-basic wrong match:", Math.max(...wnb));
  console.log('\nTHE WORST WRONG MATCHES (these are what a bad OCR read could promote):');
  for (const w of wrong.sort((a, b) => b.inliers - a.inliers).slice(0, 12)) {
    console.log(`  ${String(w.inliers).padStart(4)}  ${w.name} (${w.set}#${w.number})`);
  }

  // And the flip side: how many RIGHT matches would a higher threshold exclude?
  console.log('\nSPEED COST -- right matches BELOW each threshold cannot trigger the break:');
  for (const t of [35, 50, 80]) {
    const n = ri.filter(v => v < t).length;
    console.log(`  < ${String(t).padStart(3)}: ${String(n).padStart(4)} of ${ri.length} (${(100 * n / ri.length).toFixed(0)}%) lose the shortcut`);
  }

  process.exit(0);
})();
