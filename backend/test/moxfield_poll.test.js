const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const poll = read('utils/moxfieldPoll.js');
const sync = read('utils/moxfieldSync.js');
const server = read('server.js');

// BACKGROUND POLLING.
//
// Zach: "I would typically be building the decks in moxfield and then having
// them sync to Bindarr". Detection must be automatic; APPLYING must not be --
// a decklist rewriting itself overnight is the silent state change he has
// ruled out.
//
// Every test here guards a bug that reached the running server tonight and was
// found by executing the poll, not by reading it.

test('MXP-TC1: the poll reads Moxfield\'s own key names', () => {
  // The first run reported "checked 0" AND success. getAuthorDeckSummaries
  // returns raw API rows keyed publicId / lastUpdatedAtUtc, and I built the
  // lookup on public_id, so every deck missed and the loop skipped all of
  // them -- silently, looking healthy forever.
  assert.match(poll, /d\.publicId/,
    'the deck map must key on Moxfield\'s publicId');
  assert.match(poll, /upstream\.lastUpdatedAtUtc/,
    'and read Moxfield\'s lastUpdatedAtUtc');
  assert.doesNotMatch(poll, /d\.public_id\]/,
    'snake_case here silently matches nothing');
});

test('MXP-TC2: both timestamp columns are written in the same format', () => {
  // moxfield_updated_at held Moxfield ISO ('2026-09-03T16:09:06.33Z') and
  // moxfield_synced_at held SQLite's CURRENT_TIMESTAMP ('2026-09-04 12:04:21').
  // The drift check compares them as strings, and on the same day ' ' vs 'T'
  // inverts the answer -- so it could hide a real change or invent one.
  const i = sync.indexOf('UPDATE decks SET moxfield_synced_at');
  const stmt = sync.slice(i, i + 320);
  assert.doesNotMatch(stmt, /moxfield_synced_at = CURRENT_TIMESTAMP/,
    'synced_at must hold the upstream stamp, not SQLite local time');
  assert.match(stmt, /moxfield_synced_at = \?/,
    'both columns must be parameterised with the same value');
});

test('MXP-TC3: the poll never applies a sync', () => {
  // Detection is automatic; applying is his decision. A deck he curated
  // changing under him with nothing to point at is the failure he cares about.
  assert.doesNotMatch(poll, /applySync/,
    'the background poll must never apply changes');
  assert.match(poll, /planSync/, 'it plans, so it can report what differs');
});

test('MXP-TC4: an unchanged deck costs no extra request', () => {
  // One author-list call covers every deck; a full fetch happens only when the
  // upstream timestamp has moved. Without the short-circuit the poll would hit
  // Moxfield once per deck every few hours, which is how a scraper gets
  // blocked.
  assert.match(poll, /if \(seen && now && seen === now\) continue;/,
    'unchanged decks must short-circuit before getDeckDetails');
});

test('MXP-TC5: a missing upstream deck never deletes the local one', () => {
  // The search index has already been observed listing a deck that returns 404.
  // Treating its silence as "deleted" would let a transient index gap wipe a
  // decklist he spent an evening curating.
  const i = poll.indexOf('if (!upstream)');
  const branch = poll.slice(i, i + 200);
  assert.match(branch, /continue;/, 'a missing upstream deck must be skipped');
  assert.doesNotMatch(branch, /DELETE|remove/i,
    'and must never trigger a deletion');
});

