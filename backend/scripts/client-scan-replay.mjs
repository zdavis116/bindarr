// Replay Zach's labelled corpus through the ON-DEVICE reader, under Node.
//
// WHY THIS EXISTS AND WHY IT RUNS FIRST. The reader is a browser module. Before
// any of it is wired into the scanner UI, this proves it identifies real cards
// from real phone frames -- using the SAME shared/clientScan/pipeline.mjs the
// worker will import, with onnxruntime-node standing in for onnxruntime-web.
// The code validated here is byte-for-byte the code that runs on the phone.
//
// THE CORPUS IS THE JUDGE, NOT THE UNIT TESTS. This project has repeatedly
// shipped green suites over broken scanners: a test can assert a label exists
// while the feature is gated off, or match a word in a comment. 271 labelled
// frames of Zach's own cards, under his lighting, on his phone, cannot be
// satisfied by accident.
//
// WHAT COUNTS AS WHAT:
//   correct    resolved to the printing the label names
//   variant    resolved to the same CARD at a different printing -- the label
//              and the read disagree about which copy he was holding. Counted
//              separately because it is a labelling question, not a misread.
//   WRONG      resolved to a DIFFERENT CARD. The only number that must be zero.
//   refused    no answer. Costs a fallback, never a bad row in the collection.
//
// Usage:
//   DB_PATH=... node client-scan-replay.mjs <assetsDir> <framesDir> [--limit N]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { createReader, CORN_SIZE } from '../../shared/clientScan/pipeline.mjs';
import { buildCharset, loadIndex, normName } from '../../shared/clientScan/text.mjs';

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const sqlite3 = require('sqlite3');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [ASSETS, FRAMES] = positional;
const LIMIT = Number(opt('--limit', 0)) || Infinity;
const OUT = opt('--json', '');
if (!ASSETS || !FRAMES) {
  console.error('usage: DB_PATH=... node client-scan-replay.mjs <assets> <frames> [--limit N] [--json out]');
  process.exit(2);
}

// Single-threaded deliberately: the browser wasm EP has no COOP/COEP and runs
// one thread, so a multi-threaded Node run would report a latency this code
// cannot achieve where it actually ships.
const sessOpts = { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1, graphOptimizationLevel: 'all' };

const t0 = Date.now();
const gzName = fs.readdirSync(ASSETS).find(f => f.startsWith('scan-index.') && f.endsWith('.json.gz'));
if (!gzName) { console.error(`no scan-index.*.json.gz in ${ASSETS}`); process.exit(2); }
const index = loadIndex(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ASSETS, gzName))).toString('utf8')));
const chars = buildCharset(fs.readFileSync(path.join(ASSETS, 'rec-dict.txt'), 'utf8'));
const rec = await ort.InferenceSession.create(path.join(ASSETS, 'rec.onnx'), sessOpts);
const cornelius = await ort.InferenceSession.create(path.join(ASSETS, 'cornelius.onnx'), sessOpts);
console.log(`loaded in ${Date.now() - t0} ms: ${index.names.length} names, ${index.printings.length} printings, ${chars.length} classes\n`);

const reader = createReader({ ort, cornelius, rec, chars, index });

// card_cache answers "are these two printings the same CARD?" -- the question
// that separates a labelling disagreement from a real misidentification.
const db = new sqlite3.Database(process.env.DB_PATH, sqlite3.OPEN_READONLY);
const get1 = (sql, p) => new Promise((r, j) => db.get(sql, p, (e, x) => (e ? j(e) : r(x))));
const nameOf = async (set, num) => (await get1(
  'SELECT name FROM card_cache WHERE lower(set_id)=? AND lower(number)=? LIMIT 1',
  [String(set).toLowerCase(), String(num).toLowerCase()],
))?.name || null;

const items = fs.readdirSync(FRAMES).filter(f => f.endsWith('.json')).sort()
  .map((f) => {
    const jpg = path.join(FRAMES, f.replace(/\.json$/, '.jpg'));
    if (!fs.existsSync(jpg)) return null;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(FRAMES, f), 'utf8'));
      if (!d?.truth?.set_id || !d?.truth?.number) return null;
      return { id: f, jpg, truth: d.truth };
    } catch { return null; }
  })
  .filter(Boolean)
  .slice(0, LIMIT);

console.log(`${items.length} labelled frames\n`);

