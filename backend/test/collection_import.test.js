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
  assert.match(routeSrc, /rejections: rejected\.map/,
    'and the response must carry every rejection back');
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
