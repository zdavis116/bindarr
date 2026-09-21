// Exercise the REAL Mana Pool service through the REAL sectioning function.
// Unit tests use fixtures I wrote, so they cannot catch an invented field name
// -- which is what broke this feature three times. This uses live data.
import { searchDecks, fetchDeckCards } from '../backend/src/services/manapoolDecks.js';
import { sectionCompareCards, compareSectionCount } from '../frontend/src/components/compareSections.js';

const r = await searchDecks(process.argv[2] || 'Atraxa, Praetors\' Voice', {});
if (!r.decks.length) { console.log('no decks'); process.exit(1); }
const d = await fetchDeckCards(r.decks[0].id);

// Exactly what backend/src/routes/decks.js does to their side.
const theirs = d.cards.map((c) => ({
  ...c, typeLine: (c.types || []).join(' '), shared: false,
}));

const sections = sectionCompareCards(theirs);
console.log('deck:', d.name, '| cards:', d.cards.length);
for (const s of sections) {
  console.log(`  ${s.title} (${compareSectionCount(s.cards)}) ->`,
    s.cards.slice(0, 3).map((c) => c.name).join(', '));
}
const placed = sections.reduce((n, s) => n + s.cards.length, 0);
console.log('cards placed:', placed, 'of', theirs.length,
  placed === theirs.length ? 'OK none dropped' : '*** CARDS LOST ***');
const other = sections.find((s) => s.title === 'Other');
console.log('unsectioned (Other):', other ? other.cards.map((c) => c.name) : 'none');
// Alphabetical within every section?
for (const s of sections) {
  const n = s.cards.map((c) => c.name);
  const sorted = [...n].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  if (JSON.stringify(n) !== JSON.stringify(sorted)) console.log('*** NOT ALPHABETICAL:', s.title);
}
console.log('alphabetical check done');
