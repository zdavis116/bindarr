// DATA SOURCES OWN THEIR OWN DETAIL.
//
// Zach, after using the deployed Settings screen:
//
//   "Data sources and card catalogue they weren't separated I feel like each
//    data source should have a drop down showing like details of what it's
//    syncing. Scryfall being cards and moxfield being decks as the example."
//
// I had built two flat sections -- "Data sources" listing the catalogue, and
// "Card catalogue" holding its rows -- so the same subject appeared twice with
// no stated relationship between them. His reading is better: the catalogue
// rows ARE the Scryfall source's detail.
//
// It is also the shape that extends. Moxfield becomes a second source with its
// own detail (decks, pull-only) rather than needing another top-level section,
// which is exactly what a flat layout could not have absorbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'SettingsScreen.jsx'), 'utf8');
const en = JSON.parse(readFileSync(join(here, '../locales/en.json'), 'utf8'));

test('SET-TC1: there is no separate Card catalogue section', () => {
  // The old shape. If this key comes back, the screen has drifted back to
  // listing the same subject in two places.
  assert.doesNotMatch(src, /settings\.secCatalogue/,
    'the catalogue must not be its own top-level section');
  assert.match(src, /settings\.secDataSources/,
    'Data sources is the section that owns it');
});

test('SET-TC2: the Scryfall source expands to reveal its detail', () => {
  assert.match(src, /sourceOpen === 'scryfall'/,
    'the source must have an open/closed state');
  // The detail rows must be INSIDE that conditional, not rendered always.
  const open = src.indexOf("{sourceOpen === 'scryfall' && (");
  const refresh = src.indexOf('settings.refreshNow');
  assert.ok(open !== -1 && refresh > open,
    'Refresh now must render inside the expanded source, not beside it');
});

test('SET-TC3: only one source is open at a time', () => {
  // A phone screen cannot show two expanded sources usefully, and the toggle
  // must close the open one rather than accumulate.
  assert.match(src, /setSourceOpen\(sourceOpen === 'scryfall' \? null : 'scryfall'\)/,
    'tapping an open source must close it');
});

test('SET-TC4: the expanded state is VISIBLE, not implied', () => {
  // A row that expands with no visual change is the failure this project keeps
  // hitting: it renders, it works, and nothing tells you it did anything.
  assert.match(src, /expanded \? 'rotate\(90deg\)' : 'none'/,
    'the chevron must rotate so "expands here" reads differently from "goes somewhere"');
  assert.match(src, /indent \? '0\.7rem 1rem 0\.7rem 2\.6rem'/,
    'detail rows must be indented under their parent source');
});

test('SET-TC5: the source states WHAT it syncs, not just that it exists', () => {
  // "Scryfall" alone says nothing. Zach's example was explicit: Scryfall syncs
  // cards, Moxfield would sync decks.
  assert.ok('settings.scryfallSyncs' in en, 'a sync-description string must exist');
  assert.match(en['settings.scryfallSyncs'], /[Cc]ards/,
    'the Scryfall source must say it syncs CARDS');
  assert.match(src, /settings\.scryfallSyncs/,
    'and the screen must use it');
});

test('SET-TC6: Moxfield is a data source in Settings, expanding like Scryfall', () => {
  // HISTORY, because this test has now asserted three different things and the
  // reason matters more than the assertion.
  //
  // v1: Moxfield must not appear at all -- Zach: "You can hide the moxfield
  //     decks for now until implemented."
  // v2: Moxfield must not appear in Settings, because I had put the entry point
  //     on the deck list and wanted to stop a second surface appearing.
  // v3 (this): Zach, having used it: "I like that the decks automatically show
  //     up in the deck list with a sync button ... so I think that moxfield
  //     sync button is unneeded. But I would like to see the moxfield sync data
  //     in settings. Because technically there is 2 syncs with moxfield. The
  //     deck list sync and then the individual deck syncs."
  //
  // v2 was me locking in my OWN placement call against the mock he approved
  // (sketches/014-moxfield-settings), which is how the gap survived so long.
  // The rule now guards HIS split: ACCOUNT-level sync here, DECK-level sync on
  // the deck list.
  assert.match(src, /settings\.moxfield/,
    'Moxfield must be a source row in Settings');
  assert.match(src, /sourceOpen === 'moxfield'/,
    'it must expand to its detail, the same pattern as Scryfall');
  assert.match(src, /setSourceOpen\(sourceOpen === 'moxfield' \? null : 'moxfield'\)/,
    'tapping an open Moxfield source must close it -- one source open at a time');

  // WHAT IT SYNCS, per SET-TC5's rule applied to the second source.
  assert.ok('settings.moxSyncs' in en, 'a sync-description string must exist');
  assert.match(en['settings.moxSyncs'], /[Dd]ecks/,
    'the Moxfield source must say it syncs DECKS');
});

test('SET-TC6b: account-level controls live here and only here', () => {
  // Link, check, unlink are CONFIGURATION. If these ever move back out, the
  // integration becomes unreachable from a fresh install -- there is no other
  // place to enter a username.
  for (const key of ['settings.moxLink', 'settings.moxCheckNow', 'settings.moxUnlink']) {
    assert.match(src, new RegExp(key.replace('.', '\\.')),
      `${key} must render on the Settings screen`);
  }
  // A sync must never be offered here. Zach's split is account-level in
  // Settings, deck-level on the deck list; a Sync button here would rebuild the
  // duplicate surface this change removed.
  assert.doesNotMatch(src, /moxfield\/decks\/[^']*\/sync/,
    'Settings must not apply a deck sync -- that action belongs to the deck list');
});
