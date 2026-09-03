const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// THE COLLECTION IMPORTER.
//
// This route was a 501 stub: "disabled until the Oracle-aware importer can
// validate every row against an English Scryfall printing. Trusting uploaded
// metadata here would bypass the card-admission boundary and poison the shared
// cache."
//
// That comment is the specification. The rule it protects:
//
//   AN IMPORT MAY ADD COLLECTION ROWS POINTING AT CARDS ALREADY IN THE
//   CATALOGUE. IT MAY NEVER INSERT INTO card_cache.
//
// A CSV is a claim about what someone owns. It is not a source of truth about
// what a Magic card IS -- only the nightly Scryfall refresh is. If an import
// could create catalogue entries, a typo in a CSV would become a card that
// every other screen then trusts.
//
// Zach's two decisions, from the thread:
//   "Report it as rejected"              -- import what resolves, name the rest
//   "If you re-import it adds duplicate rows"

const routeSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/importExport.js'), 'utf8');
const resolverSrc = fs.readFileSync(
  path.join(__dirname, '../src/utils/importResolver.js'), 'utf8');
const mapperSrc = fs.readFileSync(
  path.join(__dirname, '../src/utils/csvMappers.js'), 'utf8');

const { parseThirdPartyCSV } = require('../src/utils/csvMappers');

test('IMP-TC1: the importer never writes to card_cache', () => {
  // The whole reason the route was disabled. If this ever fails, an upload can
  // define a card, and every screen downstream inherits the lie.
  // Strip comments first: the resolver's own explanation of this rule contains
  // the phrase "never INSERT into card_cache", and matching prose instead of
  // code is how CIL-TC1 once reported a bug that was not there.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const writes = /INSERT\s+INTO\s+card_cache|UPDATE\s+card_cache|REPLACE\s+INTO\s+card_cache/i;
  assert.doesNotMatch(stripComments(routeSrc), writes,
    'an import may only reference the catalogue, never extend it');
  assert.doesNotMatch(stripComments(resolverSrc), writes,
    'the resolver reads the catalogue; it must not create entries');
});

test('IMP-TC2: an unknown card is rejected, not invented', () => {
  // Zach: "Report it as rejected."
  assert.match(resolverSrc, /NOT_IN_CATALOGUE/,
    'a card we do not have must produce a named rejection');
  assert.match(routeSrc, /rejections: stillRejected\.map/,
    'and the response must carry every rejection back -- stillRejected, so a '
    + 'row the user resolved by hand no longer appears as a problem');
  assert.match(routeSrc, /row: r\.index \+ 1/,
    'with the source row number, or he cannot fix the file');
});

test('IMP-TC3: a name alone is never enough to match', () => {
  // A name maps to dozens of printings at wildly different values -- Zach's
  // own Tony Stark is $6.50 in one printing and $25.30 in another. Picking one
  // writes a wrong record, and a wrong record costs a recount against
  // cardboard where a missing one costs a tap.
  assert.match(resolverSrc, /AMBIGUOUS_PRINTING/,
    'name-only rows must be reported as ambiguous');

  const byName = resolverSrc.slice(resolverSrc.indexOf('byName:'),
                                   resolverSrc.indexOf('};', resolverSrc.indexOf('byName:')));
  assert.doesNotMatch(byName, /matchedBy:/,
    'the name lookup must never return a match, only an ambiguity report');
});

