const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '../src/utils/deckIdentity.js'), 'utf8');

// BASIC LANDS POOL ACROSS PRINTINGS.
//
// Zach: "if we need 6 basic land mountains as long as we have 6 of them
// regardless of set it counts ... it should be a pool like if deck 1 needs 7
// and deck 2 needs 7 and we have 14 available each deck should be good."
//
// This is the FIRST exception to exact identity, so it is worth pinning hard.
// The danger is not the exception itself but half of it: if ownership pools and
// claims do not, two decks are covered by the same cardboard.
//
// Verified live under forced scarcity (42 + 7 wanted, 44 owned):
//     I Am Iron Man  want 42  elsewhere  0  avail 44  MISSING 0
//     Ur-Dragon      want  7  elsewhere 42  avail  2  MISSING 5
// The shortfall lands on the lower-priority deck, and the pool is not
// over-promised.

// Comments discuss basics at length; the rules must be read from CODE.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  .filter(l => !l.trim().startsWith('//')).join('\n');

test('BLP-TC1: ownership pools basics by name, not by printing', () => {
  const i = code.indexOf('async function ownedQuantity');
  const body = code.slice(i, code.indexOf('\n}', i));
  assert.match(body, /cc\.name = \?/,
    'the pooled branch must match on the card NAME');
  assert.match(body, /type_line LIKE 'Basic Land%'/,
    'and must restrict the pool to basic lands');
});

test('BLP-TC2: claims pool too, or two decks share one card', () => {
  const i = code.indexOf('async function requirementsForVariant');
  const body = code.slice(i, code.indexOf('\n}\n', i));
  assert.match(body, /type_line LIKE 'Basic Land%'/,
    'competitors for a basic must be found by name, not desired_card_id');
  assert.match(body, /cc\.name = \?/, 'joined through card_cache on name');
});

test('BLP-TC3: the pool is still scoped to the collection list', () => {
  // A wishlist Mountain is a Mountain he does NOT have. Pooling must not
  // quietly widen what counts as owned.
  const i = code.indexOf('async function ownedQuantity');
  const body = code.slice(i, code.indexOf('\n}', i));
  const pooled = body.slice(body.indexOf('cc.name = ?') - 400,
                            body.indexOf('cc.name = ?') + 200);
  assert.match(pooled, /list_type = 'collection'/,
    'the pooled query must exclude wishlist rows');
});

test('BLP-TC4: snow-covered lands are NOT pooled with basics', () => {
  // 'Basic Snow Land — Mountain' does not start with 'Basic Land', so the
  // prefix test excludes it. Snow lands are a different card and are not
  // interchangeable with a plain Mountain.
  const fn = code.slice(code.indexOf('function isBasicLandTypeLine'),
                        code.indexOf('async function ownedQuantity'));
  assert.match(fn, /startsWith\(BASIC_LAND_PREFIX\)/,
    'must be a prefix test, not a substring search');
  assert.ok(!/includes\(['"]Basic Land/.test(fn),
    'a substring test would wrongly match "Basic Snow Land"');
});

test('BLP-TC5: only basics are pooled; everything else stays exact', () => {
  // The whole app rests on exact identity -- a $10,000 Cavern of Souls must
  // never be covered by a $50 one. The exact query must survive.
  const i = code.indexOf('async function ownedQuantity');
  const body = code.slice(i, code.indexOf('\n}', i));
  assert.match(body, /card_id = \? AND finish = \?/,
    'the exact-identity path must remain for non-basics');
});

test('BLP-TC6: the deck LIST query pools basics too', () => {
  // Zach: "the count of cards we have out of 100 is wrong. Says ur dragon is 97
  // out of 100 but when I go into deck it's 100 out of 100."
  //
  // The list query reimplements deckIdentity's rule in SQL for speed -- one
  // query for every deck instead of a round trip each. It therefore has to
  // learn every exception deckIdentity learns, and this is the SECOND copy of
  // the rule, which is exactly how the coverage bug happened.
  //
  // Two surfaces disagreeing about one deck is worse than either being wrong:
  // it tells him the app does not know.
  const route = fs.readFileSync(
    path.join(__dirname, '../src/routes/decks.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('--') && !l.trim().startsWith('//'))
    .join('\n');
  const i = route.indexOf("router.get('/'");
  const listQuery = route.slice(i, route.indexOf('ORDER BY d.created_at', i));

  assert.match(listQuery, /dcc\.type_line LIKE 'Basic Land%'/,
    'the list query must apply the basic-land pool');
  assert.match(listQuery, /LEFT JOIN card_cache dcc/,
    'and must join the catalogue row it tests');
  // Supply AND claims, or two decks are covered by the same cardboard.
  const occurrences = (listQuery.match(/type_line LIKE 'Basic Land%'/g) || []).length;
  assert.ok(occurrences >= 3,
    `expected pooling in both the owned and claimed subqueries, found ${occurrences}`);
});
