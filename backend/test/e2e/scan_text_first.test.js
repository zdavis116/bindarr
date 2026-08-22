// PR 11: TEXT-FIRST SCANNING, through the REAL route.
//
// THE INSIGHT, from Zach looking at his own card: "get name of card and set
// number and find it, it should be unique majority of the time."
//
// He is right, and it reframes the design. Today the pipeline identifies the
// CARD by CLIP artwork similarity and uses OCR only for the collector number,
// which makes the ARTWORK a single point of failure. Measured on his photos:
//
//   clean Scryfall image  ->  MATCH Fated Firepower tla#132
//   his phone photo       ->  noise: Transpose 9 inliers, Outpace Oblivion 8,
//                             Furnace Celebration 7
//
// The card is not foil and not sleeved. A phone torch inches from glossy stock
// blows out the region CLIP reads. In the SAME photo the title and the bottom
// line are both plainly legible — so the identifying information is PRINTED
// TEXT and does not need the artwork at all.
//
// WHAT THIS SUITE PINS, and why each case is here rather than in a unit test:
// the decision lives in the resolver and reaches the COLLECTION through the
// route, so every case POSTs to a real express app with real routes and a real
// SQLite database and asserts on what ended up in the `collection` table. A
// unit test on the matcher would prove the parts work — which is exactly what
// PR 8 proved while the feature did not exist.
const assert = require('assert');
const express = require('express');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-pr11-textfirst-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');

let server;
let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

// Modelled on the real catalogue, including the shapes that make this hard.
//
// - Fated Firepower is Zach's card: one printing, tla #132. The title+number
//   path must add it outright.
// - 'Fated Retribution' is a REAL near-miss name that shares a prefix. It is
//   the decoy a loose fuzzy match would land on.
// - Sol Ring has two printings sharing number 263, which is what the set code
//   is allowed to disambiguate — and only that.
// - 'Avatar of Woe' / 'Avatar of Hope' are 2 edits apart, the measured floor
//   for distinct real card names. A read between them must refuse.
const CARDS = [
  { id: 'ff-tla-132', name: 'Fated Firepower', set_id: 'tla', number: '132' },
  { id: 'fr-tla-140', name: 'Fated Retribution', set_id: 'tla', number: '140' },

  { id: 'sol-c21-263', name: 'Sol Ring', set_id: 'c21', number: '263' },
  { id: 'sol-lcc-263', name: 'Sol Ring', set_id: 'lcc', number: '263' },

  { id: 'aang-tla-207', name: 'Avatar Aang', set_id: 'tla', number: '207' },

  { id: 'woe-tsp-105', name: 'Avatar of Woe', set_id: 'tsp', number: '105' },
  { id: 'hope-usg-6', name: 'Avatar of Hope', set_id: 'usg', number: '6' },

  { id: 'sand-mom-203', name: 'Sandstalker Moloch', set_id: 'mom', number: '203' },
  // The shorter namesake the truncation guard exists for. A REAL card.
  { id: 'sand-mir-311', name: 'Sandstalker', set_id: 'mom', number: '311' },

  // Rarity-prefix interaction with the TITLE path.
  { id: 'kick-neo-207', name: 'Spinning Wheel Kick', set_id: 'neo', number: '207' },
];

