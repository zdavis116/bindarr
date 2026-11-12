// KEEP THE ON-DEVICE SCANNER'S CARD LIST IN STEP WITH THE CATALOGUE.
//
// The phone scanner identifies a card by reading its title and looking it up
// in scan-index.<hash>.json.gz. That file is built from card_cache by
// scripts/build-scan-index.mjs -- and until Nov 2026 it was only ever built BY
// HAND. The catalogue refreshed itself nightly; the scanner's list did not.
//
// Zach: "why is the scanner not scanning any of my star trek cards? it does
// scan one temple garden but thats it." Prod's index was built Sep 27. The
// catalogue had 1,145 Star Trek printings; the index had 176 and no Star Trek
// Commander at all, so 456 card names that exist only in those sets were
// simply not in the scanner's vocabulary. Temple Garden worked because its
// name was already known from older sets. Every future set would repeat this.
//
// So: after the catalogue changes, rebuild the index. The rule is STALENESS,
// not "the refresh ran": rebuild whenever the index is older than the last
// successful catalogue import. That one rule covers the nightly run, a manual
// refresh, AND the first boot after this ships (prod is stale right now).
//
// WHY A CHILD PROCESS. The build holds ~105k printings plus a gzip of a
// multi-MB JSON in memory. Running it in the server would spike the heap of
// the process serving requests; a child pays that once and exits. It opens the
// database READ-ONLY, so it cannot contend for writes with the live server.
//
// WHY ONLY THE INDEX. build-scan-assets.mjs also re-downloads the OCR models.
// Those never change between catalogue builds, and a nightly network fetch of
// 25 MB is a new way to fail for no benefit. We reuse the manifest's existing
// model entries and swap only the index.
//
// FAILURE IS SAFE. Every step writes a NEW file before touching the old one,
// and manifest.json -- the one file the phone reads first -- is replaced by an
// atomic rename. A failed build leaves yesterday's working scanner exactly as
// it was, and says so in the log.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'build-scan-index.mjs');
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

function clientScanDir() {
  return process.env.CLIENT_SCAN_DIR
    || path.join(process.env.CV_MODEL_DIR || path.join(__dirname, '..', 'data', 'models'), 'client-scan');
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch { return null; }
}

// SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
function sqliteUtcToMs(s) {
  if (!s) return null;
  const t = new Date(`${String(s).replace(' ', 'T')}Z`).getTime();
  return Number.isFinite(t) ? t : null;
}

// Is the scanner's list older than the catalogue it was built from?
// Pure, so the decision is testable without a database or a build.
function isIndexStale(manifest, catalogueRefreshedAt) {
  if (!manifest || !manifest.index) return false;   // no scanner installed: nothing to keep fresh
  const catalogueMs = sqliteUtcToMs(catalogueRefreshedAt);
  if (catalogueMs === null) return false;           // catalogue never imported: nothing newer to add
  const builtMs = new Date(manifest.built).getTime();
  if (!Number.isFinite(builtMs)) return true;       // unreadable build time: assume stale
  return builtMs < catalogueMs;
}

function runBuild(outDir, dbPath) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT, outDir], {
      env: { ...process.env, DB_PATH: dbPath },
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}\n${String(stderr || '').trim()}`;
        return reject(err);
      }
      resolve(String(stdout));
    });
  });
}

let inFlight = null;

// Rebuild the index into `dir` and atomically repoint manifest.json at it.
// Returns { rebuilt, index, previous } or { rebuilt:false, reason }.
async function rebuildScanIndex({ dir = clientScanDir(), dbPath = process.env.DB_PATH, log = console } = {}) {
  const manifest = readManifest(dir);
  if (!manifest || !manifest.index) return { rebuilt: false, reason: 'no_scanner_assets' };
  if (!dbPath || !fs.existsSync(dbPath)) return { rebuilt: false, reason: 'no_db_path' };

  // Build in a scratch dir so a half-written file can never sit next to the
  // live one under a name the glob in build-scan-assets would pick up.
  // INSIDE `dir`, not os.tmpdir(): prod's unit is ProtectSystem=strict and
  // only /var/lib/bindarr is writable, so /tmp would fail there and nowhere else.
  const tmp = fs.mkdtempSync(path.join(dir, '.build-'));
  try {
    const t0 = Date.now();
    await runBuild(tmp, dbPath);
    const built = fs.readdirSync(tmp).find(f => /^scan-index\.[0-9a-f]+\.json\.gz$/.test(f));
    if (!built) throw new Error('build produced no scan-index file');

    const previous = manifest.index;
    if (built !== previous) {
      fs.renameSync(path.join(tmp, built), path.join(dir, built));
    }

    const next = { ...manifest, index: built, built: new Date().toISOString() };
    const mtmp = path.join(dir, '.manifest.json.tmp');
    fs.writeFileSync(mtmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(mtmp, path.join(dir, 'manifest.json'));

    // Only now is the old index unreferenced. A phone mid-download of it may
    // 404 and retry against the new manifest, which is the correct outcome.
    if (built !== previous) {
      try { fs.unlinkSync(path.join(dir, previous)); } catch { /* already gone */ }
    }
    log.log(`scanIndex: rebuilt ${built} in ${Date.now() - t0} ms (was ${previous}).`);
    return { rebuilt: true, index: built, previous };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Rebuild only if stale. Concurrent callers share one build. Never throws:
// a stale scanner list must not take down the catalogue job that called it.
async function refreshScanIndexIfStale({ db, dir = clientScanDir(), log = console } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const row = await db.get(
        `SELECT card_catalogue_refreshed_at AS refreshedAt FROM app_settings WHERE id = 1`
      ).catch(() => null);
      const manifest = readManifest(dir);
      if (!isIndexStale(manifest, row && row.refreshedAt)) return { rebuilt: false, reason: 'current' };
      log.log(`scanIndex: index built ${manifest.built} is older than catalogue (${row.refreshedAt}); rebuilding.`);
      return await rebuildScanIndex({ dir, log });
    } catch (err) {
      log.error(`scanIndex: rebuild FAILED, previous index left in place: ${err.message}`);
      return { rebuilt: false, reason: 'error', error: err.message };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

module.exports = { isIndexStale, rebuildScanIndex, refreshScanIndexIfStale, clientScanDir };
