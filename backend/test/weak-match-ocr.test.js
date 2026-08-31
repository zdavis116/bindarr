// A WEAK ART MATCH MUST NOT OUTRANK THE CARD'S OWN PRINTED NUMBER.
//
// Zach scanned foil Marvel cards. ORB returned 8-12 inliers -- noise -- and
// named FOUR DIFFERENT wrong cards across four photos of the same Evil's
// Thrall, while OCR read its printed address (msh #128) correctly every time.
// Three of those wrong names were confident enough to reach his collection.
//
// Foil scatters light into thousands of false edge features, so edge matching
// degrades to guessing exactly where the printed text is still perfectly
// legible. The fix is not a better matcher: it is letting the card's own
// catalogue address win when the art is admittedly guessing.
//
// These tests pin the behaviour AND its limits, because the dangerous version
// of this fix is one that lets OCR override a GOOD match.
'use strict';

const assert = require('assert');
const path = require('path');
const db = require('../src/db');

const FIXTURES = [
  // the card actually in hand
  { id: 'evil-thrall', name: "Evil's Thrall", set_id: 'msh', number: '128', release_date: '2026-01-01' },
  // what ORB guessed on four different photos of it
  { id: 'hindering', name: 'Hindering Light', set_id: 'eve', number: '141', release_date: '2008-01-01' },
  { id: 'burst', name: 'Burst of Speed', set_id: 'ons', number: '190', release_date: '2002-01-01' },
];

async function seed() {
  await db.initDb();
  for (const c of FIXTURES) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache
         (id, oracle_id, name, oracle_name, set_id, number, set_name, image_url, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [c.id, 'o-' + c.id, c.name, c.name, c.set_id, c.number, c.set_id.toUpperCase(), '']);
  }
}

let passed = 0;
function pass(id, msg) { console.log(`PASS: ${id} ${msg}`); passed++; }