async function seed() {
  for (const c of CARDS) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache
        (id, oracle_id, name, supertype, subtypes, types, rarity, set_id, set_name,
         number, image_url, type_line, cmc, color_identity, legalities, finishes, last_updated)
       VALUES (?, ?, ?, 'MTG', '[]', '[]', 'Rare', ?, ?, ?, '', 'Creature', 3, '[]', ?, ?, CURRENT_TIMESTAMP)`,
      [c.id, `o-${c.name}`, c.name, c.set_id, `Set ${c.set_id}`, c.number,
       JSON.stringify({ commander: 'legal' }), JSON.stringify(['nonfoil'])]);
  }
  for (const [id, date] of [
    ['tla', '2025-11-21'], ['c21', '2021-04-23'], ['lcc', '2023-06-23'],
    ['neo', '2022-02-18'], ['tsp', '2006-10-06'], ['usg', '1998-10-12'], ['mom', '2023-04-21'],
  ]) {
    await db.run(`INSERT OR REPLACE INTO sets (id, name, release_date) VALUES (?, ?, ?)`,
      [id, `Set ${id}`, date]);
  }
}

async function main() {
  await db.initDb();
  await seed();

  const inserted = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    ['pr11user', db.hashPassword('test-only-password'), `share-pr11-${process.pid}`]);
  const userId = inserted.lastID;
  const token = `pr11-${process.pid}`;
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    [token, userId, new Date(Date.now() + 600_000).toISOString()]);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', collectionRoutes);   // routers mount at BARE /api
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const scanResolve = (body) => fetch(`${base}/api/scan-resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(r => r.json());

  const owned = async () => {
    const rows = await db.all(
      `SELECT cc.name, cc.set_id, cc.number FROM collection c
         JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND c.list_type = 'collection'`, [userId]);
    return rows.map(r => `${r.name}|${r.set_id}#${r.number}`);
  };

  // --- FTF-TC1: TITLE + NUMBER resolving uniquely is ADDED, with NO CLIP name -
  //
  // THE HEADLINE CASE. `name` is empty — CLIP identified nothing, exactly as it
  // fails on Zach's glared photo. The title and number alone must carry it.
  {
    const before = await owned();
    const out = await scanResolve({
      name: '',
      title_text: 'Fated Firepower',
      ocr_text: 'M 0132 / TLA . EN',
    });
    assert.strictEqual(out.action, 'added',
      `title+number must resolve without CLIP. got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.set_id, 'tla');
    assert.strictEqual(out.card.number, '132');
    const after = await owned();
    assert.strictEqual(after.length, before.length + 1, 'exactly one card added');
    assert.ok(after.includes('Fated Firepower|tla#132'));
    pass('FTF-TC1', 'title + collector number resolves uniquely and is ADDED with no CLIP match at all');
  }

  // --- FTF-TC2: TEXT BEATS CLIP when they disagree --------------------------
  //
  // CLIP says 'Avatar Aang' — the shape of a glare-induced wrong match. The
  // title says 'Fated Firepower' and the number backs it. The text must win:
  // CLIP is the thing that fails on a glared card, and the text is what
  // survives.
  {
    const out = await scanResolve({
      name: 'Avatar Aang',
      title_text: 'Fated Firepower',
      ocr_text: 'M 0132 / TLA . EN',
    });
    assert.strictEqual(out.action, 'added', `got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.name, 'Fated Firepower',
      `text must win over a disagreeing CLIP match, got ${out.card.name}`);
    pass('FTF-TC2', 'a confident title+number is preferred over a disagreeing CLIP match');
  }

  // --- FTF-TC3: an UNREADABLE title falls back to CLIP + number --------------
  //
  // Today's behaviour must survive intact: this is the path every card took
  // before this PR, and 100% of clean-image identification depends on it.
  {
    const out = await scanResolve({
      name: 'Spinning Wheel Kick',
      title_text: '',                       // nothing legible in the title band
      ocr_text: '0207/0302 R . NEO . EN',
    });
    assert.strictEqual(out.action, 'added', `got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.name, 'Spinning Wheel Kick');
    assert.strictEqual(out.card.number, '207');
    pass('FTF-TC3', 'an unreadable title falls back to CLIP + number, unchanged');
  }

  // --- FTF-TC4: a title matching NOTHING never adds -------------------------
  //
  // The catalogue is still the validator. A title that resolves to no card must
  // not add, and must not be allowed to drag CLIP's answer in behind it either.
  //
  // REVISED FOR THE OCR FALLBACK. This case originally supplied a clean
  // '0132 . TLA . EN' alongside the gibberish title, and asserted 'queued'
  // because at the time a name and a title were the ONLY two routes to a card —
  // so a scan with neither had no legitimate answer.
  //
  // The collector strip is now a third route (Zach: "If we have both set and
  // number we should just use OCR as the fallback"), and tla/132 is not an
  // inference drawn from the bad title — it is the card's own printed catalogue
  // address. That scenario therefore HAS a right answer now, and asserting
  // 'queued' would be asserting the old sequence rather than a rule.
  //
  // The property this case exists to protect is unchanged and is what is tested
  // here: a garbage title must not pull a card in on its own. So the collector
  // strip is removed, leaving the title as the only signal — and it must queue.
  // The anti-guessing rules around the new route are pinned separately in
  // scan_ocr_fallback.test.js (a number with no set code, and an address that
  // matches nothing, both queue).
  {
    const before = await owned();
    const out = await scanResolve({
      name: '',
      title_text: 'Qwzzx Vermilion Nonesuch',
      ocr_text: '',                        // nothing readable on the strip
    });
    assert.strictEqual(out.action, 'queued',
      `a title matching nothing must never add. got ${JSON.stringify(out)}`);
    assert.deepStrictEqual(await owned(), before, 'nothing entered the collection');
    pass('FTF-TC4', 'a title matching nothing queues and adds nothing');
  }

  // --- FTF-TC5: a NEAR-MISS title WITHIN tolerance matches ------------------
  //
  // 'Fated Firepowor' is one substitution from the real name — the everyday
  // OCR near-miss the fuzzy matcher exists for.
  {
    const out = await scanResolve({
      name: '',
      title_text: 'Fated Firepowor',
      ocr_text: '0132 . TLA . EN',
    });
    assert.strictEqual(out.action, 'added',
      `a 1-edit near miss must still resolve. got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.name, 'Fated Firepower');
    pass('FTF-TC5', 'a near-miss title within tolerance (d=1) resolves to the right card');
  }

  // --- FTF-TC6: a near-miss title OUTSIDE tolerance does NOT match ----------
  //
  // Far enough from every name that accepting it would be a guess. It must
  // queue rather than pick the nearest thing.
  //
  // REVISED FOR THE OCR FALLBACK, same reasoning as FTF-TC4: the collector strip
  // is now an independent route to the card, so leaving a clean
  // '0132 . TLA . EN' in this request would resolve legitimately and the case
  // would be asserting the old sequence instead of the rule. The property under
  // test — a title too far from every name must not fuzzy-match its way in — is
  // isolated by removing the strip.
  {
    const before = await owned();
    const out = await scanResolve({
      name: '',
      title_text: 'Fxtxd Fxrxpxwxr',
      ocr_text: '',                        // nothing readable on the strip
    });
    assert.strictEqual(out.action, 'queued',
      `a title outside tolerance must NOT match. got ${JSON.stringify(out)}`);
    assert.deepStrictEqual(await owned(), before, 'and must add nothing');
    pass('FTF-TC6', 'a title outside the measured tolerance refuses and queues');
  }

  // --- FTF-TC7: AMBIGUOUS between two REAL close names -> refuse ------------
  //
  // 'Avatar of Woe' and 'Avatar of Hope' are 2 edits apart — the measured floor
  // for distinct real card names. A read sitting between them has identified a
  // NEIGHBOURHOOD, not a card, and must not pick one.
  //
  // REVISED FOR THE OCR FALLBACK, same reasoning as FTF-TC4 and FTF-TC6. With a
  // clean 'TSP 0105' on the strip the scan is no longer ambiguous at all — the
  // card states its own catalogue address, and refusing would be discarding a
  // definite answer because a DIFFERENT signal was unclear. The strip is removed
  // so the margin gate is what the case actually exercises.
  {
    const before = await owned();
    const out = await scanResolve({
      name: '',
      title_text: 'Avatar of Wope',
      ocr_text: '',                        // nothing readable on the strip
    });
    assert.strictEqual(out.action, 'queued',
      `a read between two real close names must refuse. got ${JSON.stringify(out)}`);
    assert.deepStrictEqual(await owned(), before, 'and must add nothing');
    pass('FTF-TC7', 'a title equidistant between two real card names refuses (margin gate)');
  }

  // --- FTF-TC8: a MISREAD SET does not veto the title path ------------------
  //
  // The bug just fixed on the number path must not be reintroduced here. 'TAA'
  // is a one-letter misread of 'TLA'; the title and number are both correct and
  // yield exactly one printing, so the set has nothing to disambiguate and must
  // not be able to discard it.
  {
    const before = await owned();
    const out = await scanResolve({
      name: '',
      title_text: 'Fated Firepower',
      ocr_text: 'M 0132 / TAA . EN',
    });
    assert.strictEqual(out.action, 'added',
      `a misread set must NEVER veto a unique title+number. got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.set_id, 'tla');
    assert.strictEqual((await owned()).length, before.length + 1);
    pass('FTF-TC8', 'a misread set code does not veto a unique title+number resolution');
  }

  // --- FTF-TC9: the set NARROWS when title+number is genuinely ambiguous ----
  //
  // Two printings of Sol Ring share #263. This is the ONLY job the set is
  // allowed to do, and it must still do it.
  {
    const out = await scanResolve({
      name: '',
      title_text: 'Sol Ring',
      ocr_text: '0263/0281 U . LCC . EN',
    });
    assert.strictEqual(out.action, 'added', `got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.set_id, 'lcc',
      `the set must narrow a genuine tie, got ${out.card.set_id}`);
    pass('FTF-TC9', 'the set code still narrows when title+number matches several printings');
  }

  // --- FTF-TC10: title + AMBIGUOUS number, no set -> QUEUES with both -------
  {
    const before = await owned();
    const out = await scanResolve({
      name: '',
      title_text: 'Sol Ring',
      ocr_text: '0263',
    });
    assert.strictEqual(out.action, 'queued', `got ${JSON.stringify(out)}`);
    assert.strictEqual(out.reason, 'ambiguous');
    assert.strictEqual(out.candidates.length, 2, 'both printings offered');
    assert.deepStrictEqual(await owned(), before, 'a queued card is never owned');
    pass('FTF-TC10', 'title + an ambiguous number queues with both printings and adds nothing');
  }

  // --- FTF-TC11: a title with NO number still never auto-adds --------------
  //
  // Zach's rule: name + number is the primary key. A title alone identifies the
  // CARD, not the PRINTING, so it must queue the printings — never guess one.
  {
    const before = await owned();
    const out = await scanResolve({
      name: '',
      title_text: 'Sol Ring',
      ocr_text: '',
    });
    assert.strictEqual(out.action, 'queued',
      `a title with no number must not pick a printing. got ${JSON.stringify(out)}`);
    assert.ok(out.candidates.length >= 2);
    assert.deepStrictEqual(await owned(), before);
    pass('FTF-TC11', 'a title with no readable number queues the printings rather than guessing');
  }

  // --- FTF-TC12: RARITY-PREFIXED number resolves on the TITLE path ----------
  //
  // The union fix must apply here too: 'M0132' is the rarity letter glued to a
  // correct number, and the title path must reach the same tla #132.
  {
    const before = await owned();
    const out = await scanResolve({
      name: '',
      title_text: 'Fated Firepower',
      ocr_text: 'M0132 . TLA . EN',
    });
    assert.strictEqual(out.action, 'added',
      `'M0132' must strip on the title path too. got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.number, '132');
    assert.strictEqual((await owned()).length, before.length + 1);
    pass('FTF-TC12', "a rarity-prefixed number ('M0132') resolves on the title path");
  }

  // --- FTF-TC13: text-first does not disturb the DFC fallback --------------
  //
  // No title read, combined DFC name from the scan index: today's behaviour.
  {
    const out = await scanResolve({
      name: 'Avatar Aang // Aang, Steadfast Guardian',
      title_text: '',
      ocr_text: '0207 . TLA . EN',
    });
    assert.strictEqual(out.action, 'added', `got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.name, 'Avatar Aang');
    pass('FTF-TC13', 'DFC front-face resolution is unchanged by the text-first path');
  }

  // --- FTF-TC14: a WRONG title with a right CLIP name does not silently add -
  //
  // The inverse safety check of TC2. If the title resolves CONFIDENTLY to a
  // different card than CLIP found, the two signals disagree about identity —
  // and the number decides which one the catalogue backs. Here the number
  // (#140) backs the TITLE's answer, so that is what must be added; nothing may
  // be added on CLIP's name that the number does not support.
  {
    const out = await scanResolve({
      name: 'Fated Firepower',
      title_text: 'Fated Retribution',
      ocr_text: '0140 . TLA . EN',
    });
    assert.strictEqual(out.action, 'added', `got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.name, 'Fated Retribution',
      'the printing added must be the one the catalogue actually backs');
    assert.strictEqual(out.card.number, '140');
    pass('FTF-TC14', 'when title and CLIP disagree, the catalogue-backed title+number wins');
  }

  // --- FTF-TC15: a TRUNCATED title must not resolve to the shorter card ----
  //
  // FOUND BY THE GLARE HARNESS, not by reasoning. Under a heavy highlight
  // 'Sandstalker Moloch' read as 'Sandstalker A' — the second word destroyed.
  // That read is 2 edits from 'Sandstalker' and 5 from the true name, so plain
  // edit distance confidently picks the WRONG card and no runner-up is close
  // enough for the margin gate to notice. It was the only false add in the
  // whole comparison.
  //
  // A truncated read is equally consistent with "the short card" and with "the
  // long card with its tail blown out". Those are different cards, so it must
  // queue rather than pick.
  //
  // REVISED FOR THE OCR FALLBACK, same reasoning as FTF-TC4/6/7. This case is
  // about a TRUNCATED TITLE being unresolvable, and it stays exactly that — but
  // with 'MOM 0203' also on the strip the scan is not unresolvable at all, since
  // the card states its own catalogue address. Refusing then would be throwing
  // away a definite answer because a different signal was damaged, which is the
  // opposite of what the glare harness was protecting against. The strip is
  // removed so the truncation rule is what the case exercises.
  {
    const before = await owned();
    const out = await scanResolve({
      name: '',
      title_text: 'Sandstalker A',
      ocr_text: '',                        // nothing readable on the strip
    });
    assert.strictEqual(out.action, 'queued',
      `a truncated title must not resolve to the shorter card. got ${JSON.stringify(out)}`);
    assert.deepStrictEqual(await owned(), before, 'and must add nothing');
    pass('FTF-TC15', 'a glare-truncated title refuses instead of resolving to a shorter name');
  }

  // --- FTF-TC16: a legitimately SHORT name still resolves exactly -----------
  //
  // The truncation guard must not make short cards unscannable. An exact read
  // of 'Sandstalker' IS that card, even though a longer name starts the same
  // way — truncation leaves residue, so the real failure was distance 2, not 0.
  {
    const out = await scanResolve({
      name: '',
      title_text: 'Sandstalker',
      ocr_text: '0311 . MOM . EN',
    });
    assert.strictEqual(out.action, 'added',
      `an EXACT read of a short name must still resolve. got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.name, 'Sandstalker');
    pass('FTF-TC16', 'an exact read of a short name still resolves despite a longer namesake');
  }

  console.log(`\nscan_text_first.test.js: ${passed} cases passed`);
}

main()
  .then(async () => { if (server) server.close(); await db.close?.(); process.exit(0); })
  .catch(async (err) => { console.error('FAIL:', err); if (server) server.close(); process.exit(1); });
