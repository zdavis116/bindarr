import assert from 'node:assert/strict';
import { planStackEdit } from './stackEdit.js';

// Replays the operations against a fake table, the way the server applies them.
function apply(rows, wanted, edit) {
  const ids = rows.map(r => r.id);
  const p = planStackEdit(ids, wanted);
  let out = rows.filter(r => !p.doomed.includes(r.id));
  let next = 1000;
  out = out.map(r => (r.id === ids[0] || p.survivors.includes(r.id)) ? { ...r, ...edit } : r);
  const key = out.find(r => r.id === ids[0]);
  for (let i = 1; i < p.sendQty; i++) out.push({ ...key, id: next++ });
  return out;
}
const stack = (n, finish = 'nonfoil') => Array.from({ length: n }, (_, i) => ({ id: i + 1, finish }));

// Zach's exact report: 6 -> 4 became 7.
assert.equal(apply(stack(6, 'foil'), 4, {}).length, 4, '6 -> 4 must be 4');
// Flip 6 nonfoil to foil: 6 foil, 0 nonfoil (was 7 foil + 5 nonfoil).
{
  const r = apply(stack(6), 6, { finish: 'foil' });
  assert.equal(r.filter(x => x.finish === 'foil').length, 6);
  assert.equal(r.filter(x => x.finish === 'nonfoil').length, 0);
}
// Decrease AND flip together.
{
  const r = apply(stack(6), 4, { finish: 'foil' });
  assert.deepEqual([r.length, r.filter(x => x.finish === 'foil').length], [4, 4]);
}
assert.equal(apply(stack(2), 5, {}).length, 5, 'increase adds the difference');
assert.equal(apply(stack(1), 3, {}).length, 3, 'single row still works');
assert.equal(apply(stack(3), 3, {}).length, 3, 'unchanged quantity adds nothing');
console.log('PASS: STACK-EDIT-1..6 tile quantity/finish edits');
