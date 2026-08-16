import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));

const stats = loadFixture('stats.json');
assert.ok(Array.isArray(stats.topValuable), 'stats.topValuable must be an array');
assert.ok(Array.isArray(stats.setProgress), 'stats.setProgress must be an array');

const collection = loadFixture('collection.json');
const round = (value, digits = 2) => Number(value.toFixed(digits));
const resolveCardPrice = (card) => {
  if (card.printing === 'Holofoil' && card.price_holofoil > 0) return card.price_holofoil;
  if (card.printing === 'Reverse Holofoil' && card.price_reverse_holofoil > 0) return card.price_reverse_holofoil;
  if (card.printing === 'Normal' && card.price_normal > 0) return card.price_normal;
  return card.price_trend || 0;
};

const totalCards = collection.reduce((sum, card) => sum + (card.quantity || 1), 0);
const totalValue = round(collection.reduce(
  (sum, card) => sum + resolveCardPrice(card) * (card.quantity || 1),
  0,
));
const totalSpent = round(collection.reduce(
  (sum, card) => sum + (card.purchase_price || 0) * (card.quantity || 1),
  0,
));
const gain = round(totalValue - totalSpent);

for (const card of collection) {
  assert.equal(
    card.price_trend,
    resolveCardPrice(card),
    `collection card ${card.entry_id} price_trend must expose its finish-aware application price`,
  );
}
assert.equal(stats.summary.totalCards, totalCards);
assert.equal(stats.summary.uniqueCards, collection.length);
assert.equal(stats.summary.totalValue, totalValue);
assert.equal(stats.summary.totalSpent, totalSpent);
assert.equal(stats.summary.avgCardValue, round(totalValue / totalCards));
assert.deepEqual(stats.summary.roi, {
  abs: gain,
  pct: round((gain / totalSpent) * 100, 1),
});
assert.equal(
  round(stats.valueByGame.reduce((sum, game) => sum + game.value, 0)),
  totalValue,
  'stats.valueByGame must add up to summary.totalValue',
);

const expectedSetValues = new Map();
for (const card of collection) {
  expectedSetValues.set(
    card.set_id,
    round((expectedSetValues.get(card.set_id) || 0) + resolveCardPrice(card) * (card.quantity || 1)),
  );
}
for (const set of stats.sets) {
  assert.equal(set.value, expectedSetValues.get(set.id), `stats set ${set.id} must use finish-aware prices`);
}
assert.equal(round(stats.sets.reduce((sum, set) => sum + set.value, 0)), totalValue);

const binderCompartments = loadFixture('locations_43_compartments.json');
const compartmentIds = new Set(binderCompartments.map(({ id }) => id));
const binderCards = collection.filter(({ location_type }) => location_type === 'Binder');
assert.ok(binderCards.length > 0, 'collection fixture must include binder cards');
for (const card of binderCards) {
  assert.ok(
    compartmentIds.has(card.compartment_id),
    `binder card ${card.entry_id} must reference a binder compartment`,
  );
  assert.ok(
    Number.isInteger(card.position) && card.position >= 0,
    `binder card ${card.entry_id} must have a non-negative integer position`,
  );
}

console.log('Demo fixture contract self-check passed');
