// THE COLLECTION MUST NOT RENDER EVERY CARD IT OWNS.
//
// Zach: "it currently hangs on loading for 3 secs before loading so that makes
// me worried if I get to 10k cards at some point."
//
// MEASURED on the deployed build under phone conditions (390x844, 4x CPU
// throttle), which reproduced his 3 seconds almost exactly:
//
//                          before      after
//   tap -> rows visible    3350ms      ~100ms of render (1s is transfer)
//   DOM nodes              16,032      438
//   <img> elements          1,395      24
//
// The network was never the bottleneck -- it was ~10% of the wait. The rest was
// React building a DOM node for every one of 2,438 cards.
//
// HOW THIS IS DONE, AND WHY IT CHANGED ONCE.
//
// The first attempt virtualised: render a window, reserve the rest with spacer
// divs sized from an ESTIMATED row height. Zach then reported "the scroll seems
// a little jittery after awhile", and the measurement showed why -- the
// estimate was wrong AND variable:
//
//     assumed stride 302px    real strides 315, 315, 331, 315, 330
//     after  50 rows  ~1000px of drift   (1.2 screens)
//     after 200 rows  ~4000px of drift   (4.7 screens)
//
// and the page height itself wobbled (211491 / 211444 / 211382 / 211678) --
// a scrollbar moving under your thumb. The estimate was ALSO measured on a
// 780px desktop and applied to a 390px phone, where the grid is 2 columns and
// tiles are 255px, not 4 columns of 291px.
//
// Zach's design replaced it: "Couldn't you implement infinite scroll but in a
// paged sense. Where maybe you load 20 cards and when you get to the bottom of
// the page you load the next 20." That has NO estimated heights and NO spacers,
// because nothing is ever unmounted -- the whole class of bug is gone rather
// than tuned. Verified on the deployed build: page height only ever grows
// (4198 -> 4198 -> 8009), never wobbles.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const list = readFileSync(join(here, 'CollectionList.jsx'), 'utf8');
const paged = readFileSync(join(here, 'PagedList.jsx'), 'utf8');
const strip = s => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('VG-TC1: neither collection view maps the whole array into the DOM', () => {
  const code = strip(list);
  // `shown.map(...)` renders one element per card: the 16,032-node shape.
  assert.doesNotMatch(code, /\{shown\.map\(/,
    'rendering every card directly is what cost 3.35s on a phone');
  assert.match(code, /<PagedList/, 'both views must render through the pager');
  // BOTH views. Fixing only the gallery leaves the list at 16k nodes.
  assert.equal((code.match(/<PagedList/g) || []).length, 2,
    'gallery AND list must both be paged');
  assert.match(code, /items=\{shown\}/,
    'the pager must be fed the filtered+sorted array, not raw collection');
});

test('VG-TC2: paging does not change what the screen computes', () => {
  // The whole safety argument. PagedList narrows what is PAINTED; every figure
  // and action still reads `shown`, the full filtered array. If any of these
  // started reading the rendered slice, the screen would report a total for 24
  // cards and present it as the collection's value -- a wrong number stated as
  // fact, which is the failure this project keeps guarding against.
  const code = strip(list);
  assert.match(code, /shown\.reduce\(\(sum, c\) => sum \+ \(c\.price_trend \|\| 0\)/,
    'the value total must sum the full filtered array');
  assert.match(code, /setSelectedIds\(new Set\(shown\.flatMap/,
    '"select all shown" must select every filtered row, not the visible page');
  assert.match(code, /t\('bulk\.selectAllShown', \{ count: shown\.length \}\)/,
    'and its count must be the filtered total');
});

test('VG-TC3: no estimated row heights anywhere -- that was the jitter', () => {
  const code = strip(paged);
  // The spacer-based predecessor is GONE, not merely unused. Leaving it in the
  // tree invites someone to reach for it again.
  assert.ok(!existsSync(join(here, 'VirtualGrid.jsx')),
    'the estimated-height virtualiser must be deleted, not kept alongside');
  assert.doesNotMatch(code, /rowHeight/,
    'a hardcoded row height is the drift that made scrolling jittery');
  assert.doesNotMatch(code, /rowStride|spacer/i,
    'no spacer maths: nothing is unmounted, so nothing needs its space reserved');
  assert.doesNotMatch(code, /aria-hidden="true"[\s\S]{0,40}height: rows/,
    'no height-reserving placeholder divs');
  // Columns are CSS auto-fill, not computed. Computing them in JS is what made
  // the old component wrong on a phone after being measured on a desktop.
  assert.match(code, /repeat\(auto-fill, minmax\(\$\{minTileWidth\}px, 1fr\)\)/,
    'the browser must solve the column count, not JS');
});

test('VG-TC4: pages append as the end comes into view', () => {
  const code = strip(paged);
  assert.match(code, /IntersectionObserver/,
    'a scroll handler runs JS on every frame; an observer does not');
  assert.match(code, /setCount\(c => Math\.min\(c \+ pageSize, items\.length\)\)/,
    'reaching the sentinel must append exactly one more page, never overshoot');
  assert.match(code, /rootMargin/,
    'loading must start BEFORE the bottom, or the user sees the list end');
  assert.match(code, /if \(count >= items\.length\) return/,
    'and stop observing once everything is shown');
});

test('VG-TC5: filtering resets the page count', () => {
  // Filtering to 40 cards while 500 are loaded would otherwise show all 40 at
  // once and leave the scroll position deep inside a list that no longer goes
  // that far -- which reads as a blank screen.
  const code = strip(paged);
  assert.match(code, /const signature =/, 'the list identity must be tracked');
  assert.match(code, /items\.length}:\$\{items\[0\]\?\.entry_id/,
    'keyed on length AND first id: a search returning the same count is still '
    + 'a different list');
  assert.match(code, /setCount\(pageSize\)/, 'and the count must reset to one page');
});

test('VG-TC6: a page is a whole number of rows on any screen', () => {
  const code = strip(paged);
  const m = code.match(/const PAGE_SIZE = (\d+)/);
  assert.ok(m, 'the page size must be a named constant');
  const size = Number(m[1]);
  // 2 columns on a phone, 3 or 4 on wider screens. A page that ends mid-row
  // leaves a ragged edge that reads as a rendering bug.
  for (const cols of [2, 3, 4]) {
    assert.equal(size % cols, 0,
      `${size} per page leaves a partial row at ${cols} columns`);
  }
});
