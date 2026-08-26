// FLAVOR NAMES: THE NAME ON THE CARD IN YOUR HAND.
//
// Zach scanned a card reading 'SPLINTER, VENGEFUL SENSEI' and Bindarr recorded
// 'Ink-Eyes, Servant of Oni'. Both are right -- one Secret Lair printing with a
// flavor name in large type and the real card name in small type beneath.
//
// 648 cards across Magic have one. For those, `name` is a name the owner cannot
// see while holding the card, so the collection is unrecognisable and, worse,
// unsearchable: "if I want the splinter card I would search that card not
// ink-eyes."
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function pass(id, msg) { console.log(`PASS: ${id} ${msg}`); passed++; }

(async () => {
  const root = path.join(__dirname, '..');

  // 1. The column must exist on BOTH paths: fresh databases and existing ones.
  //
  //    Doing only one of these is a mistake I have already made in this project
  //    -- the dump_file migration shipped without the CREATE TABLE and three
  //    suites failed instantly on a fresh schema.
  const db = fs.readFileSync(path.join(root, 'src', 'db.js'), 'utf8');
  const createBlock = db.slice(db.indexOf('CREATE TABLE IF NOT EXISTS card_cache'),
    db.indexOf('CREATE TABLE IF NOT EXISTS card_cache') + 1200);
  assert.ok(/flavor_name TEXT/.test(createBlock),
    'a fresh card_cache must have flavor_name');
  assert.ok(/'flavor_name'\]/.test(db) || /'flavor_name',/.test(db),
    'existing databases need the flavor_name migration');
  pass('FFLV-TC1', 'both fresh and existing databases get flavor_name');

  // 2. It must be written by the cache, or the column stays permanently NULL
  //    and every other change here is decorative.
  const cache = fs.readFileSync(path.join(root, 'src', 'utils', 'cardCache.js'), 'utf8');
  assert.ok(/'flavor_name'/.test(cache),
    'flavor_name must be in the shared column list used by both insert paths');
  const api = fs.readFileSync(path.join(root, 'src', 'scryfallApi.js'), 'utf8');
  assert.ok(/flavor_name: raw\.flavor_name/.test(api),
    'the normaliser must carry Scryfall\'s flavor_name through');
  pass('FFLV-TC2', 'the flavor name is captured from Scryfall and stored');

  // 3. SEARCH IS THE POINT. Matching only `name` leaves the card reachable
  //    solely by a name printed in small type -- which is the name the owner
  //    did not read and will not think of.
  const nameClauses = api.match(/flavor_name LIKE \?/g) || [];
  assert.strictEqual(nameClauses.length, 2,
    `both the collection and catalogue queries must match flavor_name, found ${nameClauses.length}`);
  assert.ok(/\(cc\.name LIKE \? OR cc\.flavor_name LIKE \?\)/.test(api),
    'collection search must match either name');
  assert.ok(/\(name LIKE \? OR flavor_name LIKE \?\)/.test(api),
    'catalogue search must match either name');
  pass('FFLV-TC3', 'searching either printed name finds the card');

  // 4. ONE display rule, not 113. There are ~113 render sites; if each picks
  //    its own name they drift, and the drift reads as data corruption to
  //    someone reconciling against physical cards.
  const helper = fs.readFileSync(
    path.join(root, '..', 'frontend', 'src', 'utils', 'cardName.js'), 'utf8');
  assert.ok(/export function displayName/.test(helper)
    && /export function secondaryName/.test(helper),
    'a shared naming helper must exist');

  // Behaviour, checked by evaluating the rules directly.
  const displayName = (c) => (c.flavor_name || '').trim() || c.name || '';
  const secondaryName = (c) => {
    const f = (c.flavor_name || '').trim(); const r = (c.name || '').trim();
    return f && f !== r ? r : '';
  };
  const crossover = { name: 'Ink-Eyes, Servant of Oni', flavor_name: 'Splinter, Vengeful Sensei' };
  const ordinary = { name: 'Lightning Bolt', flavor_name: null };

  assert.strictEqual(displayName(crossover), 'Splinter, Vengeful Sensei',
    'the large-type name is what Zach reads off the card');
  assert.strictEqual(secondaryName(crossover), 'Ink-Eyes, Servant of Oni',
    'the real card name is still shown, as it is on the card');
  assert.strictEqual(displayName(ordinary), 'Lightning Bolt');
  assert.strictEqual(secondaryName(ordinary), '',
    'an ordinary card must NOT grow a redundant second line');
  pass('FFLV-TC4', 'crossovers show both names, ordinary cards are unchanged');

  // 5. The catalogue identity must not move. Everything keys on `name`; this
  //    is presentation and search only. If `name` were overwritten with the
  //    flavor name, scan resolution and deck lists would silently break.
  // Anchored so it matches the `name:` key itself, not the tail of
  // `flavor_name: raw.flavor_name` -- my first version flagged its own fix.
  assert.ok(!/[^_]\bname: raw\.flavor_name/.test(api),
    'flavor_name must never overwrite the catalogue name');
  assert.ok(/oracle_name: raw\.name/.test(api),
    'oracle_name must still come from the real card name');
  pass('FFLV-TC5', 'the catalogue identity is unchanged — this is display and search only');

  // 6. THE POSITIONAL VALUE LIST MUST MATCH THE COLUMN LIST.
  //
  //    cacheCards builds its INSERT from COLUMNS but pushes values from a
  //    hand-written list. Adding flavor_name to COLUMNS without adding its
  //    value shifted every field after it -- a price string landed where
  //    `finishes` belonged, and oracle-card-cache failed with
  //    "normal is not valid JSON".
  //
  //    That failure was loud. The dangerous version is silent: two adjacent
  //    TEXT columns swapping contents, discovered months later.
  const { CARD_CACHE_COLUMNS } = require('../src/utils/cardCache');
  const catalogue = fs.readFileSync(path.join(root, 'src', 'cardCatalogue.js'), 'utf8');
  const lists = [
    ['cardCache.js', cache.slice(cache.indexOf('params.push('), cache.indexOf('await db.run('))],
    ['cardCatalogue.js', catalogue.slice(catalogue.indexOf('function stagingParams'),
                                        catalogue.indexOf('async function insertStagedChunk'))],
  ];
  for (const [file, block] of lists) {
  const pushed = block
    .split('\n')
    .filter(l => !/^\s*\/\//.test(l))
    .join('\n');
  // Count top-level comma-separated values in the push, ignoring commas inside
  // parentheses (JSON.stringify(...), num(...)).
  // cardCache.js wraps its values in params.push( ... ); cardCatalogue.js
  // returns them as [ ... ]. Slice on whichever bracket this list uses.
  const open = pushed.includes('params.push(') ? '(' : '[';
  const close = open === '(' ? ')' : ']';
  const inner = pushed.slice(pushed.indexOf(open) + 1, pushed.lastIndexOf(close));
  let depth = 0;
  const parts = [''];
  for (const ch of inner) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) parts.push('');
    else parts[parts.length - 1] += ch;
  }
  // The list ends with a trailing comma, which yields one empty final part.
  const values = parts.filter(x => x.trim() !== '').length;
  assert.strictEqual(values, CARD_CACHE_COLUMNS.length,
    `${file}: the positional value list (${values}) must have exactly one entry `
    + `per column (${CARD_CACHE_COLUMNS.length}) — a mismatch writes every `
    + 'later value into the wrong column');
  }
  pass('FFLV-TC6', 'BOTH positional value lists stay in lock-step with the columns');

  console.log(`\nflavor-name.test.js: ${passed} cases passed`);
})().catch((e) => { console.error('FAIL: FFLV', e.message); process.exit(1); });
