// SHADOW MODE MUST BE UNABLE TO BREAK A SCAN.
//
// Phase 1b adds rgbArt to the live scan path purely to measure it. The single
// promise that makes that acceptable is: if ANY of it goes wrong, the scan Zach
// is running on a card he is physically holding proceeds exactly as before.
//
// That promise is easy to assert in a comment and easy to break in a refactor,
// so it is tested here against real failure modes rather than assumed.
'use strict';

const assert = require('assert');
const rgbArt = require('../src/rgbArtMatch');

(async () => {
  // 1. A MISSING INDEX must disable the feature, not throw. The index is a 9MB
  //    build artefact that is not in git; a fresh checkout has no index at all,
  //    and that must degrade to "no opinion".
  process.env.RGBART_INDEX = '/nonexistent/path/does-not-exist.bin';
  rgbArt._reset();
  assert.strictEqual(rgbArt.available(), false, 'missing index should report unavailable');
  assert.strictEqual(await rgbArt.identify(Buffer.from('nonsense')), null,
    'identify must return null when the index is missing, not throw');

  // 2. A CORRUPT index must be handled the same way. Truncation is the likely
  //    real-world shape: an interrupted scp or a partial write.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = path.join(os.tmpdir(), `rgbart-corrupt-${process.pid}.bin`);
  fs.writeFileSync(tmp, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x01]));
  process.env.RGBART_INDEX = tmp;
  rgbArt._reset();
  assert.strictEqual(rgbArt.available(), false, 'corrupt index should report unavailable');
  assert.strictEqual(await rgbArt.identify(Buffer.from('nonsense')), null,
    'identify must return null on a corrupt index');
  fs.unlinkSync(tmp);

  // 3. GARBAGE IMAGE INPUT must return null rather than propagate a sharp error.
  //    The route hands over whatever rectifyCard produced; that contract must
  //    hold even when the buffer is not a decodable image.
  delete process.env.RGBART_INDEX;
  rgbArt._reset();
  if (rgbArt.available()) {
    assert.strictEqual(await rgbArt.identify(Buffer.from('not an image at all')), null,
      'identify must return null on an undecodable buffer');
    assert.strictEqual(await rgbArt.identify(Buffer.alloc(0)), null,
      'identify must return null on an empty buffer');
  }

  // 4. NULL input -- what the route passes when detection failed -- must be
  //    handled explicitly, because that is the single most common real case.
  assert.strictEqual(await rgbArt.identify(null), null,
    'identify(null) must return null');
  assert.strictEqual(await rgbArt.identify(undefined), null,
    'identify(undefined) must return null');

  // 5. The failure must be PERMANENT, not retried per request. A missing index
  //    that re-reads the filesystem on every scan would add disk I/O to the hot
  //    path forever. Verify load() is only attempted once.
  process.env.RGBART_INDEX = '/nonexistent/again.bin';
  rgbArt._reset();
  const realExists = fs.existsSync;
  let calls = 0;
  fs.existsSync = (p) => { if (String(p).includes('again.bin')) calls++; return realExists(p); };
  rgbArt.available(); rgbArt.available(); await rgbArt.identify(Buffer.from('x'));
  fs.existsSync = realExists;
  assert.strictEqual(calls, 1,
    `index absence must be cached; filesystem was probed ${calls} times`);

  delete process.env.RGBART_INDEX;
  rgbArt._reset();
  console.log('rgbArt shadow safety: PASS (missing, corrupt, garbage, null, cached)');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
