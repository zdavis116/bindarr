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

  console.log(`\nweak-match-ocr.test.js: ${passed} cases passed`);
  await db.close?.();
  process.exit(0);
})().catch(async (e) => {
  console.error('FAIL: FWEAK-TC0', e.message);
  await db.close?.();
  process.exit(1);
});
