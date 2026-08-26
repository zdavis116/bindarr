// THE LABEL MUST LAND ON THE RIGHT CAPTURE.
//
// Zach is about to resolve ~18 queued cards to build a labelled corpus. Before
// asking him to do that work, prove the label lands on the capture that ACTUALLY
// produced each row.
//
// The bug this guards: labelCapture used `lastDumpName`, a module-level
// variable holding whatever was scanned most recently. Resolving 18 rows after
// a session would have written all 18 labels onto the LAST image scanned --
// producing a corpus that is not merely incomplete but actively WRONG. Wrong
// labels are worse than none, because every future measurement inherits them
// silently and looks fine.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
function pass(id, msg) { console.log(`PASS: ${id} ${msg}`); passed++; }

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'collection.js'), 'utf8');

  // 1. The queue row must PERSIST which capture produced it.
  assert.ok(/INSERT INTO scan_review_queue[\s\S]{0,400}dump_file\)/.test(src),
    'the queue INSERT must store dump_file');
  assert.ok(/\n\s*lastDumpName,\n/.test(src),
    'the capture name must be among the INSERT values');
  pass('FLBL-TC1', 'the queue row records which capture produced it');

  // 2. Resolving must label THAT capture, not the most recent one.
  assert.ok(/labelCapture\(entry\.dump_file \|\| null,/.test(src),
    'labelCapture must use the row\'s own dump_file — using lastDumpName here '
    + 'would put every label from a session onto the last image scanned');
  assert.ok(!/labelCapture\(lastDumpName/.test(src),
    'no path may label using the module-level most-recent name');
  pass('FLBL-TC2', 'a resolved card labels its OWN capture, not the newest one');

  // 3. The name must be assigned synchronously, before the async write.
  const gate = src.slice(src.indexOf('if (process.env.SCAN_DUMP_DIR)'),
    src.indexOf('if (process.env.SCAN_DUMP_DIR)') + 1400);
  assert.ok(/const dumpName = `scan-\$\{Date\.now\(\)\}\.jpg`;[\s\S]{0,120}lastDumpName = dumpName;[\s\S]{0,80}\(async \(\) => \{/.test(gate),
    'the dump name must be assigned BEFORE the fire-and-forget write, or the '
    + 'value can still be the previous capture when /scan-resolve arrives');
  pass('FLBL-TC3', 'the capture name is set synchronously, the write stays async');

  // 4. The migration must exist, or dump_file is silently dropped on older DBs.
  const db = fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  assert.ok(/scan_review_queue[\s\S]{0,200}dump_file/.test(db)
    || /ALTER TABLE scan_review_queue ADD COLUMN dump_file TEXT/.test(db),
    'existing databases need a migration for dump_file');
  pass('FLBL-TC4', 'existing databases get the dump_file column');

  // 5. Labelling must never be able to break a scan.
  assert.ok(/async function labelCapture[\s\S]{0,600}catch \{/.test(src),
    'labelCapture must swallow its own failures — a diagnostics write must '
    + 'never fail a scan');
  pass('FLBL-TC5', 'a labelling failure cannot affect a scan');

  console.log(`\nscan-label.test.js: ${passed} cases passed`);
})().catch((e) => { console.error('FAIL: FLBL', e.message); process.exit(1); });
