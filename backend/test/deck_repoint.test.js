const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// SWITCHING A DECK ROW TO A PRINTING YOU ACTUALLY HAVE.
//
// Zach's Moxfield import gave each deck row a SPECIFIC printing; his ManaBox
// import gave his collection DIFFERENT printings of the same cards. Neither is
// wrong -- they disagree, and the deck then reports a card as missing while a
// copy sits on the shelf. 38 of his 90 deck rows were in that state.
//
// His requirement, verbatim: "we could own 1 but it could be in another deck
// so we need to own it and it needs to be available."

const repointSrc = fs.readFileSync(
  path.join(__dirname, '../src/utils/deckRepoint.js'), 'utf8');
const routeSrc = fs.readFileSync(
  path.join(__dirname, '../src/routes/decks.js'), 'utf8');

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

test('RP-TC1: availability comes from the module that owns the claim rule', () => {
  // deckIdentity.js already decides who gets a copy: deck_cards.id ASC, and a
  // `considering` entry claims nothing. A second calculation here would
  // eventually disagree with the "covered" badge about the same card, and then
  // two screens tell different stories.
  assert.match(repointSrc, /require\('\.\/deckIdentity'\)/,
    'the claim rule must be imported, not reimplemented');
  assert.match(repointSrc, /availabilityForRequirement\(database, userId, probe\)/,
    'each alternative must be asked the same availability question');

  const code = stripComments(repointSrc);
  assert.doesNotMatch(code, /SELECT[\s\S]{0,200}FROM deck_cards[\s\S]{0,200}SUM\(/i,
    'availability must not be recomputed with raw SQL here');
});

test('RP-TC2: owning a copy is not enough -- it must be FREE', () => {
  // Zach's exact requirement. A copy claimed by another deck is not a
  // candidate, however many he owns.
  assert.match(repointSrc, /if \(avail\.quantity_available >= req\.quantity\)/,
    'the gate is AVAILABLE quantity, not owned quantity');
  assert.doesNotMatch(repointSrc, /if \(avail\.quantity_owned >= req\.quantity\)/,
    'owning it is not the test');
});

test('RP-TC3: reserves is derived from the board, never trusted', () => {
  // availabilityForRequirement tests `reserves === true`, so a missing field
  // silently means non-reserving -- and a non-reserving requirement is told
  // the FULL availability, ignoring other decks' claims. That is precisely the
  // guarantee Zach asked for, so it cannot depend on a caller remembering.
  assert.match(repointSrc, /reserves: requirement\.reserves \?\? entryReserves\(requirement\.board\)/,
    'reserves must be derived from the board when absent');
});

test('RP-TC4: an ambiguous row is never auto-applied', () => {
  // More than one free printing is a CHOICE. Guessing which card goes in a
  // deck is a wrong record he would only find by counting cardboard.
  assert.match(routeSrc, /if \(alternatives\.length > 1\) \{[\s\S]{0,120}reason: 'ambiguous'/,
    'multiple candidates must be skipped and reported, not guessed');
  assert.match(routeSrc, /unambiguous: alternatives\.length === 1/,
    'and the candidate list must flag which are safe to apply');
});

test('RP-TC5: the sweep recomputes per row, not from a stale list', () => {
  // Each swap CONSUMES a copy. A second row wanting the same printing must see
  // it already taken -- applying a precomputed list would hand the same
  // physical card to two decks.
  const post = routeSrc.slice(routeSrc.indexOf("router.post('/:id/repoint'"));
  const loopAt = post.indexOf('for (const row of rows)');
  const callAt = post.indexOf('alternativesForRequirement', loopAt);
  assert.ok(loopAt > 0 && callAt > loopAt,
    'availability must be recomputed inside the loop');
});

test('RP-TC6: a checked-out row is never repointed', () => {
  // A checked-out row has a PHYSICAL card allocated against it. Repointing it
  // leaves the allocation describing a card the deck no longer wants, and the
  // only way to discover that is counting cardboard.
  assert.match(repointSrc, /if \(row\.checked_out\) return \{ ok: false, reason: 'checked_out' \}/,
    'the helper must refuse');
  assert.match(routeSrc, /if \(row\.checked_out\) \{ skipped\.push/,
    'and the sweep must skip and report it');
});

test('RP-TC7: repointing onto an existing row merges rather than failing', () => {
  // UNIQUE(deck_id, oracle_id, desired_card_id, desired_finish, board) means
  // the target may already exist. Two rows for the same card, printing, finish
  // and board is not a state the deck screen can show.
  assert.match(repointSrc, /UPDATE deck_cards SET quantity = quantity \+ \? WHERE id = \?/,
    'quantities must be combined');
  assert.match(repointSrc, /DELETE FROM deck_cards WHERE id = \?/,
    'and the emptied row removed');
});

test('RP-TC8: a half-applied sweep is impossible', () => {
  // Across 38 rows, a partial apply leaves him unable to tell which decklist
  // he is holding.
  const post = routeSrc.slice(routeSrc.indexOf("router.post('/:id/repoint'"));
  assert.match(post, /await db\.run\('BEGIN'\)/);
  assert.match(post, /await db\.run\('COMMIT'\)/);
  assert.match(post, /ROLLBACK/);
  assert.match(post, /Nothing was changed/);
});

test('RP-TC9: finish changes are included, by explicit decision', () => {
  // Asked directly whether to exclude them, Zach said: "if I already own it
  // idc if it changes the price of what the deck is worth". A nonfoil he HAS
  // beats a foil he does not.
  //
  // So same-finish-first is a TIEBREAK, not a gate.
  assert.match(repointSrc, /const af = a\.finish === req\.desired_finish \? 0 : 1/,
    'same finish sorts first');
  const code = stripComments(repointSrc);
  assert.doesNotMatch(code, /if \(v\.finish !== req\.desired_finish\) continue/,
    'but a different finish must NOT be filtered out');
});

test('RP-TC10: the candidate list writes nothing', () => {
  // He sees what would change before anything does.
  const get = routeSrc.slice(routeSrc.indexOf("router.get('/:id/repoint-candidates'"),
                             routeSrc.indexOf("router.post('/:id/repoint'"));
  assert.doesNotMatch(get, /UPDATE |DELETE |INSERT /i,
    'the candidates route must be read-only');
});

test('RP-TC11: routes are relative to the /api/decks mount', () => {
  // decks.js mounts at /api/decks; collection.js mounts at bare /api. I used
  // the wrong convention and got a 404 -- the same mount-point mistake this
  // project has produced before.
  assert.match(routeSrc, /router\.get\('\/:id\/repoint-candidates'/);
  assert.match(routeSrc, /router\.post\('\/:id\/repoint'/);
  assert.doesNotMatch(routeSrc, /router\.(get|post)\('\/decks\/:id\/repoint/,
    'a /decks prefix here resolves to /api/decks/decks/:id');
});

const collectionSrc = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '../src/routes/collection.js'), 'utf8');
const modalSrc = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '../../frontend/src/components/CardInspectorModal.jsx'),
  'utf8');
const deckViewSrc = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '../../frontend/src/components/DeckView.jsx'),
  'utf8');

