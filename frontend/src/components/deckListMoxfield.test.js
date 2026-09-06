// THE DECK LIST KEEPS THE DECK-LEVEL SYNC AND NOTHING ELSE.
//
// Zach, after using the deployed build:
//
//   "I like that the decks automatically show up in the deck list with a sync
//    button to sync it to Bindarr so I think that moxfield sync button is
//    unneeded. But I would like to see the moxfield sync data in settings.
//    Because technically there is 2 syncs with moxfield. The deck list sync and
//    then the individual deck syncs."
//
// Two syncs, two homes:
//   ACCOUNT level (link, check now, unlink) -> Settings > Data sources
//   DECK level    (pull this deck's list)   -> here
//
// This file pins the deck-list half. settingsSources.test.js pins the other.
// Without both, "no duplicate surface" is an intention rather than a rule, and
// the last time it was only an intention the mock went unbuilt for weeks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'DeckList.jsx'), 'utf8');
const en = JSON.parse(readFileSync(join(here, '../locales/en.json'), 'utf8'));

test('MXP-TC12: the account-level Moxfield panel is gone from the deck list', () => {
  // The modal duplicated the deck list it was rendered on top of. Deleting the
  // button but leaving the component import behind would let it come back by
  // accident, so the file itself must be gone.
  assert.ok(!existsSync(join(here, 'MoxfieldPanel.jsx')),
    'MoxfieldPanel.jsx must be deleted, not merely unrendered');
  assert.doesNotMatch(src, /MoxfieldPanel/,
    'no import or render of the old panel');
  assert.doesNotMatch(src, /moxfieldOpen/,
    'no leftover open/closed state for a panel that no longer exists');
  assert.ok(!('decks.syncMoxfield' in en),
    'the button label must go with the button');
});

test('MXP-TC13: the per-deck Sync button survives', () => {
  // This is the half Zach explicitly said he likes. The risk of the deletion
  // above was taking this with it.
  assert.match(src, /moxfieldAvailable\.map/,
    'unsynced Moxfield decks must still be listed');
  assert.match(src, /moxfield\/decks\/\$\{deck\.public_id\}\/sync/,
    'each listed deck must still be syncable from here');
  assert.match(src, /moxfield\.sync/,
    'and the button must still be labelled');
});

test('MXP-TC14: the deck list never offers account-level controls', () => {
  // Linking or unlinking from here would rebuild the surface just removed.
  for (const forbidden of [/moxfield\/account/, /moxfield\/check/]) {
    assert.doesNotMatch(src, forbidden,
      'account-level Moxfield calls belong to Settings, not the deck list');
  }
});
