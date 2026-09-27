// Assemble the /scan-assets/ directory the on-device scanner downloads.
//
// Three build steps produce four files; this is the one that makes them
// addressable. The worker fetches manifest.json first and every other name
// comes out of it, so a rebuilt index changes one small file rather than
// invalidating 25 MB of models on every phone.
//
// CONTENT HASHING IS WHY THE CACHING IS SAFE. Hashed filenames are served
// `immutable` for a year: a changed file is a changed URL, so a stale cache is
// impossible rather than merely unlikely. manifest.json is the single
// `no-cache` file -- the one revalidation a returning phone pays for.
//
// Usage:
//   DB_PATH=... node build-scan-assets.mjs <outDir>
//
// Idempotent: re-running with an unchanged card_cache produces the same hashes
// and rewrites nothing meaningful.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const OUT = process.argv[2];
if (!OUT) { console.error('usage: DB_PATH=... node build-scan-assets.mjs <outDir>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const here = import.meta.dirname;
const node = process.execPath;
const run = (script, args) => execFileSync(node, [path.join(here, script), ...args], { stdio: 'inherit', env: process.env });

console.log('--- models');
run('fetch-scan-models.mjs', [OUT]);

console.log('\n--- index');
// Remove a previous index first: it is content-hashed, so a rebuild writes a
// NEW filename and the old one would linger, get picked up by the glob below,
// and possibly win. Stale-index-served-as-current is a silent failure -- the
// scanner works, it just cannot see recently added sets.
for (const f of fs.readdirSync(OUT)) {
  if (f.startsWith('scan-index.') && f.endsWith('.json.gz')) fs.unlinkSync(path.join(OUT, f));
}
run('build-scan-index.mjs', [OUT]);

// --- hash the two static assets ----------------------------------------------
// The models never change between builds, but they are hashed anyway so they
// can share the `immutable` cache policy with the index. Without a hash they
// would need revalidation on every load, which on a phone is the difference
// between an instant camera and a visible wait.
function hashed(src) {
  const bytes = fs.readFileSync(path.join(OUT, src));
  const h = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const ext = src.endsWith('.onnx') ? '.onnx' : path.extname(src);
  const stem = src.slice(0, src.length - ext.length);
  const name = `${stem}.${h}${ext}`;
  if (!fs.existsSync(path.join(OUT, name))) fs.writeFileSync(path.join(OUT, name), bytes);
  return name;
}

const recName = hashed('rec.onnx');
const dictName = hashed('rec-dict.txt');
const indexName = fs.readdirSync(OUT).find(f => f.startsWith('scan-index.') && f.endsWith('.json.gz'));
if (!indexName) { console.error('index build produced no scan-index.*.json.gz'); process.exit(1); }

// cornelius keeps its plain name: the worker requests it unhashed, and it is
// the same 3.2 MB file for every install.
const manifest = {
  index: indexName,
  rec: recName,
  dict: dictName,
  corn: 'cornelius.onnx',
  built: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Drop superseded hashed copies so the directory does not grow by 21 MB every
// time the recognizer is re-fetched.
const keep = new Set([indexName, recName, dictName, 'cornelius.onnx', 'rec.onnx', 'rec-dict.txt', 'manifest.json']);
for (const f of fs.readdirSync(OUT)) {
  if (!keep.has(f)) { fs.unlinkSync(path.join(OUT, f)); console.log(`  removed stale ${f}`); }
}

console.log('\n--- manifest');
console.log(JSON.stringify(manifest, null, 2));
let total = 0;
for (const f of fs.readdirSync(OUT)) total += fs.statSync(path.join(OUT, f)).size;
console.log(`\n${OUT}: ${(total / 1e6).toFixed(1)} MB total`);
// What a phone actually downloads once, which is the number that matters for
// the first camera open on a slow connection.
const wire = [indexName, recName, dictName, 'cornelius.onnx']
  .reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`first-run download: ${(wire / 1e6).toFixed(1)} MB`);
