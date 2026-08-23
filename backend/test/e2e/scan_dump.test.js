// The full-resolution scan dump: a DIAGNOSTIC that must never affect a scan.
//
// WHY THIS EXISTS. Everything kept for later inspection is a 220x308 review-queue
// THUMBNAIL — a ninth of the resolution the phone actually uploads. Tuning the
// OCR strip window against it means tuning against blur, and that has already
// produced two "fixes" that measured well and failed on Zach's phone. This
// writes the exact bytes the pipeline received so a window can be verified
// against real input.
//
// The rules under test are the ones that make a debug feature safe to merge:
//   - OFF unless SCAN_DUMP_DIR is set
//   - a broken dump target NEVER fails the scan
//   - bounded, so it cannot fill the dev box
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-dump-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');

let server, base, token, passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

// A 1x1 jpeg is enough: these cases are about the DUMP, not about matching.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

async function scan(dir) {
  // Fresh app per case so the env var is read at request time.
  if (dir === null) delete process.env.SCAN_DUMP_DIR;
  else process.env.SCAN_DUMP_DIR = dir;

  const res = await fetch(`${base}/api/scan-match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ game: 'mtg', image: `data:image/jpeg;base64,${TINY_JPEG.toString('base64')}` }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* may be empty */ }
  return { status: res.status, body };
}

async function main() {
  await db.initDb();
  const u = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?,?,'member',?)`,
    ['dump', db.hashPassword('test-only-password'), `share-dump-${process.pid}`]);
  token = `dump-${process.pid}`;
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)`,
    [token, u.lastID, new Date(Date.now() + 600000).toISOString()]);

  const collectionRoutes = require('../../src/routes/collection');
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', collectionRoutes);
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  // --- FSD-TC1: OFF BY DEFAULT --------------------------------------------
  //
  // A diagnostic that writes scans of a user's collection to disk without being
  // asked is a privacy problem, not a feature. It must do nothing at all unless
  // switched on deliberately.
  {
    const dir = path.join(os.tmpdir(), `dump-off-${process.pid}`);
    await scan(null);
    await new Promise(r => setTimeout(r, 150));   // the write is fire-and-forget
    assert.ok(!fs.existsSync(dir), 'no directory may be created when the flag is unset');
    pass('FSD-TC1', 'writes nothing unless SCAN_DUMP_DIR is set');
  }

  // --- FSD-TC2: WRITES THE FULL-RESOLUTION BYTES --------------------------
  //
  // The point of the whole feature: what lands on disk must be the bytes the
  // pipeline received, not a re-encode or a thumbnail of them.
  {
    const dir = path.join(os.tmpdir(), `dump-on-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    await scan(dir);
    await new Promise(r => setTimeout(r, 250));
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.jpg')) : [];
    assert.strictEqual(files.length, 1, `expected one dumped scan, got ${files.length}`);
    const written = fs.readFileSync(path.join(dir, files[0]));
    assert.ok(written.equals(TINY_JPEG),
      'the dump must be the exact bytes received — a re-encode would defeat the purpose');
    pass('FSD-TC2', 'writes the exact full-resolution bytes the pipeline received');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // --- FSD-TC3: A BROKEN DUMP TARGET NEVER FAILS A SCAN -------------------
  //
  // THE ONE THAT MATTERS FOR MERGING THIS. Zach is holding a physical card when
  // he scans. Losing that scan because a debug directory is unwritable would be
  // a strictly worse outcome than having no diagnostics at all.
  //
  // Asserted by COMPARISON, not against a fixed status. This test DB has no ORB
  // index, so scan-match fails on its own regardless — checking for "not 500"
  // would pass for the wrong reason and prove nothing. What matters is that an
  // unwritable dump target changes NOTHING about the response.
  {
    const blocker = path.join(os.tmpdir(), `dump-blocker-${process.pid}`);
    fs.writeFileSync(blocker, 'not a directory');

    const withoutDump = await scan(null);
    const withBrokenDump = await scan(path.join(blocker, 'sub'));

    assert.strictEqual(withBrokenDump.status, withoutDump.status,
      `a broken dump target changed the response (${withoutDump.status} -> ${withBrokenDump.status})`);
    assert.deepStrictEqual(withBrokenDump.body, withoutDump.body,
      'a broken dump target changed the response body');
    pass('FSD-TC3', 'an unwritable dump target changes nothing about the scan');
    fs.rmSync(blocker, { force: true });
  }

  // --- FSD-TC4: BOUNDED ----------------------------------------------------
  //
  // The dev box has 25GB and 2GB of RAM, and an unbounded write on every scan of
  // a several-hundred-card stack is how a debugging aid becomes an outage. It is
  // a sample, not a log.
  {
    const dir = path.join(os.tmpdir(), `dump-cap-${process.pid}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `scan-${i}.jpg`), 'x');
    await scan(dir);
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length, 40,
      'the dump must stop at its cap rather than growing without limit');
    pass('FSD-TC4', 'stops at the cap instead of filling the disk');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  delete process.env.SCAN_DUMP_DIR;
  console.log(`\nscan_dump.test.js: ${passed} cases passed`);
  server.close();
  process.exit(0);
}

main().catch(e => { console.error('FAIL:', e.message); if (server) server.close(); process.exit(1); });
