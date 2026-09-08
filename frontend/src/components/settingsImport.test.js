// SETTINGS > IMPORT CARDS MUST ACTUALLY IMPORT.
//
// Zach: "I noticed the import cards from the settings doesn't work either. It
// pops up the files screen but nothing imports."
//
// He was right, and the failure was silent by construction. Settings rendered a
// hidden <input type="file"> whose onChange called:
//
//     onNavigate('import', file)
//
// Two independent reasons that could never work:
//
//   1. App.jsx passes onNavigate={setActiveTab} to Settings. setActiveTab is a
//      plain useState setter -- it takes ONE argument, so `file` was dropped on
//      the floor with no error.
//   2. There is no 'import' tab. No case, no route. Even the first argument
//      went nowhere.
//
// So the file picker opened -- which is why it LOOKED like something was
// happening -- and then nothing could possibly follow. No exception, no toast,
// no failed request. A dead end that reports success by staying quiet is worse
// than a crash, because the user assumes the import worked.
//
// THE FIX RENDERS THE REAL MODAL, the same one the Collection screen uses,
// rather than repairing the navigation. The import flow already exists, works,
// and has a pre-flight review; a second path into it would be a second thing to
// keep correct.
//
// VERIFIED END TO END on the deployed build, not just structurally: injected a
// real ManaBox-shaped CSV into the modal's input, reached "2 cards ready to add
// / MATCHED CLEANLY", tapped "Add 2 cards", and the collection went 2625 ->
// 2627. Test rows removed afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const settings = readFileSync(join(here, 'SettingsScreen.jsx'), 'utf8');
const app = readFileSync(join(here, '../App.jsx'), 'utf8');
const en = JSON.parse(readFileSync(join(here, '../locales/en.json'), 'utf8'));
const strip = s => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const code = strip(settings);

test('IMP-TC1: Settings does not hand a file to a navigation callback', () => {
  // The exact dead end. onNavigate is setActiveTab -- one argument -- so the
  // file vanished silently.
  assert.doesNotMatch(code, /onNavigate\('import'/,
    'the file must not be passed through navigation');
  assert.doesNotMatch(code, /onNavigate && onNavigate\([^)]*,\s*file/,
    'nothing may pass a File as a second navigation argument');
});

test('IMP-TC2: Settings renders the real ImportModal', () => {
  assert.match(code, /import ImportModal from '\.\/ImportModal'/,
    'Settings must use the shared modal, not its own flow');
  assert.match(code, /\{importOpen && \(/, 'and render it when opened');
  assert.match(code, /<ImportModal/, 'the modal itself must be in the tree');
  assert.match(code, /onClick=\{\(\) => setImportOpen\(true\)\}/,
    'the row must open it');
  // It must be wired to something that can report success. A modal that cannot
  // tell the user what happened repeats the original silent failure.
  assert.match(code, /onImported=\{/, 'the modal must report completion');
  assert.match(code, /showToast=\{showToast\}/, 'and be able to raise errors');
  assert.ok('settings.importDone' in en, 'the completion string must exist');
});

test('IMP-TC3: the import row is reachable, not merely present', () => {
  // This project's recurring UI blind spot: a control that exists in the source
  // and never reaches the screen. The row must be rendered unconditionally --
  // no admin-only gate, no flag -- because every user imports their own cards.
  const row = code.slice(code.indexOf("t('settings.importCards')") - 400,
                         code.indexOf("t('settings.importCards')") + 300);
  assert.doesNotMatch(row, /\{(isAdmin|user\?\.role === 'admin'|false) &&/,
    'the import row must not be gated behind a role or a constant');
  assert.match(code, /label=\{t\('settings\.importCards'\)\}/,
    'the row must be labelled');
});

test('IMP-TC4: App has no phantom import route for anything to aim at', () => {
  // If someone re-adds onNavigate('import'), this documents that the target
  // does not exist -- the assumption that made the original bug invisible.
  assert.doesNotMatch(app, /case 'import':/,
    "there is no 'import' tab; navigation to one is a silent dead end");
  // And Settings is still wired to a single-argument setter, so the shape of
  // the original mistake is still available to make. Kept as a statement of
  // fact rather than a fix: changing it would invite passing data through
  // navigation, which is what broke.
  assert.match(app, /onNavigate=\{setActiveTab\}/,
    'Settings navigation is a plain state setter -- it cannot carry a payload');
});
