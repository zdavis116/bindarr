// Build the on-device scan index from card_cache.
//
// The in-browser reader (shared/clientScan/*) identifies a card by READING IT:
// the title strip is OCR'd and matched against a name list, then the footer is
// read to pick the exact printing. This script produces the lookup tables that
// make that possible, so the phone needs no network round trip to know what it
// is looking at.
//
// WHY WE BUILD IT OURSELVES RATHER THAN SHIPPING A PUBLISHED ONE. The upstream
// project generates this from a private sidecar repo, keyed to that project's
// own card pool. card_cache IS this install's card pool -- ~105k printings over
// ~34.7k oracle ids, refreshed with every Scryfall catalogue run. Building from
// it means a set released tomorrow is one refresh away from being scannable,
// and every hit resolves to a row this install already knows.
//
// THE SHAPE IS NOT NEGOTIABLE. shared/clientScan/text.mjs loadIndex() consumes
// these exact fields; they are its API. See the assertions in the verify step.
//
//   names       [normalized title]            the OCR fuzzy-match haystack
//   canon       {i: canonical normalized}     display/lookup name for names[i]
//   printings   [[id, setCode, number]]       one row per physical printing
//   byTitle     {normTitle: [printingIdx]}    title -> its printings
//   uniqueAlias {normTitle: [[alias, pIdx]]}  printed names that pin ONE printing
//   excluded    [normTitle]                   titles too ambiguous to trust
//   sets        [setCode]                     longest-first matching in footers
//
// Usage:
//   DB_PATH=/var/lib/bindarr-dev/bindarr.db node build-scan-index.mjs <outDir>

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');

const OUT_DIR = process.argv[2];
if (!OUT_DIR) {
  console.error('usage: DB_PATH=... node build-scan-index.mjs <outDir>');
  process.exit(2);
}
// The decoy trap: backend/database/ is empty, and a script that defaults there
// reports a cheerful zero instead of failing.
const DB_PATH = process.env.DB_PATH;
if (!DB_PATH || !fs.existsSync(DB_PATH)) {
  console.error(`DB_PATH must point at a real database (got: ${DB_PATH || 'unset'})`);
  process.exit(2);
}

// MUST match shared/clientScan/text.mjs normName EXACTLY. The phone normalizes
// its OCR read with that function and looks the result up in the table this
// script writes; any divergence and every lookup silently misses.
function normName(s) {
  return String(s ?? '').toLowerCase().replace(/\u2019/g, "'")
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// A card's TITLE as printed on the physical card, which is what the OCR sees.
// Three columns can differ and the difference matters:
//   name         the English oracle name                ("Lightning Bolt")
//   printed/display_name  the localized or styled name printed on the card
//   flavor_name  Godzilla-series and similar alternates ("Zilortha, Strength Incarnate")
// The printed title is the identity the camera reads; the oracle name is the
// identity the rest of the app uses. Both go in, mapped back to the oracle name.
function titlesFor(row) {
  const out = new Set();
  for (const v of [row.name, row.display_name, row.flavor_name]) {
    const n = normName(v);
    if (n) out.add(n);
  }
  return [...out];
}

// A DOUBLE-FACED CARD PRINTS ONLY ITS FRONT FACE TITLE.
// card_cache stores "Front // Back" in name for split/MDFC layouts. The camera
// sees "Front" alone, so an index holding only the combined string can never
// match. Both forms are registered; the combined one stays canonical because
// that is what the rest of the app calls the card.
function faceTitles(row) {
  const out = new Set(titlesFor(row));
  if (typeof row.name === 'string' && row.name.includes('//')) {
    for (const part of row.name.split('//')) {
      const n = normName(part);
      if (n) out.add(n);
    }
  }
  return [...out];
}

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
const all = (sql, params = []) => new Promise((res, rej) =>
  db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));

const t0 = Date.now();

// Every printing with a set and a number -- the two things a footer prints.
// A row missing either cannot be resolved from a footer read, so it would only
// ever add noise to the name haystack.
const rows = await all(`
  SELECT id, name, display_name, flavor_name, oracle_name, set_id, number
  FROM card_cache
  WHERE set_id IS NOT NULL AND set_id != ''
    AND number IS NOT NULL AND number != ''
`);
console.log(`read ${rows.length} printings in ${Date.now() - t0} ms`);
if (rows.length < 1000) {
  // Almost certainly the empty decoy database rather than a real catastrophe.
  console.error(`REFUSING: only ${rows.length} printings. Is DB_PATH the decoy?`);
  process.exit(1);
}

const names = [];
const nameIx = new Map();          // normalized title -> index into names
const canon = {};                  // index -> canonical normalized title
const printings = [];              // [id, setCode, number]
const byTitle = new Map();         // normalized title -> Set(printing index)
const setCodes = new Set();

// alias -> the printings it appears on, per canonical title. An alias that
// lands on exactly ONE printing is proof of that printing all by itself
// (uniqueOcrPrinting); one that appears on several proves nothing.
const aliasHits = new Map();       // canonTitle -> Map(alias -> Set(pIdx))

