// Filtering the collection by rarity, and the counts on each filter option.
//
// Zach: "being able to filter my collection by rarity" + "can you add counts
// for rarity set and type?"
//
// VERIFIED AGAINST HIS REAL COLLECTION before any of this was written:
//   4,968 rows, 0 with a missing rarity
//   Common 2681, Uncommon 1332, Rare 816, Mythic 139
//   stored Capitalised, not Scryfall's lowercase
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'CollectionList.jsx'), 'utf8');
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*\/\//.test(l) && !/^\s*\{\/\*/.test(l)).join('\n');

let passed = 0;
const start = (id) => console.log(`RUN: ${id}`);
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

// RARITY-TC1: rarity is OR, where colour and type are AND.
//
// THE TRAP. Colours and types use `every` -- selecting more NARROWS, which is
// what a row of chips implies. A card has exactly ONE rarity, so `every`
// makes "Rare + Mythic" match nothing at all: two ticks, empty screen, no
// error. Copying the neighbouring line is the obvious mistake here.
{
  start('RARITY-TC1');
  assert.match(code, /rarityFilters\.size === 0 \|\| rarityFilters\.has\(item\.rarity\)/,
    'rarity must match ANY selected value. Using `every` like the colour and '
    + 'type filters would make two selections return nothing, because a card '
    + 'has one rarity');
  assert.ok(!/\[\.\.\.rarityFilters\]\.every/.test(code),
    'rarity must not use `every` -- that is the empty-screen bug');
  pass('RARITY-TC1', 'rarity widens with each selection, unlike colour and type');
}

// RARITY-TC2: the filter actually reaches the list.
//
// A filter whose state is not in the memo's dependencies updates nothing. It
// renders, it ticks, and the list ignores it.
{
  start('RARITY-TC2');
  // ANCHORED TO THE LIST MEMO, NOT TO A DEPENDENCY SHAPE.
  //
  // This originally matched any `}, [collection, searchFilter, ...]);` line.
  // optionCounts now ends with the SAME dependency list, so the regex found
  // that one instead and the guard went vacuous -- deleting rarityFilters
  // from the list memo left it green. Match the memo that actually produces
  // the filtered rows.
  const listMemo = /const shown = useMemo\(\(\) => \{[\s\S]*?\}, \[([^\]]+)\]\);/.exec(code);
  assert.ok(listMemo, 'the filtered-list memo could not be found');
  assert.match(listMemo[1], /rarityFilters/,
    'rarityFilters must be a dependency of the filtered list, or ticking a '
    + 'rarity changes nothing on screen');
  assert.match(code, /matchesSearch && matchesColor && matchesType && matchesSet && matchesRarity/,
    'the rarity predicate must be part of the returned condition');
  pass('RARITY-TC2', 'the rarity filter is wired into the list');
}

