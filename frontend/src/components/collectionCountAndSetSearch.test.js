// TWO SMALL COLLECTION AFFORDANCES, both from Zach using the deployed build:
//
//   "Can we add card count next to dollar amount in the collection and for sets
//    filter can we have a search in that drop down because there is a lot of
//    sets to scroll through"
//
// Measured on his data: 2,625 physical cards across 72 distinct sets. Seventy-
// two rows is a long scroll in a sheet capped at 70vh on a 390px phone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'CollectionList.jsx'), 'utf8');
const en = JSON.parse(readFileSync(join(here, '../locales/en.json'), 'utf8'));
const strip = s => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const code = strip(src);

test('CC-TC1: the count is PHYSICAL CARDS, not tiles', () => {
  // `shown` is grouped for display -- four Forests are ONE tile carrying
  // quantity 4. Counting rows would have reported 1,395 where the dashboard
  // says 2,625, giving two different numbers for the same collection and no
  // way to tell which is true. Verified on the deployed build: the line reads
  // "2,625 cards" and the API's own sum of quantities is 2,625.
  assert.match(code, /const totalCount = useMemo\(/, 'the count must exist');
  assert.match(code, /shown\.reduce\(\(sum, c\) => sum \+ \(c\.quantity \|\| 1\), 0\)/,
    'it must sum QUANTITY per row, not count rows');
  assert.doesNotMatch(code, /const totalCount = useMemo\(\s*\(\) => shown\.length/,
    'shown.length is tiles, not cards');
});

test('CC-TC2: the count and the value describe the SAME cards', () => {
  // Both read `shown`, the filtered+sorted array. If one ever read the whole
  // collection while the other read the filter, the line would pair a count
  // with a price for a different set of cards -- two true numbers making one
  // false statement.
  const countExpr = code.slice(code.indexOf('const totalCount'), code.indexOf('const activeFilters'));
  const valueExpr = code.slice(code.indexOf('const totalValue'), code.indexOf('const totalCount'));
  assert.match(countExpr, /shown\.reduce/, 'the count must read the filtered array');
  assert.match(valueExpr, /shown\.reduce/, 'and so must the value');
  assert.match(countExpr, /\[shown\]\)/, 'the count must recompute when the filter changes');
});

test('CC-TC3: the count renders beside the value', () => {
  // Zach asked for it NEXT TO the dollar amount, not on its own line.
  const line = code.slice(code.indexOf("t('collection.cardCount'"), code.indexOf("t('collection.totalValue'") + 80);
  assert.ok(line.includes('collection.cardCount') && line.includes('collection.totalValue'),
    'count and value must render in the same element');
  assert.ok('collection.cardCount' in en, 'the string must exist');
  assert.match(en['collection.cardCount'], /\{count\}/,
    'and interpolate the number rather than hardcoding a format');
});

test('SS-TC1: the sets sheet has a search, and only the sets sheet', () => {
  // 72 sets is worth searching. Six card types is not -- a search box over six
  // options is clutter pretending to help -- and sort is a fixed short list.
  assert.match(code, /sheet === 'set' && \(/,
    'the search must be conditional on the sets sheet');
  assert.match(code, /placeholder=\{t\('collection\.searchSets'\)\}/,
    'the input must be labelled');
  assert.ok('collection.searchSets' in en, 'the placeholder string must exist');

  // The filter itself must ALSO be scoped to sets, or typing on the types sheet
  // would silently filter types with a box that is not there.
  assert.match(code, /const q = sheet === 'set' \? sheetSearch\.trim\(\)\.toLowerCase\(\) : ''/,
    'the query must be empty on any sheet without a search box');
});

test('SS-TC2: a SELECTED set stays visible even when it does not match', () => {
  // THE TRAP THIS AVOIDS. If searching hid a set that is currently filtering
  // the collection, the user would see a filtered collection with no visible
  // cause and no way to untick it. Verified on the deployed build: with Theros
  // selected, searching "zzzznomatch" still lists Theros alone.
  assert.match(code, /source\.filter\(o => o\.toLowerCase\(\)\.includes\(q\) \|\| sel\.has\(o\)\)/,
    'an active selection must survive a non-matching search');
});

test('SS-TC3: a search that matches nothing says so', () => {
  // An empty sheet reads as "you own no sets", which is a lie about his data.
  assert.match(code, /options\.length === 0/, 'the empty case must be handled');
  assert.match(code, /t\('collection\.noSetsMatch'\)/, 'and must say why it is empty');
  assert.ok('collection.noSetsMatch' in en, 'the string must exist');
});

test('SS-TC4: the search clears when the sheet opens or closes', () => {
  // A search left behind would reopen showing a filtered list that looks like
  // the whole one -- a set he owns appearing to be missing, which reads as data
  // loss rather than a stale text box. Verified deployed: reopening shows an
  // empty box and all 72 rows.
  assert.match(code, /const openSheet = \(which\) => \{ setSheetSearch\(''\); setSheet\(which\); \}/,
    'opening must clear the search');
  assert.match(code, /const closeSheet = \(\) => \{ setSheetSearch\(''\); setSheet\(null\); \}/,
    'and so must closing');
  // Every entry point must go through them, or one path leaks a stale search.
  //
  // Anchored on the COMPONENT'S OWN JSX return, not the first `return (` in the
  // file -- that one belongs to a helper defined near the top, so slicing from
  // it swept in openSheet/closeSheet themselves, which of course call setSheet
  // because they are the things that wrap it. My first version failed on
  // correct code. A guard that fires on its own fix is one you learn to delete.
  const jsxStart = code.indexOf('  return (\n    <div');
  assert.ok(jsxStart > 0, "the component's JSX return must be locatable");
  const rendered = code.slice(jsxStart);
  assert.doesNotMatch(rendered, /setSheet\('(sort|type|set)'\)/,
    'sheets must be opened via openSheet, never setSheet directly');
  assert.doesNotMatch(rendered, /setSheet\(null\)/,
    'sheets must be closed via closeSheet, never setSheet directly');
});
