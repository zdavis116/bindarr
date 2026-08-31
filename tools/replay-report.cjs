// Summarise / diff corpus replay runs.
//   node replay-report.cjs /tmp/before.jsonl
//   node replay-report.cjs /tmp/before.jsonl /tmp/after.jsonl
//
// The diff is the important mode. A speed change is only acceptable if EVERY
// scan resolves to the same printing it did before -- this is the code that
// decides which card Zach owns, and a faster scanner that occasionally picks a
// different card is a downgrade, not an optimisation.
const fs = require('fs');

const read = (p) => fs.readFileSync(p, 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const stat = (rows, k) => {
  const v = rows.map(r => r[k]).filter(Number.isFinite);
  return v.length ? `p50 ${q(v, 0.5)} p90 ${q(v, 0.9)} max ${Math.max(...v)}` : 'n/a';
};

function summarise(label, rows) {
  const resolved = rows.filter(r => r.resolved);
  const correct = rows.filter(r => r.correct);
  console.log(`\n=== ${label} (${rows.length} scans) ===`);
  console.log(`  resolved to a printing : ${resolved.length} (${(100 * resolved.length / rows.length).toFixed(1)}%)`);
  console.log(`  resolved CORRECTLY     : ${correct.length} (${(100 * correct.length / rows.length).toFixed(1)}%)`);
  const wrong = rows.filter(r => r.resolved && !r.correct);
  console.log(`  resolved WRONG         : ${wrong.length}`);
  console.log(`  timing  total  ${stat(rows, 'msTotal')}`);
  console.log(`          match  ${stat(rows, 'msMatch')}`);
  console.log(`          ocr    ${stat(rows, 'msOcr')}`);
  return { wrong };
}

const before = read(process.argv[2]);
const b = summarise('BEFORE', before);

if (process.argv[3]) {
  const after = read(process.argv[3]);
  summarise('AFTER', after);

  const byId = new Map(before.map(r => [r.id, r]));
  const changed = [];
  for (const a of after) {
    const bb = byId.get(a.id);
    if (!bb) continue;
    if ((bb.resolved || null) !== (a.resolved || null)) {
      changed.push({ id: a.id, truth: a.truth, before: bb.resolved, after: a.resolved });
    }
  }
  console.log(`\n=== IDENTITY CHANGES: ${changed.length} ===`);
  for (const c of changed.slice(0, 40)) {
    const verdict = c.after === c.truth ? 'NOW CORRECT'
      : (c.before === c.truth ? '*** REGRESSION ***' : 'both wrong');
    console.log(`  ${c.id}  truth ${c.truth}  ${c.before} -> ${c.after}   ${verdict}`);
  }
  if (!changed.length) console.log('  none — every scan resolves to exactly the same printing');

  const bt = before.map(r => r.msTotal).filter(Number.isFinite);
  const at = after.map(r => r.msTotal).filter(Number.isFinite);
  console.log(`\n=== SPEED ===`);
  console.log(`  before p50 ${q(bt, 0.5)}ms   after p50 ${q(at, 0.5)}ms   (${(100 * (1 - q(at, 0.5) / q(bt, 0.5))).toFixed(0)}% faster)`);
  console.log(`  before p90 ${q(bt, 0.9)}ms   after p90 ${q(at, 0.9)}ms`);
}