test('IMP-TC4: set + number is only a match when it is unique', () => {
  const fn = resolverSrc.slice(resolverSrc.indexOf('setAndNumber:'),
                               resolverSrc.indexOf('byName:'));
  assert.match(fn, /hits\.length !== 1/,
    'two printings sharing a set and number is not a match -- promos and '
    + 'alternate arts collide, and guessing writes the wrong card');
  assert.match(fn, /COLLATE NOCASE/,
    'ManaBox writes "(MSH)" where the catalogue stores "msh"');
  assert.doesNotMatch(fn, /LOWER\(/,
    'LOWER() discards the index and scans 105k rows per line -- that is the '
    + 'bug that made deck import take 30 seconds');
});

test('IMP-TC5: the Scryfall id is used, because it is exact', () => {
  // card_cache.id IS a Scryfall UUID, so this is a primary-key lookup.
  assert.match(mapperSrc, /scryfall_id:/,
    'the ManaBox mapper must read the Scryfall ID column');
  assert.match(resolverSrc, /WHERE id = \?/,
    'and the resolver must match on it directly');

  const rows = parseThirdPartyCSV(
    [{ 'Scryfall ID': ' abc-123 ', Name: 'Sol Ring', Quantity: '2', Foil: 'foil' }],
    'manabox');
  assert.equal(rows[0].scryfall_id, 'abc-123', 'trimmed, not passed through raw');
  assert.equal(rows[0].quantity, 2);
});

test('IMP-TC6: a blank Scryfall id does not become the string "undefined"', () => {
  // An empty column must fall through to set+number, not become a lookup key
  // that matches nothing and reports every row as unknown.
  const rows = parseThirdPartyCSV(
    [{ Name: 'Sol Ring', 'Set code': 'LEA', 'Card number': '270', Quantity: '1' }],
    'manabox');
  assert.equal(rows[0].scryfall_id, null,
    'absent means null, so the resolver skips to the next strategy');
});

test('IMP-TC7: re-importing adds rows rather than merging', () => {
  // Zach: "If you re-import it adds duplicate rows." A ManaBox export is a
  // full dump, so re-importing means "I have these again". Merging into an
  // existing entry would discard the condition and price of the copies already
  // recorded.
  assert.match(routeSrc, /INSERT INTO collection/,
    'each resolved row becomes its own collection entry');
  assert.doesNotMatch(routeSrc, /ON CONFLICT|INSERT OR REPLACE|UPDATE collection SET quantity/,
    'no upsert -- a re-import is a second acquisition, not a correction');
});

test('IMP-TC8: a failed import saves nothing', () => {
  // A partial import leaves him unable to tell which rows landed, and the only
  // way to find out is counting cardboard.
  assert.match(routeSrc, /await db\.run\('BEGIN'\)/);
  assert.match(routeSrc, /await db\.run\('COMMIT'\)/);
  assert.match(routeSrc, /ROLLBACK/);
  assert.match(routeSrc, /nothing was saved/,
    'and the message must say so plainly');
});

test('IMP-TC9: preview writes nothing', () => {
  // Zach reviews before he commits. The preview must be provably read-only.
  const fn = routeSrc.slice(routeSrc.indexOf('async function runImport'),
                            routeSrc.indexOf("router.post('/import/preview'"));
  const previewGuard = fn.indexOf('if (!commit) {');
  const firstInsert = fn.indexOf('INSERT INTO collection');
  assert.ok(previewGuard > 0 && firstInsert > previewGuard,
    'the preview must return BEFORE any write happens');
});

test('IMP-TC10: printing and finish are not the same value', () => {
  // `printing` is the display label ('Normal' / 'Foil'); `finish` is the
  // machine value ('nonfoil' / 'foil'). Passing finish to both puts 'nonfoil'
  // in a column every other screen renders as text.
  assert.match(routeSrc, /displayPrinting\(r\.row\.finish\), r\.row\.finish/,
    'the display label must be derived, not copied from the finish');
});

test('IMP-TC11: an explicit quantity of zero is never turned into one', () => {
  // FOUND BY RUNNING THE IMPORTER, NOT BY THESE TESTS. I sent a row with
  // Quantity '0' expecting a rejection and got a match: the mapper used
  // `parseInt(x, 10) || 1`, and 0 is falsy, so an explicit zero became one.
  // The resolver's BAD_QUANTITY branch was unreachable for the exact input it
  // exists to catch.
  //
  // That writes a card into a collection its owner said they do not have --
  // the wrong-record failure, from a two-character idiom, in three places.
  const { parseQuantity } = require('../src/utils/csvMappers');

  assert.equal(parseQuantity('0'), 0, 'a stated zero must survive to the resolver');
  assert.equal(parseQuantity('-3'), -3, 'so must a negative');
  assert.equal(parseQuantity(''), 1, 'but a BLANK column really does mean one');
  assert.equal(parseQuantity(undefined), 1, 'as does an absent one');
  assert.equal(parseQuantity('abc'), null, 'unreadable is not a guess');

  assert.doesNotMatch(mapperSrc, /parseInt\(row\['Quantity'\], 10\) \|\| 1/,
    'the `|| 1` idiom cannot distinguish absent from zero');
});

test('IMP-TC12: a zero-quantity row is rejected end to end', () => {
  const rows = parseThirdPartyCSV(
    [{ 'Scryfall ID': 'abc', Name: 'Sol Ring', Quantity: '0' }], 'manabox');
  assert.equal(rows[0].quantity, 0);

  // And the resolver must refuse it rather than correct it.
  assert.match(resolverSrc, /row\.quantity === null \? NaN : Number\(row\.quantity\)/,
    'an unreadable quantity must not coerce to 0 and slip past the guard');
  assert.match(resolverSrc, /!Number\.isInteger\(qty\) \|\| qty < 1/);
});

test('IMP-TC13: a hand-picked printing still goes through the catalogue', () => {
  // THE BOUNDARY IS NOT WAIVED BECAUSE A HUMAN POINTED AT SOMETHING. The
  // review screen posts a card_id; the client could post any string at all.
  assert.match(routeSrc, /SELECT id, name FROM card_cache WHERE id = \?/,
    'a chosen card_id must be looked up, not trusted');
  assert.match(routeSrc, /chosen_card_not_in_catalogue/,
    'and a choice that resolves to nothing is reported, not inserted');
});

test('IMP-TC14: a resolution cannot redirect a row that already matched', () => {
  // Resolutions are applied to the REJECTED list only. If they were applied
  // before resolution, a client could point a cleanly-matched row at a
  // different card -- silently replacing what the file actually said.
  const applyAt = routeSrc.indexOf('for (const r of rejected)');
  const resolveAt = routeSrc.indexOf('await resolveRows(mapped)');
  assert.ok(resolveAt > 0 && applyAt > resolveAt,
    'resolutions are applied after resolution, and only to rejected rows');
});

test('IMP-TC15: a resolution with a bad quantity is refused', () => {
  // The same rule as the file itself: nobody owns zero of something.
  const block = routeSrc.slice(routeSrc.indexOf('for (const r of rejected)'),
                               routeSrc.indexOf('const finalResolved'));
  assert.match(block, /!Number\.isInteger\(qty\) \|\| qty < 1/,
    'a hand-entered quantity gets the same check as a parsed one');
  assert.match(block, /choice\.skip/,
    'and skipping must stay available -- Zach: "Skipping is always available"');
});

test('IMP-TC16: ambiguous rejections carry their candidates', () => {
  // 013 offers a choice only where Bindarr KNOWS the options. They ride along
  // with the rejection rather than being fetched per row: a file with 40
  // ambiguous rows would otherwise be 40 extra requests while he waits.
  assert.match(resolverSrc, /candidates: named\.printings/,
    'the rejection must carry the printings it was rejected for');
  assert.match(resolverSrc, /ORDER BY COALESCE\(price_trend, 0\) ASC/,
    'cheapest first -- an expensive printing must never be the default '
    + 'landing spot, because a wrong pick there is a four-figure error');
  assert.match(routeSrc, /candidates: r\.candidates \|\| null/,
    'and the response must pass them to the screen');
});
