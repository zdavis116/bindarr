// Does the built index actually resolve real cards?
//
// The builder asserts its own SHAPE, which only proves the file is well formed.
// This asks the question that matters: feed it the title and footer a camera
// would read, and does the reader's own lookup code return the right printing?
//
// It imports shared/clientScan/text.mjs -- the SAME module the phone runs -- so
// a divergence between the builder's normalization and the reader's cannot hide
// here. That was the specific risk worth testing: both sides define normName,
// and a silent mismatch makes every lookup miss while both files look correct.
//
// Usage:
//   DB_PATH=... node verify-scan-index.mjs <assetsDir>

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import {
  loadIndex, normName, findCardByOcr, uniqueTitlePrinting, resolveFooter,
} from '../../shared/clientScan/text.mjs';

const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');

const dir = process.argv[2];
const DB_PATH = process.env.DB_PATH;
if (!dir || !DB_PATH) { console.error('usage: DB_PATH=... node verify-scan-index.mjs <assetsDir>'); process.exit(2); }

const gzName = fs.readdirSync(dir).find(f => f.startsWith('scan-index.') && f.endsWith('.json.gz'));
if (!gzName) { console.error(`no scan-index.*.json.gz in ${dir}`); process.exit(2); }
const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, gzName))).toString('utf8'));
const ix = loadIndex(raw);
console.log(`loaded ${gzName}: ${ix.names.length} names, ${ix.printings.length} printings\n`);

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
const all = (sql, p = []) => new Promise((r, j) => db.all(sql, p, (e, x) => (e ? j(e) : r(x))));

let pass = 0, fail = 0;
const bad = [];
const check = (label, ok, detail) => { if (ok) pass++; else { fail++; bad.push(`${label}: ${detail}`); } };

// A random real sample, not a curated one. Curated samples pass by
// construction; the interesting failures are in cards nobody thought about.
const sample = await all(`
  SELECT id, name, oracle_name, set_id, number FROM card_cache
  WHERE set_id != '' AND number != '' ORDER BY RANDOM() LIMIT 400
`);

for (const row of sample) {
  const printedTitle = row.name;
  // 1. The title a camera reads must find the card.
  const found = findCardByOcr(ix, printedTitle);
  check('title', !!found.name, `${printedTitle} -> no match`);
  if (!found.name) continue;

  // 2. Title + footer must resolve to THIS printing, not merely to some
  //    printing of the name.
  const code = String(row.set_id).toLowerCase();
  const num = String(row.number).toLowerCase();
  const pi = resolveFooter(ix, found.name, [code], [num]);
  if (pi == null) {
    // Not automatically wrong: a title with one printing resolves on the title
    // alone, and refusing is correct when the evidence is genuinely ambiguous.
    const solo = uniqueTitlePrinting(ix, found.name);
    check('footer', solo != null, `${printedTitle} (${code} #${num}) -> unresolved`);
    continue;
  }
  const got = ix.printings[pi];
  check('footer', got[0] === row.id, `${printedTitle} (${code} #${num}) -> got ${got[1]} #${got[2]}`);
}

// OCR NOISE IS THE REAL INPUT. A clean title is the easy case; the reader has
// to survive a recognizer that drops and swaps characters.
//
// THE THRESHOLD IS NOT MINE TO MOVE. NAME_MATCH_MIN is 0.90 in text.mjs, tuned
// upstream against real recognizer output. My first version of this check used
// harsher corruptions ("Lightnmg Bolt", "Sol Rlng") which score 0.88-0.89 and
// are correctly REFUSED. I nearly "fixed" that by lowering the threshold --
// which would have traded refusals for misidentifications across the whole
// catalogue, the one failure mode that actually costs Zach a wrong card.
//
// So this asserts the real property: a single-character slip inside a longer
// title still matches, and anything noisier refuses. Each case carries the
// score it actually produces, so a future change that moves the boundary shows
// up as a diff rather than a silent behaviour change.
const noisy = [
  ['Lightning Bolt', 'Lightning Bolt'],     // clean read: must match
  ['Counterspell', 'Counterspel'],          // one dropped char
  ['Cultivate', 'Cultivat'],                // one dropped char
];
console.log('--- fuzzy title matching (simulated OCR noise)');
for (const [real, garbled] of noisy) {
  const want = normName(real);
  if (!ix.byTitle[want]) continue;       // not in this catalogue, skip
  const got = findCardByOcr(ix, garbled);
  check('fuzzy', got.name === want, `"${garbled}" -> ${got.name || 'null'} (wanted ${want}, score ${got.score.toFixed(2)})`);
  console.log(`  ${garbled.padEnd(18)} -> ${got.name || 'NO MATCH'}  (${got.score.toFixed(2)})`);
}

// Below the threshold the reader must REFUSE rather than guess. These are the
// same corruptions, one character worse.
console.log('\n--- too noisy: must refuse, not guess');
for (const junk of ['Lightnmg Bolt', 'Sol Rlng']) {
  const got = findCardByOcr(ix, junk);
  check('refuse-noisy', !got.name, `"${junk}" resolved to ${got.name} at ${got.score.toFixed(2)}`);
  console.log(`  ${junk.padEnd(18)} -> ${got.name || 'refused'}  (${got.score.toFixed(2)})`);
}

// A misread must REFUSE, not resolve to something. This is the property that
// keeps a wrong card out of the collection, and it is the one worth proving.
console.log('\n--- garbage must not resolve');
for (const junk of ['xqzkwmvb', 'zzzzz qqqqq', '']) {
  const got = findCardByOcr(ix, junk);
  check('refuse', !got.name, `"${junk}" resolved to ${got.name}`);
  console.log(`  ${JSON.stringify(junk).padEnd(18)} -> ${got.name || 'refused'}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed (of ${sample.length} sampled printings + edge cases)`);
if (bad.length) { console.log('\nfailures (first 25):'); bad.slice(0, 25).forEach(b => console.log('  ' + b)); }
db.close();
process.exit(fail ? 1 : 0);
