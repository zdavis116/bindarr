// Clicking a set shows every card in it, missing ones greyed out.
//
// Zach: "I would like to be able to click on the set and see all cards showing
// the ones I have and the ones I am missing" / "Grayed out card image" /
// "Show everything with missing grayed out" / "I think it would be cool to
// reuse the card detail pane we have. Same as when on deck view for cards I
// dont own."
//
// Verified against his real data on dev: /api/set-cards/fra returns 461 rows,
// 288 owned, 173 missing, every one with an image -- and 288 matches the
// completion figure on the previous screen exactly.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const route = readFileSync(join(REPO, 'backend/src/routes/collection.js'), 'utf8');
const view = readFileSync(join(HERE, 'SetCardsView.jsx'), 'utf8');
const collector = readFileSync(join(HERE, 'CollectorView.jsx'), 'utf8');
const list = readFileSync(join(HERE, 'CollectionList.jsx'), 'utf8');
const css = readFileSync(join(HERE, '..', 'styles', 'collector-view.css'), 'utf8');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// SET-TC1: the endpoint returns the WHOLE set, not just what he owns.
//
// A LEFT JOIN is the entire feature. An inner join would return only owned
// cards -- the screen would look fine and show nothing missing.
{
  start('SET-TC1');
  const q = /router\.get\('\/set-cards\/:code'[\s\S]*?\n\}\);/.exec(route);
  assert.ok(q, '/set-cards could not be found');
  assert.match(q[0], /FROM card_cache c\s*\n\s*LEFT JOIN/,
    'the query must start from the CATALOGUE and LEFT JOIN what he owns; '
    + 'starting from the collection would return only owned cards and the '
    + 'missing list would always be empty');
  assert.match(q[0], /CAST\(c\.number AS INTEGER\) BETWEEN 1 AND \?/,
    'the same 1..total range the completion count uses, or the two screens '
    + 'disagree about how big the set is');
  assert.match(q[0], /GROUP BY c\.number/,
    'one row per collector number, matching how completion is counted');
  pass('SET-TC1', 'the whole set is returned, owned flagged');
}

// SET-TC2: the set code cannot be used to reach anything else.
{
  start('SET-TC2');
  const q = /router\.get\('\/set-cards\/:code'[\s\S]*?\n\}\);/.exec(route)[0];
  assert.match(q, /\/\^\[a-z0-9\]\{1,10\}\$\//,
    'the set code is interpolated into a lookup and must be validated');
  assert.match(q, /\[req\.user\.id, code, set\.total\]/,
    'user id, code and total must all be bound parameters');
  pass('SET-TC2', 'the set code is validated and bound');
}

// SET-TC3: missing cards are greyed, not hidden.
{
  start('SET-TC3');
  assert.match(css, /\.sc-card\.missing img \{ filter: grayscale\(1\)/,
    'missing cards must be greyed -- "Grayed out card image"');
  assert.ok(!/\.sc-card\.missing \{[^}]*display:\s*none/.test(css),
    'missing cards must stay visible -- "Show everything with missing '
    + 'grayed out"');
  assert.match(view, /className=\{`sc-card\$\{c\.owned \? '' : ' missing'\}`\}/,
    'the missing class must be driven by ownership');
  pass('SET-TC3', 'missing cards are visible and greyed');
}

// SET-TC4: A CARD HE DOES NOT OWN IS OPENED READ-ONLY.
//
// This is the one that can corrupt data. A missing card has no collection
// row. If the inspector is handed an entry_id anyway, saving would PUT
// through an id belonging to a DIFFERENT card and silently rewrite it -- the
// exact failure the deck view's readOnly guard exists to prevent.
{
  start('SET-TC4');
  assert.match(list, /entry_id: c\.owned \? c\.entry_id : undefined/,
    'a card he does not own must NOT carry an entry id into the inspector');
  assert.match(list, /__readOnly: !c\.owned/,
    'unowned cards must be marked read-only');
  const sites = list.match(/<CardInspectorModal/g) || [];
  const guards = list.match(/readOnly=\{!!inspectorCard\.__readOnly\}/g) || [];
  assert.strictEqual(guards.length, sites.length,
    `${sites.length} inspector render sites but only ${guards.length} pass `
    + 'readOnly; the desktop pane and the phone modal must both honour it, '
    + 'or the guard holds on one surface and not the other');
  pass('SET-TC4', 'unowned cards open read-only on both surfaces');
}

// SET-TC5: 461 cards are not all rendered at once.
//
// The collection screen already learned this: 2,438 tiles cost 3.35s on a
// phone. Reality Fracture is 461.
{
  start('SET-TC5');
  assert.match(view, /const PAGE = \d+;/, 'a page size must be defined');
  assert.match(view, /shown\.slice\(0, limit\)/,
    'the grid must render a slice, not the whole set');
  assert.match(view, /setLimit\(l => l \+ PAGE\)/,
    'there must be a way to load more');
  assert.match(view, /useEffect\(\(\) => \{ setLimit\(PAGE\); \}, \[q, onlyMissing\]\);/,
    'the page must reset when the filter changes, or a narrowed list '
    + 'inherits a limit from a longer one');
  pass('SET-TC5', 'cards are paged, not dumped');
}

// SET-TC6: the set list opens the set, and can get back.
{
  start('SET-TC6');
  assert.match(collector, /onClick=\{\(\) => setOpenSet\(s\.code\.toLowerCase\(\)\)\}/,
    'a set row must open its cards -- "be able to click on the set"');
  assert.match(view, /onClick=\{onBack\}/,
    'there must be a way back to the set list');
  assert.match(css, /\.cv-row \{[\s\S]*?text-align: left;/,
    'cv-row became a <button>; without the resets the browser restyles '
    + 'every row (centred text, its own font, a border)');
  pass('SET-TC6', 'sets open and close');
}

console.log(`\nsetCardsView.test.js: ${passed} cases passed`);