// RARITY-TC3: printed order, and only rarities that exist.
{
  start('RARITY-TC3');
  const order = /const RARITY_ORDER = \[([^\]]+)\]/.exec(code);
  assert.ok(order, 'RARITY_ORDER could not be found');
  const vals = order[1].split(',').map(v => v.trim().replace(/'/g, ''));
  assert.deepStrictEqual(vals, ['Common', 'Uncommon', 'Rare', 'Mythic'],
    'rarities must be listed commonest-first. Alphabetical reads Common, '
    + 'Mythic, Rare, Uncommon, which puts the rarest in the middle');
  // Capitalisation is not cosmetic: card_cache stores 'Common', Scryfall's API
  // returns 'common', and a case mismatch silently matches zero rows.
  for (const v of vals) {
    assert.strictEqual(v[0], v[0].toUpperCase(),
      `${v} must be Capitalised to match card_cache; Scryfall's lowercase `
      + 'values would match nothing');
  }
  assert.match(code, /RARITY_ORDER\.filter\(r => found\.has\(r\)\)/,
    'only rarities present in the collection may be offered -- an option that '
    + 'can only ever return nothing is worse than no option');
  pass('RARITY-TC3', 'printed order, correct case, no dead options');
}

// RARITY-TC4: counts respond to the OTHER filters, but not to their own.
//
// Zach: "the numbers don't update the more I filter like they should. If I
// filter a set the mythics shouldn't say 139 still."
//
// The first version of this test asserted the OPPOSITE -- that counts depend
// on `collection` alone -- because that is what I built. He was right and the
// reasoning was wrong: a count answers "what do I get if I tick this", and
// once a set is chosen, 139 is not the answer. A number that cannot come true
// is worse than one that moves.
//
// EXCLUDE-SELF is the other half, and it is not cosmetic. If a facet were
// counted against its own selection, ticking Mythic would make every other
// rarity read 0 -- no card is both -- so an OR filter could never be widened.
// Verified on his real data: with a set chosen, Mythic 139 -> 13, and Rare
// still reads 102 rather than 0 when Mythic is also ticked.
{
  start('RARITY-TC4');
  const memo = /const optionCounts = useMemo\(\(\) => \{([\s\S]*?)\}, \[([^\]]+)\]\);/.exec(code);
  assert.ok(memo, 'optionCounts could not be found');
  const deps = memo[2].split(',').map(d => d.trim());
  for (const d of ['collection', 'searchFilter', 'colorFilters', 'typeFilters', 'setFilters', 'rarityFilters']) {
    assert.ok(deps.includes(d),
      `optionCounts must depend on ${d}; without it the counts freeze and `
      + 'keep promising cards the filters will not return');
  }
  // Exclude-self: each facet is bumped under the OTHER facets' tests only.
  assert.match(memo[1], /if \(okSet\(c\) && okType\(c\)\) bump\(rarity,/,
    'the rarity count must respect set and type but NOT rarity itself');
  assert.match(memo[1], /if \(okRarity\(c\) && okType\(c\)\) bump\(set,/,
    'the set count must respect rarity and type but NOT set itself');
  assert.match(memo[1], /if \(okRarity\(c\) && okSet\(c\)\)/,
    'the type count must respect rarity and set but NOT type itself');
  assert.ok(!/if \(okRarity\(c\) && okSet\(c\) && okType\(c\)\)/.test(memo[1]),
    'no facet may be counted against its own selection -- every unticked '
    + 'option would read 0 and the filter could never be widened');
  assert.match(memo[1], /c\.quantity \|\| 1/,
    'count COPIES, not rows -- four Lightning Bolts is four cards, which is '
    + 'the number shown everywhere else in this app');
  for (const k of ['rarity', 'set', 'type']) {
    assert.ok(new RegExp(`bump\\(${k},`).test(memo[1]),
      `${k} has no counts; Zach asked for all three`);
  }
  pass('RARITY-TC4', 'counts narrow with other filters, never with their own');
}

// RARITY-TC6: an option that reaches 0 stays visible and tappable.
//
// With counts now responsive, options legitimately empty out -- 78 of his 105
// sets have no mythic. Hiding them would reshuffle the list under a finger
// mid-tap, and could hide a TICKED option, leaving a filter active with no
// visible way to remove it. That is the reachability failure this project
// keeps hitting.
{
  start('RARITY-TC6');
  assert.match(code, /const empty = n === 0 && !on;/,
    'a zero option must be identifiable so it can be dimmed');
  assert.ok(!/options\.filter\(o => counts\.get\(o\)/.test(code),
    'zero options must not be filtered out of the sheet');
  assert.match(code, /opacity: empty \? 0\.55 : 1/,
    'zero options should be dimmed rather than removed');
  // A ticked option is never dimmed, whatever its count: it is the thing the
  // user has to be able to find in order to untick it.
  assert.match(code, /n === 0 && !on/,
    'a TICKED option must never be dimmed, or the user cannot find the filter '
    + 'that is hiding their cards');
  pass('RARITY-TC6', 'empty options dim rather than disappear');
}

// RARITY-TC5: the filter can be seen and cleared.
//
// A filter the user cannot reach or remove is the reachability failure this
// project keeps hitting: the badge says one is active, and nothing visible
// turns it off.
{
  start('RARITY-TC5');
  assert.match(code, /activeFilters = colorFilters\.size \+ typeFilters\.size \+ setFilters\.size \+ rarityFilters\.size/,
    'the active-filter badge must include rarity, or it under-reports');
  assert.match(code, /setRarityFilters\(new Set\(\)\)/,
    'Clear-all must clear rarity too, or a filter survives that the user has '
    + 'no way to see or remove');
  assert.match(code, /sheet === 'rarity' \? t\('collection\.rarities'\)/,
    'the rarity sheet needs its own title, not the fallback');
  const en = JSON.parse(readFileSync(join(HERE, '..', 'locales', 'en.json'), 'utf8'));
  assert.ok(en['collection.rarities'],
    'collection.rarities has no string; this app renders the KEY when one is '
    + 'missing, so the button would read "collection.rarities"');
  pass('RARITY-TC5', 'the filter is visible, titled and clearable');
}

console.log(`\nrarityFilter.test.js: ${passed} cases passed`);
