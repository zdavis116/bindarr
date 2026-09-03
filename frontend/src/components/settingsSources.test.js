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

test('SET-TC6: Moxfield stays hidden until it exists', () => {
  // Zach: "You can hide the moxfield decks for now until implemented."
  // A source that cannot be connected invites "why doesn't this work".
  // Comments may DISCUSS Moxfield -- explaining why it is absent is useful.
  // What must not exist is a rendered row or a locale string for it.
  const code = src
    // JSX {/* ... */} blocks, then // lines. A comment EXPLAINING why Moxfield
    // is absent is exactly what should be allowed; a rendered row is not.
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(code, /[Mm]oxfield/,
    'no Moxfield row in rendered code until the integration is real');
  assert.ok(!Object.keys(en).some(k => /moxfield/i.test(k)),
    'and no Moxfield locale keys, which would imply a shipped feature');
});
