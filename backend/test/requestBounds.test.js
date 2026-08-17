const assert = require('assert');
const {
  RequestBoundsError,
  positiveInteger,
  requireArray,
  uniqueIntegerIds,
  boundedProduct
} = require('../src/utils/requestBounds');

function rejects(fn, status, pattern) {
  assert.throws(fn, error => {
    assert.ok(error instanceof RequestBoundsError);
    assert.strictEqual(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
}

// Positive integers are numbers, not values parseInt can partially/coercively accept.
assert.strictEqual(positiveInteger(1, { name: 'quantity', max: 1000 }), 1);
assert.strictEqual(positiveInteger(1000, { name: 'quantity', max: 1000 }), 1000);
for (const value of ['1', [1], 1.5, NaN, Infinity, 0, -1, null]) {
  rejects(() => positiveInteger(value, { name: 'quantity', max: 1000 }), 400, /quantity/);
}
rejects(() => positiveInteger(1001, { name: 'quantity', max: 1000 }), 413, /quantity/);

const values = ['a', 'b'];
assert.strictEqual(requireArray(values, { name: 'values' }), values);
rejects(() => requireArray('a,b', { name: 'values' }), 400, /values/);
rejects(() => requireArray([], { name: 'values', minLength: 1 }), 400, /values/);
rejects(() => requireArray([1, 2, 3], { name: 'values', maxLength: 2 }), 413, /values/);

assert.deepStrictEqual(uniqueIntegerIds([1, 2, 3], { name: 'entry_ids', maxLength: 3 }), [1, 2, 3]);
for (const ids of [[1, 1], [1, '2'], [1, 2.5], [0], [-1], [NaN]]) {
  rejects(() => uniqueIntegerIds(ids, { name: 'entry_ids', maxLength: 10 }), 400, /entry_ids/);
}
rejects(() => uniqueIntegerIds('1,2', { name: 'entry_ids' }), 400, /entry_ids/);
rejects(() => uniqueIntegerIds([1, 2, 3], { name: 'entry_ids', maxLength: 2 }), 413, /entry_ids/);

assert.strictEqual(boundedProduct([4, 25], { name: 'expanded operations', max: 100 }), 100);
rejects(() => boundedProduct([4, 26], { name: 'expanded operations', max: 100 }), 413, /expanded operations/);
rejects(() => boundedProduct([2, 1.5], { name: 'expanded operations', max: 100 }), 400, /expanded operations/);
rejects(() => boundedProduct([Number.MAX_SAFE_INTEGER, 2], { name: 'expanded operations', max: Number.MAX_SAFE_INTEGER }), 413, /expanded operations/);

console.log('requestBounds.test.js: all assertions passed');
