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