const rows = [];
let correct = 0, variant = 0, wrong = 0, refused = 0;

for (const it of items) {
  const buf = fs.readFileSync(it.jpg);
  const tStart = Date.now();
  const rec_ = { id: it.id, truth: `${it.truth.set_id}#${it.truth.number}`.toLowerCase() };

  try {
    // The same two inputs the worker hands over: the full frame as RGBA, and a
    // 384x384 copy for the corner model. `fit: 'fill'` matches the server's own
    // preprocessing -- squash, do not letterbox -- because the model was
    // trained that way and a letterboxed frame moves every predicted corner.
    const meta = await sharp(buf).metadata();
    const full = await sharp(buf).ensureAlpha().raw().toBuffer();
    const small = await sharp(buf).resize(CORN_SIZE, CORN_SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer();

    // requireStill: false -- a saved still frame has no previous frame to
    // compare against, so the stillness gate would refuse every single one.
    // That gate is a live-camera behaviour and is exercised in the browser.
    const out = await reader.read(
      { data: new Uint8ClampedArray(full), width: meta.width, height: meta.height },
      new Uint8ClampedArray(small), { requireStill: false, smallChannels: 3 },
    );
    rec_.ms = Date.now() - tStart;

    const res = out?.results?.[0];
    if (res?.ok && res.scryfallId) {
      const p = index.printings.find(x => x[0] === res.scryfallId);
      rec_.got = p ? `${p[1]}#${p[2]}` : res.scryfallId;
      rec_.title = res.title || null;
      if (rec_.got === rec_.truth) { correct++; rec_.verdict = 'correct'; }
      else {
        // Same card, different printing, or genuinely a different card?
        const [gs, gn] = String(rec_.got).split('#');
        const [ts, tn] = rec_.truth.split('#');
        const [gotName, truthName] = await Promise.all([nameOf(gs, gn), nameOf(ts, tn)]);
        rec_.gotName = gotName; rec_.truthName = truthName;
        if (gotName && truthName && normName(gotName) === normName(truthName)) {
          variant++; rec_.verdict = 'variant';
        } else { wrong++; rec_.verdict = 'WRONG'; }
      }
    } else {
      refused++; rec_.verdict = 'refused';
      rec_.why = res?.error || out?.candidates?.[0]?.status || 'no result';
      rec_.title = res?.title || null;
    }
  } catch (e) {
    refused++; rec_.verdict = 'refused'; rec_.why = `threw: ${e.message}`;
    rec_.ms = Date.now() - tStart;
  }

  rows.push(rec_);
  if (rows.length % 25 === 0) process.stdout.write(`  ${rows.length}/${items.length}\r`);
}

const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * p)] : 0; };
const times = rows.map(r => r.ms);
const n = rows.length || 1;

console.log(`\n=== ON-DEVICE READER, ${rows.length} frames ===`);
console.log(`  correct (exact printing) : ${correct} (${(100 * correct / n).toFixed(1)}%)`);
console.log(`  variant (same card)      : ${variant} (${(100 * variant / n).toFixed(1)}%)`);
console.log(`  WRONG CARD               : ${wrong}`);
console.log(`  refused (-> server)      : ${refused} (${(100 * refused / n).toFixed(1)}%)`);
console.log(`  identified the card      : ${correct + variant} (${(100 * (correct + variant) / n).toFixed(1)}%)`);
console.log(`  timing  p50 ${q(times, 0.5)} ms   p90 ${q(times, 0.9)} ms   max ${Math.max(...times, 0)} ms`);

if (wrong) {
  console.log(`\n--- THE ${wrong} WRONG (each is a different card, not a printing disagreement)`);
  rows.filter(r => r.verdict === 'WRONG').slice(0, 20)
    .forEach(r => console.log(`  ${r.truth} (${r.truthName}) -> ${r.got} (${r.gotName})`));
}
if (variant) {
  console.log(`\n--- variants (same card, label disagrees about the printing)`);
  rows.filter(r => r.verdict === 'variant').slice(0, 12)
    .forEach(r => console.log(`  ${r.truth} -> ${r.got}  [${r.gotName}]`));
}

if (OUT) { fs.writeFileSync(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); console.log(`\nwrote ${OUT}`); }
db.close();
// A wrong card is the only fatal outcome: refusals fall back to the server.
process.exit(wrong ? 1 : 0);