function internName(norm) {
  let i = nameIx.get(norm);
  if (i === undefined) { i = names.length; names.push(norm); nameIx.set(norm, i); }
  return i;
}

for (const row of rows) {
  const setCode = String(row.set_id).toLowerCase();
  const number = String(row.number).toLowerCase();
  const pIdx = printings.length;
  printings.push([row.id, setCode, number]);
  setCodes.add(setCode);

  // The canonical identity: what the app calls this card regardless of how any
  // one printing styles it.
  const canonNorm = normName(row.oracle_name || row.name);
  if (!canonNorm) continue;

  for (const title of faceTitles(row)) {
    const i = internName(title);
    canon[i] = canonNorm;
    if (!byTitle.has(title)) byTitle.set(title, new Set());
    byTitle.get(title).add(pIdx);
  }

  // Printed-name aliases: a title that is NOT the oracle name is evidence
  // pointing at the specific printing that prints it.
  for (const v of [row.display_name, row.flavor_name]) {
    const alias = normName(v);
    if (!alias || alias === canonNorm) continue;
    if (!aliasHits.has(canonNorm)) aliasHits.set(canonNorm, new Map());
    const m = aliasHits.get(canonNorm);
    if (!m.has(alias)) m.set(alias, new Set());
    m.get(alias).add(pIdx);
  }
}

// EXCLUSIONS: titles the reader must never even TRY to match.
//
// EMPTY, DELIBERATELY, AND THIS WAS MEASURED.
//
// The first version of this file excluded the basic lands, reasoning that
// "Forest" is a common word a garbled read might fuzzy-match. Verification
// against 400 random printings failed 22 of them -- every basic land in the
// sample -- because `excluded` is checked at the TOP of findCardByOcr and
// returns null immediately. It does not weaken a match; it deletes the card
// from the scanner's vocabulary entirely, footer and all. Zach's own corpus is
// 147 `msh` frames including basics, so this would have made a whole class of
// his cards unscannable while every shape assertion still passed.
//
// The protection I was reaching for already exists and is better: a title read
// resolves on its own ONLY when it maps to exactly one printing
// (uniqueTitlePrinting). "Forest" maps to 774, so it can never shortcut -- it
// must be proven by its footer, which is exactly the desired behaviour.
// Ambiguity is handled by the resolver, not by blinding it.
//
// Keep this empty unless a title is proven to cause a MISIDENTIFICATION on
// real frames. It is not a tidiness list.
const excluded = [];

const uniqueAlias = {};
for (const [canonNorm, m] of aliasHits) {
  const list = [];
  for (const [alias, set] of m) if (set.size === 1) list.push([alias, [...set][0]]);
  if (list.length) uniqueAlias[canonNorm] = list;
}

const byTitleObj = {};
for (const [title, set] of byTitle) byTitleObj[title] = [...set];

// Longest set code first: footer matching scans for the longest code that fits,
// so "pmei" must be tried before "mei" would falsely match inside it.
const sets = [...setCodes].sort((a, b) => b.length - a.length || a.localeCompare(b));

const index = { names, canon, printings, byTitle: byTitleObj, uniqueAlias, excluded, sets };

// --- verification ------------------------------------------------------------
// Assert the CONTRACT, not the counts. A shape error here surfaces on the phone
// as "the scanner reads nothing", with no clue why.
const problems = [];
if (!Array.isArray(index.names) || !index.names.length) problems.push('names empty');
if (!Array.isArray(index.printings) || !index.printings.length) problems.push('printings empty');
if (index.printings.some(p => p.length !== 3)) problems.push('a printing is not [id,set,num]');
if (!Object.keys(index.byTitle).length) problems.push('byTitle empty');
if (!index.sets.length) problems.push('sets empty');
// Every printing index referenced by byTitle must exist.
for (const [t, list] of Object.entries(index.byTitle)) {
  if (list.some(i => !index.printings[i])) { problems.push(`byTitle[${t}] points past printings`); break; }
}
// Every name must carry a canonical form, or canonOf falls back silently.
if (index.names.some((_, i) => !index.canon[i])) problems.push('a name has no canonical form');
if (problems.length) { console.error('INDEX INVALID:\n  ' + problems.join('\n  ')); process.exit(1); }

fs.mkdirSync(OUT_DIR, { recursive: true });
const json = JSON.stringify(index);
const gz = zlib.gzipSync(json, { level: 9 });
const hash = crypto.createHash('sha256').update(gz).digest('hex').slice(0, 8);
const indexName = `scan-index.${hash}.json.gz`;
fs.writeFileSync(path.join(OUT_DIR, indexName), gz);

console.log(`\nnames      ${index.names.length}`);
console.log(`printings  ${index.printings.length}`);
console.log(`byTitle    ${Object.keys(index.byTitle).length}`);
console.log(`aliases    ${Object.keys(index.uniqueAlias).length} titles`);
console.log(`sets       ${index.sets.length}`);
console.log(`excluded   ${index.excluded.length}`);
console.log(`\nwrote ${indexName}  (${(gz.length / 1e6).toFixed(1)} MB gz, ${(json.length / 1e6).toFixed(1)} MB raw)`);
console.log(`total ${Date.now() - t0} ms`);

db.close();