test('RP-TC12: the per-card switch exists, not just the sweep', () => {
  // Zach asked for BOTH and I built only the batch. His objection is the
  // reason the per-card control matters: "I might not want to do all 34, some
  // I might want to leave as that printing."
  //
  // A one-tap sweep with no per-card control forces an all-or-nothing decision
  // over 34 separate judgements.
  assert.match(modalSrc, /const assignPrintingToDeck = async \(pr\) => \{/,
    'the sheet must be able to repoint a single row');
  assert.match(modalSrc, /deck_card_id: deckCardId/,
    'and target the deck row it was opened from');
  assert.match(modalSrc, /t\('inspector\.useThisPrinting'\)/,
    'with a visible control');
});

test('RP-TC13: the per-card button is REACHABLE from the deck', () => {
  // It is gated on deckCardId. A missing prop means the feature looks built
  // and does nothing -- this project's most repeated failure.
  assert.match(deckViewSrc, /deckCardId=\{inspecting\?\.id\}/,
    'DeckView must pass the deck row id');
  assert.match(deckViewSrc, /deckId=\{deck\?\.id\}/,
    'and the deck id');
  assert.match(deckViewSrc, /onRepointed=\{\(\) => \{ onChanged && onChanged\(\); \}\}/,
    'and reload the deck afterwards, or the old printing stays on screen');
});

test('RP-TC14: the button only appears where the swap would work', () => {
  // Offered only when a FREE copy exists -- owning one that is sleeved in
  // another deck is not the same as having one. A button that looks available
  // and then fails is worse than no button.
  assert.match(modalSrc, /deckCardId && \(pr\.quantity_available \|\| 0\) > 0/,
    'availability gates the button, not ownership');
  assert.match(modalSrc, /pr\.id !== \(deckUse\?\.card_id \|\| catalogueId\)/,
    'and the printing already in use offers no swap');
});

test('RP-TC15: a per-card swap asks for the finish he OWNS', () => {
  // The point is to use the physical card on the shelf, not the finish the
  // deck happened to record. Zach: "if I already own it idc if it changes the
  // price of what the deck is worth."
  assert.match(modalSrc, /finish: pr\.owned_finish \|\| pr\.finish \|\| 'nonfoil'/,
    'the owned finish wins');
  assert.match(collectionSrc, /MIN\(col\.finish\)\s+AS owned_finish/,
    'and the server must report which finish he holds');
});

test('RP-TC16: availability is computed on the server', () => {
  // It is a fact about the whole collection; no single screen has the
  // information. The same reason in_deck_qty is computed server-side.
  assert.match(collectionSrc, /quantity_available: Math\.max\(0, \(p\.owned_qty \|\| 0\) - \(p\.committed_qty \|\| 0\)\)/,
    'free = owned minus committed, derived once on the server');
  assert.match(collectionSrc, /dc\.board IN \('commander', 'mainboard', 'sideboard'\)/,
    'a considering row claims nothing, so it must not count as committed');
});
