// The scanner's card list must follow the catalogue automatically.
//
// Zach, Nov 2026: "why is the scanner not scanning any of my star trek cards?"
// Prod's scan index was built Sep 27 by hand and never again; the catalogue
// kept refreshing, so 456 Star Trek-only names were missing from the list the
// phone matches titles against. See src/scanIndexRefresh.js.
//
// These tests drive the REAL build script against a real SQLite file and read
// the index the phone would download -- not the manifest's say-so.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const sqlite3 = require('sqlite3');

const { isIndexStale, refreshScanIndexIfStale } = require('../src/scanIndexRefresh');
const ROOT = path.join(__dirname, '..', '..');

function makeDb(file, rows) {
  return new Promise((resolve, reject) => {
    const d = new sqlite3.Database(file);
    d.serialize(() => {
      d.run(`CREATE TABLE card_cache (id TEXT, name TEXT, display_name TEXT, flavor_name TEXT,
             oracle_name TEXT, set_id TEXT, number TEXT)`);
      const st = d.prepare(`INSERT INTO card_cache VALUES (?,?,?,?,?,?,?)`);
      for (const r of rows) st.run(r);
      st.finalize();
    });
    d.close(e => (e ? reject(e) : resolve()));
  });
}

// The build refuses < 1000 printings (decoy-DB guard), so pad with filler.
function filler(n) {
  return Array.from({ length: n }, (_, i) => [`f${i}`, `Filler Card ${i}`, null, null, null, 'old', String(i)]);
}

function scannerDir(builtIso) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-scanassets-'));
  fs.writeFileSync(path.join(dir, 'scan-index.deadbeef.json.gz'), zlib.gzipSync('{"names":[]}'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    index: 'scan-index.deadbeef.json.gz', rec: 'rec.x.onnx', dict: 'rec-dict.x.txt',
    corn: 'cornelius.onnx', built: builtIso,
  }));
  return dir;
}

const fakeDb = refreshedAt => ({ get: async () => ({ refreshedAt }) });
const quiet = { log() {}, error() {} };
const servedIndex = dir => {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  return { m, idx: JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, m.index)))) };
};

test('SIR-TC1 staleness rule: older index than catalogue = stale', () => {
  assert.equal(isIndexStale({ index: 'a', built: '2026-09-27T20:38:17Z' }, '2026-11-02 04:09:38'), true);
  assert.equal(isIndexStale({ index: 'a', built: '2026-11-03T00:00:00Z' }, '2026-11-02 04:09:38'), false);
  assert.equal(isIndexStale(null, '2026-11-02 04:09:38'), false, 'no scanner installed');
  assert.equal(isIndexStale({ index: 'a', built: '2026-09-27T00:00:00Z' }, null), false, 'catalogue never ran');
});

test('SIR-TC2 a stale index is rebuilt and a new-set card becomes scannable', async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-sir-')), 'c.db');
  await makeDb(dbFile, [...filler(1000), ['t1', 'Academy Instructor', null, null, null, 'trk', '137']]);
  const dir = scannerDir('2026-09-27T20:38:17.334Z');
  process.env.DB_PATH = dbFile;

  const r = await refreshScanIndexIfStale({ db: fakeDb('2026-11-02 04:09:38'), dir, log: quiet });
  assert.equal(r.rebuilt, true, JSON.stringify(r));

  const { m, idx } = servedIndex(dir);
  assert.notEqual(m.index, 'scan-index.deadbeef.json.gz');
  assert.ok(idx.names.includes('academy instructor'), 'new-set title is in the served index');
  assert.ok(idx.sets.includes('trk'));
  assert.equal(m.rec, 'rec.x.onnx', 'model entries untouched');
  assert.ok(!fs.existsSync(path.join(dir, 'scan-index.deadbeef.json.gz')), 'old index removed');
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith('.')), [], 'no scratch left behind');

  const again = await refreshScanIndexIfStale({ db: fakeDb('2026-11-02 04:09:38'), dir, log: quiet });
  assert.equal(again.rebuilt, false, 'current index is not rebuilt again');
});

test('SIR-TC3 a failed build leaves the working scanner untouched', async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-sir-')), 'c.db');
  await makeDb(dbFile, filler(5)); // below the 1000 guard -> build exits 1
  const dir = scannerDir('2026-09-27T20:38:17.334Z');
  const before = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  process.env.DB_PATH = dbFile;

  const r = await refreshScanIndexIfStale({ db: fakeDb('2026-11-02 04:09:38'), dir, log: quiet });
  assert.equal(r.rebuilt, false);
  assert.equal(r.reason, 'error');
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), before);
  assert.ok(fs.existsSync(path.join(dir, 'scan-index.deadbeef.json.gz')));
});

test('SIR-TC4 the nightly chain AND startup both call the refresh', () => {
  const src = fs.readFileSync(path.join(ROOT, 'backend/src/server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const chainStart = src.indexOf('const runCatalogueRefresh');
  const chainEnd = src.indexOf('const startupCatchUp');
  assert.ok(chainStart > 0 && chainEnd > chainStart);
  assert.match(src.slice(chainStart, chainEnd), /refreshScanIndexIfStale\(\{\s*db\s*\}\)/, 'nightly chain');
  const catchUp = src.slice(chainEnd, src.indexOf('};', chainEnd));
  assert.match(catchUp, /refreshScanIndexIfStale\(\{\s*db\s*\}\)/, 'startup catch-up');
});
