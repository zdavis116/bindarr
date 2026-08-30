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
