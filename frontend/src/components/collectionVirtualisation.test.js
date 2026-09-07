// THE COLLECTION MUST NOT RENDER EVERY CARD IT OWNS.
//
// Zach, after the perf branch shipped: "speed does seem good besides
// collections...it currently hangs on loading for 3 secs before loading so that
// makes me worried if I get to 10k cards at some point."
//
// MEASURED on the deployed build under phone-like conditions (4x CPU throttle,
// ~1.6Mbps), which reproduced his 3 seconds almost exactly:
//
//                          before      after
//   tap -> rows visible    3350ms      970ms
//   DOM nodes              16,032      1,014
//   <img> elements          1,395         72     (4 of them in the viewport)
//   fetch + parse           329ms      322ms     <- never the bottleneck
//
// The network was only 10% of the wait. The rest was React building a DOM node
// for every one of 2,438 cards. That cost scales with the collection, which is
// exactly the 10k worry -- the same shape extrapolates to ~12s at 10,000 cards,
// and it is client-side work no index can fix.
//
// These tests pin the SHAPE, not the timing: a wall-clock assertion would be
// flaky on a shared box and would fail for reasons unrelated to this code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const list = readFileSync(join(here, 'CollectionList.jsx'), 'utf8');
const grid = readFileSync(join(here, 'VirtualGrid.jsx'), 'utf8');
const strip = s => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('VG-TC1: neither collection view maps the whole array into the DOM', () => {
  const code = strip(list);
  // `shown.map(...)` renders one element per card. That is the 16,032-node
  // shape, and it is what must not come back.
  assert.doesNotMatch(code, /\{shown\.map\(/,
    'rendering every card directly is what cost 3.35s on a phone');
  assert.match(code, /<VirtualGrid/,
    'both views must render through the windowing component');
  // BOTH views: gallery and list. Fixing only one leaves the other at 16k nodes.
  const uses = code.match(/<VirtualGrid/g) || [];
  assert.equal(uses.length, 2, 'gallery AND list must both be windowed');
  assert.match(code, /items=\{shown\}/,
    'the window must be fed the filtered+sorted array, not raw collection');
});

test('VG-TC2: windowing does not change what the screen computes', () => {
  // The whole safety argument. VirtualGrid narrows what is PAINTED; every
  // figure and action still reads `shown`, the full filtered array. If any of
  // these started reading the rendered slice instead, the screen would report
  // a total for 72 cards and call it the collection's value -- a wrong number
  // presented as a fact, which is the failure this project keeps guarding.
  const code = strip(list);
  assert.match(code, /shown\.reduce\(\(sum, c\) => sum \+ \(c\.price_trend \|\| 0\)/,
    'the value total must sum the full filtered array');
  assert.match(code, /setSelectedIds\(new Set\(shown\.flatMap/,
    '"select all shown" must select every filtered row, not the visible window');
  assert.match(code, /t\('bulk\.selectAllShown', \{ count: shown\.length \}\)/,
    'and its count must be the filtered total');
});

test('VG-TC3: the window is derived from the MEASURED column count', () => {
  const code = strip(grid);
  // The bug this caught in review: `safe` clamped with the `columns` PROP,
  // which is undefined for the list view and for the responsive gallery. That
  // made `end` NaN, slice(0, NaN) returned nothing, and the screen rendered its
  // header and total with an EMPTY list behind it -- throwing no error. Found
  // by measuring the deployed build (150 DOM nodes, 0 images), not by reading.
  assert.match(code, /const \[cols, setCols\] = useState/,
    'the column count must be state, because it is measured');
  assert.match(code, /Math\.floor\(\(width \+ gap\) \/ \(minTileWidth \+ gap\)\)/,
    'a responsive grid must derive its columns from the container width');
  const safeBlock = code.slice(code.indexOf('const safe = useMemo'),
                               code.indexOf('const slice ='));
  assert.match(safeBlock, /start \+ cols/,
    'the clamp must use the measured count -- the prop is undefined and yields NaN');
  assert.doesNotMatch(safeBlock, /start \+ columns/,
    'clamping on the raw prop renders an empty list with no error');
});

test('VG-TC4: unrendered rows still occupy their space', () => {
  const code = strip(grid);
  // Without spacers the page height collapses to the rendered window: the
  // scrollbar lies, and scrolling fights the user as content is swapped in.
  assert.match(code, /rowsAbove \* rowStride/, 'space above the window must be reserved');
  assert.match(code, /rowsBelow \* rowStride/, 'and below it');
  assert.match(code, /aria-hidden="true"/,
    'spacers are layout, not content -- they must not be announced');
  // Verified on the deployed build: body scrollHeight 105,857px for 2,438
  // cards, and scrolling to the bottom rendered the final rows rather than
  // blank space.
});

test('VG-TC5: a fast flick must not show blank space', () => {
  const code = strip(grid);
  assert.match(code, /OVERSCAN_ROWS/,
    'rows beyond the viewport must be rendered as a buffer');
  assert.match(code, /\{ passive: true \}/,
    'the scroll listener must be passive so it cannot make scrolling janky');
});

test('VG-TC6: small lists are not windowed', () => {
  const code = strip(grid);
  // Windowing a dozen rows costs more than it saves, and it would make the
  // spacer maths run for lists that never needed it.
  assert.match(code, /threshold = 60/, 'there must be a floor');
  assert.match(code, /items\.length > threshold/, 'below it, render everything');
  assert.match(code, /virtualise \? items\.slice\(safe\.start, safe\.end\) : items/,
    'and the un-windowed path must return the whole array untouched');
});
