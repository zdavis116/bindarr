// EVERY t('key') MUST EXIST IN THE LOCALE FILE.
//
// Written after the rebuild of Home walked into this twice in a row:
//
//   1. I wrote t('dash.cards', 'Cards') expecting react-i18next's default-value
//      argument. This project's t() is t(key, vars) -- the second argument is an
//      interpolation object. The fallback would have been treated as vars and
//      the key rendered raw.
//
//   2. I then added the keys as NESTED objects ({ dash: { cards: ... } }) when
//      the locale files use FLAT dotted keys ("dash.cards"). The build passed,
//      the tests passed, and three strings would have rendered as
//      "dash.retry" on screen.
//
// Neither is a build error. Vite compiles a missing translation happily, so the
// first sign would have been Zach seeing "dash.decksInProgress" on his phone --
// the same failure shape as the four unreachable controls: renders, looks
// deliberate, is wrong.
//
// This checks the mechanical part: every key a component asks for exists. It
// does not check that the copy is good, or that non-English locales are
// actually translated rather than copied English.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');
const en = JSON.parse(readFileSync(join(src, 'locales', 'en.json'), 'utf8'));

function jsxFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsxFiles(p));
    else if (entry.name.endsWith('.jsx')) out.push(p);
  }
  return out;
}

const files = jsxFiles(join(src, 'components')).concat([join(src, 'App.jsx')]);

test('I18N-TC1: the English locale loaded and is flat', () => {
  // If this file were parsed into the wrong shape, every other case would pass
  // vacuously -- the exact way two earlier tests in this repo were worthless.
  const keys = Object.keys(en);
  assert.ok(keys.length > 100, `expected many keys, found ${keys.length}`);
  assert.ok(keys.some(k => k.includes('.')),
    'keys are flat dotted strings ("dash.retry"), not nested objects');
  assert.ok(!keys.some(k => typeof en[k] === 'object' && en[k] !== null),
    'no nested sections: a nested "dash" object shadows nothing and its keys '
    + 'are unreachable via t("dash.x")');
});

// A key resolves if it is defined outright, OR if it is a plural key -- those
// are stored as "<key>.one" / "<key>.other" and selected at runtime from the
// count. The first version of this test did not know that and reported 20 false
// positives across shipped components, which would have made it useless: a
// check that cries wolf gets deleted or ignored.
function resolves(key) {
  return key in en || `${key}.other` in en || `${key}.one` in en;
}

test('I18N-TC2: every t() key used by a component exists in en.json', () => {
  const missing = [];
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/\bt\('([\w.]+)'/g)) {
      const key = m[1];
      if (!resolves(key)) {
        missing.push(`${file.replace(src, 'src')}: t('${key}')`);
      }
    }
  }
  assert.deepEqual(missing, [],
    'These keys are asked for but not defined, so the raw key string renders on '
    + 'screen:\n  ' + missing.join('\n  '));
});

test('I18N-TC3: t() is never called with a fallback string', () => {
  // t(key, vars) takes an interpolation OBJECT. t('x', 'Fallback') is a
  // react-i18next habit that silently does the wrong thing here.
  const offenders = [];
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/\bt\('[\w.]+',\s*'[^']*'\)/g)) {
      offenders.push(`${file.replace(src, 'src')}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    "t() takes (key, vars). A string second argument is treated as an "
    + 'interpolation object and the default is never shown:\n  '
    + offenders.join('\n  '));
});

// --- I18N-TC4: PLURAL KEYS MUST BE CALLED WITH A COUNT --------------------
//
// This project's t() resolves a plural key ONLY when vars.count is a number
// (translate.js:10). A key stored as `foo.one` / `foo.other` and called
// without a count falls through to the bare `foo`, which does not exist -- so
// the RAW KEY renders on screen.
//
// That has now happened three times on this branch, and each time the build
// and all 343 tests passed: existence checks cannot see it. Zach saw
// "deck.overCommitted" in place of a sentence.
test('I18N-TC4: every plural key is called with a numeric count', () => {
  const en = JSON.parse(readFileSync(join(src, 'locales/en.json'), 'utf8'));

  // Keys that exist ONLY as plural siblings -- there is no bare form to fall
  // back to, so calling them without a count is guaranteed to render the key.
  const pluralOnly = new Set();
  for (const k of Object.keys(en)) {
    const m = k.match(/^(.*)\.(zero|one|two|few|many|other)$/);
    if (m && !(m[1] in en)) pluralOnly.add(m[1]);
  }

  const offenders = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    // t('key', { ...vars })
    const re = /\bt\(\s*'([\w.]+)'\s*,\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const [, key, vars] = m;
      // `count: n` OR the shorthand `{ count }` -- both bind vars.count.
      if (pluralOnly.has(key) && !/\bcount\s*[:,}]/.test(vars.trim() + '}')) {
        offenders.push(`${file.split('/').pop()}: t('${key}') has no count`);
      }
    }
    // t('key') with no vars at all
    const bare = /\bt\(\s*'([\w.]+)'\s*\)/g;
    while ((m = bare.exec(src)) !== null) {
      if (pluralOnly.has(m[1])) {
        offenders.push(`${file.split('/').pop()}: t('${m[1]}') has no vars`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'plural keys called without a count render as the raw key:\n  ' + offenders.join('\n  '));
});
