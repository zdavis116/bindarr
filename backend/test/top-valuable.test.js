// TOP VALUABLE: one row per PRINTING, not per collection entry.
//
// Zach, looking at the dashboard: "I see commander plate there twice but since
// they are the same printing they should be grouped together so in this
// instance if we did top 10 it should in reality be top 11 cards because of
// the duplicate not counting twice just once."
//
// The collection table stores one row per ACQUISITION. Two copies of the same
// printing are two rows sharing a card_id -- measured on his dev box,
// Commander's Plate as entry_id 3324 and 4940, both card_id 4b470e1e….
//
// "Most valuable cards" is a question about CARDS, so the list collapses on
// card_id and carries a copy count. The SQL over-fetches (LIMIT 30) so that
// collapsing still leaves a full ten.
const assert = require('node:assert');

let passed = 0;
const pass = (id, what) => { passed += 1; console.log(`PASS: ${id} ${what}`); };

// The collapse, lifted from routes/stats.js. Kept in sync by TV-TC4 below,
// which reads the real file and asserts the shape is still there.
function collapseByPrinting(rows, limit = 10) {
  const byPrinting = new Map();
  for (const row of rows) {
    const existing = byPrinting.get(row.card_id);
    if (existing) {
      existing.copies += (row.quantity || 1);
      continue;
    }
    byPrinting.set(row.card_id, { ...row, copies: row.quantity || 1 });
  }
  return [...byPrinting.values()].slice(0, limit);
}

// --- TV-TC1 ------------------------------------------------------------------
// THE EXACT CASE ZACH SAW: two entries, one printing, one row out.
{
  const rows = [
    { card_id: 'blood', name: 'Bloodletter of Aclazotz', entry_id: 3650, quantity: 1 },
    { card_id: 'urd', name: 'The Ur-Dragon', entry_id: 3842, quantity: 1 },
    { card_id: 'plate', name: "Commander's Plate", entry_id: 3324, quantity: 1 },
    { card_id: 'plate', name: "Commander's Plate", entry_id: 4940, quantity: 1 },
    { card_id: 'miirym', name: 'Miirym, Sentinel Wyrm', entry_id: 3647, quantity: 1 },
  ];
  const out = collapseByPrinting(rows);

  const plates = out.filter((c) => c.name === "Commander's Plate");
  assert.strictEqual(plates.length, 1,
    'the same printing must appear ONCE however many copies are owned');
  assert.strictEqual(plates[0].copies, 2,
    'and the copy count must say there are two of them');
  assert.strictEqual(out.length, 4, 'five entries, four distinct printings');

  pass('TV-TC1', 'two entries of one printing collapse to a single row');
}

// --- TV-TC2 ------------------------------------------------------------------
// A FULL TEN, which is the reason the SQL over-fetches.
//
// If the query said LIMIT 10 and the collection held a duplicate inside that
// window, the dashboard would quietly show nine cards. Zach asked for ten.
{
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push({ card_id: `c${i}`, name: `Card ${i}`, quantity: 1 });
  }
  // Two duplicate pairs inside the top window.
  rows.splice(3, 0, { card_id: 'c1', name: 'Card 1', quantity: 1 });
  rows.splice(7, 0, { card_id: 'c4', name: 'Card 4', quantity: 1 });

  const out = collapseByPrinting(rows, 10);
  assert.strictEqual(out.length, 10,
    'duplicates inside the window must not shrink the list below ten');
  assert.strictEqual(new Set(out.map((c) => c.card_id)).size, 10,
    'and every one of the ten must be a different printing');

  pass('TV-TC2', 'collapsing still yields a full ten');
}

// --- TV-TC3 ------------------------------------------------------------------
// ORDER IS PRESERVED. The SQL sorts by the resolved price; collapsing must not
// reshuffle, or the "most valuable" list stops being sorted by value.
{
  const rows = [
    { card_id: 'a', name: 'A', quantity: 1 },
    { card_id: 'b', name: 'B', quantity: 1 },
    { card_id: 'a', name: 'A', quantity: 1 },
    { card_id: 'c', name: 'C', quantity: 1 },
  ];
  assert.deepStrictEqual(collapseByPrinting(rows).map((c) => c.name), ['A', 'B', 'C'],
    'first appearance wins, so the price order the SQL produced survives');

  pass('TV-TC3', 'collapsing preserves the price ordering');
}

// --- TV-TC4 ------------------------------------------------------------------
// QUANTITY IS SUMMED, not counted. A single entry can hold several copies.
{
  const rows = [
    { card_id: 'x', name: 'X', quantity: 3 },
    { card_id: 'x', name: 'X', quantity: 2 },
  ];
  assert.strictEqual(collapseByPrinting(rows)[0].copies, 5,
    'an entry of 3 plus an entry of 2 is five copies, not two entries');

  pass('TV-TC4', 'copies sum the quantity, not the row count');
}

// --- TV-TC5 ------------------------------------------------------------------
// THE REAL ROUTE STILL DOES THIS. Guards against someone restoring LIMIT 6 or
// dropping the collapse: the unit tests above would keep passing on a copy.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'stats.js'), 'utf8');

  const q = src.slice(src.indexOf('const topValuableQuery'),
                      src.indexOf('const topValuable ='));
  assert.ok(/LIMIT\s+30/.test(q),
    'the query must over-fetch so collapsing can still yield ten');
  assert.ok(/byPrinting/.test(src),
    'stats.js must collapse duplicate printings before returning topValuable');
  assert.ok(/copies/.test(src),
    'and must carry a copy count so the UI can show "x2"');

  pass('TV-TC5', 'routes/stats.js really collapses and over-fetches');
}

console.log(`top-valuable.test.js: ${passed} cases passed`);
