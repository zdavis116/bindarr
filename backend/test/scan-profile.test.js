// THE PROFILER MUST BE INERT WHEN OFF, AND HONEST WHEN ON.
//
// scanProfile sits in the hot path of every scan. Two ways it could hurt:
//   1. costing something when disabled -- it wraps several await points, so a
//      careless implementation adds promise overhead to every production scan
//   2. lying when enabled -- if `unaccounted` were computed wrongly the whole
//      exercise misleads us, and we are about to make a scheduling decision on
//      the strength of that one number
'use strict';

const assert = require('assert');

(async () => {
  // ---- disabled ----------------------------------------------------------
  delete process.env.SCAN_PROFILE;
  delete require.cache[require.resolve('../src/scanProfile')];
  const off = require('../src/scanProfile');
  assert.strictEqual(off.ENABLED, false, 'should be disabled without the env var');

  const p = off.start();
  p.mark('x');
  p.set('k', 1);
  // time() must still RETURN THE VALUE when disabled -- if it swallowed the
  // result, every profiled stage would break in production.
  assert.strictEqual(await p.time('y', async () => 42), 42,
    'time() must pass the wrapped value through when disabled');
  let logged = 0;
  const realLog = console.log;
  console.log = () => { logged++; };
  p.done();
  console.log = realLog;
  assert.strictEqual(logged, 0, 'disabled profiler must not log');

  // ---- enabled -----------------------------------------------------------
  process.env.SCAN_PROFILE = '1';
  delete require.cache[require.resolve('../src/scanProfile')];
  const on = require('../src/scanProfile');
  assert.strictEqual(on.ENABLED, true, 'should be enabled with the env var');

  const q = on.start({ tag: 'test' });
  assert.strictEqual(await q.time('a', async () => {
    await new Promise(r => setTimeout(r, 60));
    return 'v';
  }), 'v', 'time() must pass the wrapped value through when enabled');
  await new Promise(r => setTimeout(r, 40));
  q.mark('b');
  q.set('extra', 7);

  let out = null;
  console.log = (s) => { out = s; };
  q.done();
  console.log = realLog;

  assert.ok(out && out.startsWith('SCAN_PROFILE '), 'should emit a SCAN_PROFILE line');
  const rec = JSON.parse(out.slice('SCAN_PROFILE '.length));

  const names = rec.stages.map(s => s[0]);
  assert.deepStrictEqual(names, ['a', 'b'], `stages should be ordered, got ${names}`);
  assert.ok(rec.stages[0][1] >= 55, `stage a should be ~60ms, got ${rec.stages[0][1]}`);
  assert.ok(rec.stages[1][1] >= 35, `stage b should be ~40ms, got ${rec.stages[1][1]}`);
  assert.strictEqual(rec.tag, 'test', 'constructor meta should survive');
  assert.strictEqual(rec.extra, 7, 'set() meta should survive');

  // The honesty check: named stages plus unaccounted must reconstruct the
  // total. This is the number the speed decision rests on.
  const named = rec.stages.reduce((a, [, ms]) => a + ms, 0);
  assert.ok(Math.abs((named + rec.unaccounted) - rec.total) < 1.0,
    `stages + unaccounted (${named + rec.unaccounted}) must equal total (${rec.total})`);

  // UNTIMED WORK MUST SHOW UP AS UNACCOUNTED -- otherwise the profiler would
  // report a tidy breakdown while hiding exactly the time we are hunting.
  const r = on.start();
  await new Promise(res => setTimeout(res, 80));   // deliberately not timed
  r.mark('after-gap');                              // this DOES capture the gap
  const r2 = on.start();
  r2.mark('immediate');
  await new Promise(res => setTimeout(res, 80));    // gap AFTER the last mark
  let out2 = null;
  console.log = (s) => { out2 = s; };
  r2.done();
  console.log = realLog;
  const rec2 = JSON.parse(out2.slice('SCAN_PROFILE '.length));
  assert.ok(rec2.unaccounted >= 70,
    `untimed trailing work must appear as unaccounted, got ${rec2.unaccounted}`);

  delete process.env.SCAN_PROFILE;
  console.log('scanProfile: PASS (inert when off, ordered/honest when on, gaps surface)');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
