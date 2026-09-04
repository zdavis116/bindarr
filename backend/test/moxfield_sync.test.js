const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { rowsFromPayload, summarise } = require('../src/utils/moxfieldPayload');

const apiSrc = fs.readFileSync(
  path.join(__dirname, '../src/utils/moxfieldApi.js'), 'utf8');
const syncSrc = fs.readFileSync(
  path.join(__dirname, '../src/utils/moxfieldSync.js'), 'utf8');
const routeSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/moxfield.js'), 'utf8');

// MOXFIELD SYNC.
//
// Zach builds decks in Moxfield and wants Bindarr to follow them so he can see
// what he owns versus what he must buy. The contract he stated:
//
//   MOXFIELD owns the card list.
//   BINDARR  owns the printing -- "when we sync it should automatically use the
//            printing of the card we have 1 available."

const payload = (boards) => ({ publicId: 'abc', name: 'D', boards });
const card = (id, extra = {}) => ({ quantity: 1, card: { scryfall_id: id, name: id, ...extra } });

test('MFX-TC1: a deck built locally is never touched', () => {
  // Zach: "shouldn't moxfield decks have their own specific ids so decks built
  // locally will be untouched". moxfield_public_id NULL means local.
  assert.match(routeSrc, /WHERE user_id = \? AND moxfield_public_id = \?/,
    'sync only ever selects decks by their Moxfield id');
  assert.doesNotMatch(routeSrc, /FROM decks WHERE user_id = \?\s*`\s*,/,
    'it must never operate on every deck of a user');
});

test('MFX-TC2: the diff ignores printing AND finish', () => {
  // The first version keyed on finish. preferOwnedPrinting then swapped two
  // cards to FOIL promos he owns, and every later sync read those rows as
  // "remove the nonfoil, add the foil" -- two rows churning forever, a
  // repeating silent state change.
  //
  // If the sync is allowed to choose the finish, the finish cannot be part of
  // the identity it diffs on.
  assert.match(syncSrc, /function oracleKey\(oracleId, board\)/,
    'the key is card + board, nothing else');
  assert.doesNotMatch(syncSrc, /oracleKey\([^)]*finish[^)]*\)/,
    'a finish the sync can change must not be part of its identity');
});

test('MFX-TC3: an unknown card is reported, never invented', () => {
  // The importer's admission boundary: a sync may reference cards already in
  // card_cache and must NEVER insert into it.
  assert.match(syncSrc, /reason: 'not_in_catalogue'/,
    'unresolvable cards are reported');
  const code = syncSrc.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /INSERT INTO card_cache/i,
    'the sync must not write to the catalogue');
});

test('MFX-TC4: a checked-out row is never removed', () => {
  // A physical card is allocated against it; removing the row leaves an
  // allocation describing a card no deck wants.
  assert.match(syncSrc, /if \(have\.checked_out\) \{[\s\S]{0,160}reason: 'checked_out'/,
    'checked-out rows are skipped and reported');
});

test('MFX-TC5: applying is all or nothing', () => {
  assert.match(syncSrc, /await db\.run\('BEGIN'\)/);
  assert.match(syncSrc, /await db\.run\('COMMIT'\)/);
  assert.match(syncSrc, /ROLLBACK/);
});

test('MFX-TC6: additions prefer a printing he owns and has FREE', () => {
  // Zach: "use the printing of the card we have 1 available". Availability, not
  // ownership: a copy sleeved in another deck is not available. That rule lives
  // in deckIdentity via deckRepoint -- asked, not reimplemented, so the sync
  // and the "covered" badge cannot disagree about the same card.
  assert.match(syncSrc, /require\('\.\/deckRepoint'\)/,
    'the claim rule is imported');
  assert.match(syncSrc, /alternativesForRequirement\(db, userId, probe\)/);
  assert.match(syncSrc, /if \(current\.quantity_available >= row\.quantity\) return null/,
    'a printing that already works is left alone');
});

test('MFX-TC7: browser headers are required and must not be dropped', () => {
  // Measured from the container: no headers -> 403, Accept only -> 403,
  // full browser headers -> 200. These are load-bearing, not decoration.
  // Match the HEADERS OBJECT, not the file: my own comment above it explains
  // the 403 measurements and names every header, so a file-wide search matched
  // the documentation and passed with the header deleted. Second time today a
  // test read its own explanation. Comments are not code.
  const block = apiSrc.slice(apiSrc.indexOf('const HEADERS = {'),
                             apiSrc.indexOf('};', apiSrc.indexOf('const HEADERS = {')));
  // Match each header as a KEY, quoted. Searching for the bare substring
  // 'sec-ch-ua' passed even with that header deleted, because 'sec-ch-ua-mobile'
  // and 'sec-ch-ua-platform' contain it. A substring is not a key.
  for (const h of ['User-Agent', 'sec-ch-ua', 'Referer']) {
    const asKey = new RegExp(`(^|\\n)\\s*'?${h}'?\\s*:`, 'm');
    assert.match(block, asKey, `${h} must be sent as its own header`);
  }
});

test('MFX-TC8: a block is distinguished from a missing deck', () => {
  // 403 means Cloudflare; 404 means the deck is gone. They call for opposite
  // reactions, so the error must say which.
  assert.match(apiSrc, /status === 403[\s\S]{0,200}Cloudflare/,
    '403 is reported as a block');
  assert.match(apiSrc, /status === 404[\s\S]{0,120}not found/,
    '404 is reported as missing');
  assert.match(apiSrc, /non-JSON body \(HTTP 200\)/,
    'a 200 carrying an interstitial must be refused, not parsed');
});

test('MFX-TC9: a mistyped username never syncs someone else', () => {
  // The fork falls back to entries[0]. That silently mirrors a DIFFERENT
  // person's decks when the name is wrong -- a wrong record with no visible
  // cause.
  assert.match(apiSrc, /const match = entries\.find\([\s\S]{0,160}toLowerCase\(\)\);/,
    'only an exact case-insensitive match is accepted');
  assert.doesNotMatch(apiSrc, /\|\|\s*entries\[0\]/,
    'no positional fallback');
});

test('MFX-TC10: boards that are not requirements are dropped', () => {
  const { rows } = rowsFromPayload(payload({
    mainboard: { cards: { a: card('id-a') } },
    tokens:    { cards: { b: card('id-b') } },
    stickers:  { cards: { c: card('id-c') } }
  }));
  assert.equal(rows.length, 1, 'tokens and stickers are not deck requirements');
  assert.equal(rows[0].board, 'mainboard');
});

test('MFX-TC11: a zero quantity is rejected, not defaulted to one', () => {
  // The ManaBox importer had exactly this bug: parseInt(x) || 1 turned an
  // explicit 0 into an owned copy.
  const { rows, skipped } = rowsFromPayload(payload({
    mainboard: { cards: {
      a: { quantity: 0, card: { scryfall_id: 'id-a', name: 'A' } },
      b: { quantity: 2, card: { scryfall_id: 'id-b', name: 'B' } }
    } }
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 2);
  assert.equal(skipped[0].reason, 'bad_quantity');
});

test('MFX-TC12: duplicate rows are merged, not left to break the insert', () => {
  // UNIQUE(deck_id, oracle_id, desired_card_id, desired_finish, board) would
  // reject the second row and fail a sync halfway through.
  const { rows } = rowsFromPayload(payload({
    mainboard: { cards: {
      a: { quantity: 1, card: { scryfall_id: 'same', name: 'A' } },
      b: { quantity: 3, card: { scryfall_id: 'same', name: 'A' } }
    } }
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 4, 'quantities are combined');
});

test('MFX-TC13: etched is not folded into foil', () => {
  // Separately priced physical objects; the distinction cannot be recovered.
  const { rows } = rowsFromPayload(payload({
    mainboard: { cards: {
      a: { quantity: 1, finish: 'etched', card: { scryfall_id: 'e', name: 'E' } },
      b: { quantity: 1, finish: 'foil',   card: { scryfall_id: 'f', name: 'F' } }
    } }
  }));
  assert.deepEqual(rows.map(r => r.finish).sort(), ['etched', 'foil']);
});

test('MFX-TC14: a card with no scryfall id is reported', () => {
  const { rows, skipped } = rowsFromPayload(payload({
    mainboard: { cards: { a: { quantity: 1, card: { name: 'Nameless' } } } }
  }));
  assert.equal(rows.length, 0);
  assert.equal(skipped[0].reason, 'no_scryfall_id');
});

test('MFX-TC15: the summary carries Moxfield\'s own change stamp', () => {
  // lastUpdatedAtUtc makes change detection one cheap list call instead of a
  // full fetch per deck.
  const s = summarise({ publicId: 'p', name: 'N', lastUpdatedAtUtc: '2026-01-01T00:00:00Z',
                        boards: { mainboard: { cards: { a: card('x') } } } });
  assert.equal(s.last_updated_at, '2026-01-01T00:00:00Z');
  assert.equal(s.total_cards, 1);
});