test('MXP-TC6: the poll is scheduled, disablable, and cannot crash the server', () => {
  assert.match(server, /MOXFIELD_POLL !== 'off'/, 'must be disablable');
  assert.match(server, /setInterval\(tick/, 'must actually be scheduled');
  assert.match(server, /\.catch\(err => console\.error\('Moxfield poll failed/,
    'a background job must never take the process down');
});

test('MXP-TC7: the poll interval is minutes, and defaults to five', () => {
  // Zach: "6 hrs is way to long can it be every 5 mins?"
  //
  // The interval used to be expressed in HOURS. A units slip here is silent --
  // 1000 * 60 * 60 * minutes still runs, just sixty times too slowly, and
  // nothing fails except that he stops seeing his edits.
  assert.match(server, /MOXFIELD_POLL_MINUTES\) \|\| 5/,
    'the default must be five minutes');
  assert.match(server, /setInterval\(tick, 1000 \* 60 \* minutes\)/,
    'and the interval must be minutes, not hours');
  assert.doesNotMatch(server, /1000 \* 60 \* 60 \* minutes/,
    'an hours multiplier would make "every 5 minutes" mean every 5 hours');
  assert.match(server, /Math\.max\(1, Number\(process\.env\.MOXFIELD_POLL_MINUTES\)/,
    'a floor stops a stray 0 turning this into a tight loop against Moxfield');
});

test('MXP-TC8: the deck DETAIL endpoint sends the drift flag', () => {
  // Zach: "my I am iron man deck has the updated banner but nothing in the deck
  // view lets me update it."
  //
  // The deck view's sync banner is gated on deck.moxfield_changed. /decks/:id
  // does `SELECT *` and spreads the row, which returns the raw COLUMNS but not
  // that DERIVED flag -- so the gate was permanently undefined and the banner
  // was dead code that builds, lints and tests clean.
  //
  // Found by asking the running server what it sends. Reading the route would
  // not have shown it: `...deck` looks like it returns everything.
  const routes = fs.readFileSync(
    path.join(__dirname, '../src/routes/decks.js'), 'utf8');
  const i = routes.indexOf("router.get('/:id'");
  const handler = routes.slice(i, routes.indexOf('});', i));
  assert.match(handler, /moxfield_changed:/,
    'the deck detail response must carry the drift flag, not just the columns');
  assert.match(handler, /moxfield_updated_at > deck\.moxfield_synced_at/,
    'and derive it from the same two columns the list query compares');
});

test('MXP-TC9: the deck view can act on the drift it reports', () => {
  // A badge that says "UPDATED" with no way to update is a dead end -- the same
  // shape as the printing switch that could be entered and not left. Detection
  // and action must live on the same screen.
  const view = fs.readFileSync(
    path.join(__dirname, '../../frontend/src/components/DeckView.jsx'), 'utf8');
  assert.match(view, /moxfield\/decks\/\$\{deck\.moxfield_public_id\}\/sync/,
    'the deck view must be able to trigger a sync');
  assert.match(view, /deck\?\.moxfield_public_id && deck\?\.moxfield_changed/,
    'and show the control only when there is something to sync');
});

test('MXP-TC10: the drift banner carries every element of the approved mock', () => {
  // Zach: "this is what your mock looked like and this is what I expected."
  //
  // I shipped a one-line strip where sketches/015 has a title, subtitle, three
  // count chips, the printings-stay reassurance, two actions, and a
  // collapsible breakdown grouped Adding / Removing / Moving board.
  //
  // He has said an approved mockup means pixel and label fidelity, not "same
  // spirit". This pins the elements so the next edit cannot quietly drop one.
  const view = fs.readFileSync(
    path.join(__dirname, '../../frontend/src/components/DeckView.jsx'), 'utf8');
  const en = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../frontend/src/locales/en.json'), 'utf8'));

  for (const key of ['deck.moxfieldDriftedTitle', 'deck.moxfieldDrifted',
                     'deck.driftAdded', 'deck.driftRemoved', 'deck.driftMoved',
                     'deck.driftPrintingsKept', 'deck.driftSyncNow',
                     'deck.driftSeeChanges', 'deck.driftGroupAdding',
                     'deck.driftGroupRemoving', 'deck.driftGroupMoving',
                     'deck.driftUsingYourCopy', 'deck.lastSynced']) {
    assert.ok(view.includes(`t('${key}'`), `the banner must render ${key}`);
    assert.ok(key in en, `${key} must have an English string`);
  }

  // The mock's exact words, because a paraphrase is what he objected to.
  assert.equal(en['deck.moxfieldDriftedTitle'], 'Moxfield has changes');
  assert.equal(en['deck.moxfieldDrifted'],
    'You edited this deck on Moxfield after the last sync.');
  assert.equal(en['deck.driftSyncNow'], 'Sync now');
  assert.equal(en['deck.driftSeeChanges'], 'See what changes');
  assert.equal(en['deck.driftGroupMoving'], 'Moving board — printing kept');
});

test('MXP-TC11: the preview names the printing the sync will actually store', () => {
  // The mock tags adds "using your copy". Only applySync used to know which
  // adds get substituted, so the preview showed MOXFIELD's printing and the
  // apply stored a different one -- he would approve a plan naming C20 #253 and
  // get MSH #80. A preview that disagrees with its own outcome is the
  // wrong-record failure with an extra step.
  const sync = fs.readFileSync(
    path.join(__dirname, '../src/utils/moxfieldSync.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const i = sync.indexOf('async function planSync');
  const body = sync.slice(i, sync.indexOf('\nasync function', i + 10));
  assert.match(body, /preferOwnedPrinting/,
    'planSync must resolve the owned-printing preference, not just applySync');
  assert.match(body, /uses_owned_copy = true/,
    'and mark which adds use a copy he already owns');
  assert.match(body, /uses_owned:/,
    'and total them for the banner\'s reassurance line');
});