(async () => {
  await seed();
  const { resolveScannedPrinting } = require('../src/utils/scanPrintingResolver');
  const OCR = "L 0128\nMSH * EN % ARTIST\n";
  // A card whose name has exactly ONE printing, for the uniqueness branch.
  await db.run(
    `INSERT OR REPLACE INTO card_cache
       (id, oracle_id, name, oracle_name, set_id, number, set_name, image_url, last_updated)
     VALUES ('namor-msc', 'o-namor-msc', 'Namor, Scourge of the Seas',
             'Namor, Scourge of the Seas', 'msc', '631', 'MSC', '', datetime('now'))`);
  const userId = 1;

  // 1. THE FOIL CASE. Art guessed 'Hindering Light' at 9 inliers; the strip says
  //    msh #128. The printed number must win.
  {
    const r = await resolveScannedPrinting({
      matchedName: 'Hindering Light', titleText: '', ocrText: OCR, userId, matchInliers: 9,
    });
    assert.strictEqual(r.action, 'add', 'a noise-level match plus a clean number should resolve');
    assert.strictEqual(r.printing.id, 'evil-thrall',
      `expected the printed address to win, got ${r.printing.name}`);
    assert.strictEqual(r.resolvedBy, 'ocr-over-weak-art');
    pass('FWEAK-TC1', 'a 9-inlier art guess does not outrank the printed collector number');
  }

  // 2. THE LIMIT THAT MATTERS. A STRONG match must be untouched, or this fix
  //    trades one silent-wrong-card failure for another.
  {
    const r = await resolveScannedPrinting({
      matchedName: 'Hindering Light', titleText: '', ocrText: OCR, userId, matchInliers: 120,
    });
    assert.notStrictEqual(r.resolvedBy, 'ocr-over-weak-art',
      'a 120-inlier match must NOT be overridden by OCR');
    pass('FWEAK-TC2', 'a strong art match keeps its priority — OCR does not override it');
  }

  // 3. UNKNOWN STRENGTH BEHAVES AS BEFORE. An older client sends no inlier
  //    count; that must not silently enable the new path.
  {
    const r = await resolveScannedPrinting({
      matchedName: 'Hindering Light', titleText: '', ocrText: OCR, userId, matchInliers: null,
    });
    assert.notStrictEqual(r.resolvedBy, 'ocr-over-weak-art',
      'unknown match strength must not trigger the override');
    pass('FWEAK-TC3', 'a missing inlier count falls back to the old behaviour');
  }

  // 4. NEVER SILENT ON AMBIGUITY. A number that resolves to nothing real must
  //    not invent a card.
  {
    const r = await resolveScannedPrinting({
      matchedName: 'Hindering Light', titleText: '',
      ocrText: "L 9999\nZZZ * EN\n", userId, matchInliers: 9,
    });
    assert.notStrictEqual(r.resolvedBy, 'ocr-over-weak-art',
      'a number matching no real printing must not resolve');
    pass('FWEAK-TC4', 'a collector number matching nothing real never adds a card');
  }

  // 5. UNIQUENESS IS NOT IDENTIFICATION.
  //
  //    Zach: "check the namor card because it should be namor the sub-mariner".
  //    He scanned Namor the Sub-Mariner (msh #69). The art matched 'Namor,
  //    Scourge of the Seas' at 16 inliers -- noise -- and the strip read no
  //    number. That name has exactly ONE printing, so the "unique name means no
  //    printing ambiguity" short-circuit added it with NO confidence check.
  //
  //    That branch answers "which printing of this card", not "is this the
  //    card".
  {
    const r = await resolveScannedPrinting({
      matchedName: 'Namor, Scourge of the Seas',
      titleText: '', ocrText: '', userId, matchInliers: 16,
    });
    assert.strictEqual(r.action, 'queue',
      `a 16-inlier guess must not add a card, got ${r.action} `
      + `(${r.printing && r.printing.name})`);
    pass('FWEAK-TC5', 'a weak art match with a unique name queues instead of adding');
  }

  // 6. THE SHORT-CIRCUIT STILL WORKS WHEN THE MATCH IS REAL.
  //
  //    It exists for the session where confident CORRECT matches were queued
  //    because the 6pt collector number would not read. That must survive.
  {
    const r = await resolveScannedPrinting({
      matchedName: 'Namor, Scourge of the Seas',
      titleText: '', ocrText: '', userId, matchInliers: 120,
    });
    assert.strictEqual(r.action, 'add',
      `a strong match on a one-printing card must still add, got ${r.action}`);
    pass('FWEAK-TC6', 'a strong art match with a unique name still adds');
  }

  // 7. AGREEMENT MUST NOT BE TREATED AS FAILURE.
  //
  //    Zach's Evil's Thrall queued with ocr_number=128, ocr_set='mshen',
  //    confident=1 and exactly ONE candidate: Evil's Thrall. The strip resolved
  //    to msh #128, which IS Evil's Thrall -- and it queued anyway.
  //
  //    The weak-art branch only fired when the strip DISAGREED with the art
  //    match. When they agreed it fell through to the ordinary path, where a
  //    weak match cannot add. Two independent signals naming the same card was
  //    a worse outcome than one signal naming a different one.
  {
    const r = await resolveScannedPrinting({
      matchedName: "Evil's Thrall", titleText: '', ocrText: OCR, userId, matchInliers: 16,
    });
    assert.strictEqual(r.action, 'add',
      `art and print agreeing on the same card must add, got ${r.action} (${r.reason})`);
    assert.strictEqual(r.printing.id, 'evil-thrall');
    pass('FWEAK-TC7', 'a weak art match AGREEING with the printed address adds the card');
  }

  console.log(`\nweak-match-ocr.test.js: ${passed} cases passed`);
  await db.close?.();
  process.exit(0);
})().catch(async (e) => {
  console.error('FAIL: FWEAK-TC0', e.message);
  await db.close?.();
  process.exit(1);
});
