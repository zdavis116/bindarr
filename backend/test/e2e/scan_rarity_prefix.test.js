// PR 10 / BUG 1: RARITY-PREFIXED COLLECTOR NUMBERS, through the REAL route.
//
// WHY THIS SUITE EXISTS, and it is a correction to the PR 8 report.
//
// The report says the rarity-letter fallback shipped and works. Measured here,
// it DOES resolve 'M0207' -> tla 207 on a simple catalogue. So the headline
// claim "rarity-prefixed numbers never resolve" is NOT reproducible as stated,
// and this suite pins the behaviour so it cannot silently regress.
//
// What the investigation DID find is a narrower and more dangerous defect, and
// it is the one this suite is really about:
//
//   THE FALLBACK IS AN ELSE-BRANCH, NOT A SECOND LOOKUP.
//
// The resolver only consults the rarity-stripped reading when the number AS
// READ matched NOTHING. So when BOTH readings match real printings of the same
// card, the raw reading WINS SILENTLY and the stripped one is never considered.
// Real Scryfall rows make that reachable: C1, R1, U1, P1, S1, T1 and L1 are all
// genuine collector numbers (verified against the live API), and a card holding
// both 'M12' and '12' would be added as 'M12' with no question asked.
//
// That is a silent wrong printing — the exact failure the whole PR 8 design
// exists to prevent — so genuine ambiguity must QUEUE WITH THE UNION rather
// than prefer either reading.
//
// A UNIT TEST ON THE PARSER CANNOT PROVE ANY OF THIS. The parser already
// returns the right pair of readings; the decision lives in the resolver and
// reaches the collection through the route. So every case below POSTs to a real
// express app with the real routes and a real SQLite database, and asserts on
// what ended up in the `collection` table.
const assert = require('assert');
const express = require('express');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-pr10-rarity-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');

let server;
let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

// Modelled on real catalogue shapes, not convenient ones.
//
// - Avatar Aang is a TRANSFORMING DFC: the scan index supplies the combined
//   'Front // Back' name while card_cache stores the FRONT FACE only. Four
//   printings, exactly as Zach's queue showed.
// - 'GR1' (med) and 'A-12' are real letter-prefixed numbers that must NEVER be
//   stripped — 'GR1' has two leading letters and 'A-12' is not the rarity shape.
// - Eager Cadet really does carry number 'S1' in 8ED/9ED (verified via
//   Scryfall). It is the single-letter case that LOOKS strippable and is not,
//   and it is only safe because no '1' printing of that card exists here.
// - Ambi Card is the genuine-ambiguity case: BOTH 'M12' and '12' exist for one
//   card, so neither reading may be preferred.
const CARDS = [
  { id: 'aang-207', name: 'Avatar Aang', set_id: 'tla', number: '207' },
  { id: 'aang-350', name: 'Avatar Aang', set_id: 'tla', number: '350' },
  { id: 'aang-402', name: 'Avatar Aang', set_id: 'tla', number: '402' },
  { id: 'aang-501', name: 'Avatar Aang', set_id: 'tla', number: '501' },

  { id: 'elspeth-gr1', name: 'Elspeth, Knight-Errant', set_id: 'med', number: 'GR1' },
  { id: 'alch-a12', name: 'Alchemy Test Card', set_id: 'y22', number: 'A-12' },
  { id: 'cadet-s1', name: 'Eager Cadet', set_id: '9ed', number: 'S1' },

  { id: 'ambi-m12', name: 'Ambi Card', set_id: 'tla', number: 'M12' },
  { id: 'ambi-12', name: 'Ambi Card', set_id: 'tla', number: '12' },

  // Leading-zero case with exactly one printing.
  { id: 'zero-7', name: 'Zero Pad Card', set_id: 'tla', number: '7' },
];

async function seed() {
  for (const c of CARDS) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache
        (id, oracle_id, name, supertype, subtypes, types, rarity, set_id, set_name,
         number, image_url, type_line, cmc, color_identity, legalities, finishes, last_updated)
       VALUES (?, ?, ?, 'MTG', '[]', '[]', 'Mythic', ?, ?, ?, '', 'Creature', 3, '[]', ?, ?, CURRENT_TIMESTAMP)`,
      [c.id, `o-${c.name}`, c.name, c.set_id, `Set ${c.set_id}`, c.number,
       JSON.stringify({ commander: 'legal' }), JSON.stringify(['nonfoil'])]);
  }
  for (const [id, date] of [
    ['tla', '2025-11-21'], ['med', '2014-06-06'],
    ['y22', '2022-01-01'], ['9ed', '2005-07-29'],
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
    ['pr10user', db.hashPassword('test-only-password'), `share-pr10-${process.pid}`]);
  const userId = inserted.lastID;
  const token = `pr10-${process.pid}`;
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

  // What actually reached the collection — the only thing that proves an "add".
  const ownedNumbers = async () => {
    const rows = await db.all(
      `SELECT cc.set_id, cc.number FROM collection c
         JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND c.list_type = 'collection'`, [userId]);
    return rows.map(r => `${r.set_id}#${r.number}`);
  };

  const DFC = 'Avatar Aang // Aang, Steadfast Guardian';

  // --- BUG1-TC1: the reported failure — rarity-prefixed number ADDS ---------
  //
  // The scan index name is the COMBINED DFC name and the OCR text is the exact
  // shape Zach's phone produced: the mythic rarity letter glued to a zero-padded
  // number, with no space.
  {
    const before = await ownedNumbers();
    const out = await scanResolve({ name: DFC, ocr_text: 'M0207 . TLA . EN' });
    assert.strictEqual(out.action, 'added',
      `'M0207' must resolve, not queue. got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.set_id, 'tla');
    assert.strictEqual(out.card.number, '207',
      `must add the DIGITS-ONLY printing, got ${out.card.number}`);
    const after = await ownedNumbers();
    assert.strictEqual(after.length, before.length + 1, 'exactly one card added');
    assert.ok(after.includes('tla#207'), 'tla 207 must be in the collection');
    pass('FBUG1-TC1', "'M0207 TLA EN' is ADDED as tla 207 through the real route");
  }

  // --- BUG1-TC2: leading zeros strip ---------------------------------------
  {
    const out = await scanResolve({ name: 'Zero Pad Card', ocr_text: 'M0007 . TLA . EN' });
    assert.strictEqual(out.action, 'added', `got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.number, '7', 'M0007 -> 7');
    pass('FBUG1-TC2', 'a rarity prefix AND leading zeros both strip: M0007 -> 7');
  }

  // --- BUG1-TC3: GR1 is NOT stripped ---------------------------------------
  //
  // Two leading letters, so it is not the rarity shape at all. If a future
  // "simplification" widened the prefix rule, this card would resolve to a
  // DIFFERENT printing while looking perfectly successful.
  {
    const out = await scanResolve({ name: 'Elspeth, Knight-Errant', ocr_text: 'GR1 . MED . EN' });
    assert.strictEqual(out.action, 'added', `got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.number, 'GR1', 'GR1 must resolve AS ITSELF');
    assert.ok((await ownedNumbers()).includes('med#GR1'));
    pass('FBUG1-TC3', "'GR1' still resolves as itself and is never stripped to '1'");
  }

  // --- BUG1-TC4: A-12 is NOT stripped --------------------------------------
  {
    const out = await scanResolve({ name: 'Alchemy Test Card', ocr_text: 'A-12 . Y22 . EN' });
    assert.strictEqual(out.action, 'added', `got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.number, 'A-12', 'A-12 must resolve AS ITSELF');
    pass('FBUG1-TC4', "'A-12' still resolves as itself and is never stripped to '12'");
  }

  // --- BUG1-TC5: a REAL single-letter-prefixed number resolves as itself ----
  //
  // 'S1' is the hard case: it has the exact shape the stripper looks for
  // (one rarity letter + digits), and it is a REAL Scryfall collector number.
  // It is safe here only because the catalogue holds no '1' printing of this
  // card — which is precisely the point. THE CATALOGUE DECIDES, not the parser.
  {
    const out = await scanResolve({ name: 'Eager Cadet', ocr_text: 'S1 . 9ED . EN' });
    assert.strictEqual(out.action, 'added', `got ${JSON.stringify(out)}`);
    assert.strictEqual(out.card.number, 'S1',
      "'S1' is a real collector number and must resolve as itself");
    pass('FBUG1-TC5', "a real rarity-shaped number ('S1') resolves as itself when no digits-only row exists");
  }

  // --- BUG1-TC6: GENUINE AMBIGUITY QUEUES WITH THE UNION --------------------
  //
  // THE CORE DEFECT. Both 'M12' and '12' are real printings of this card, so
  // BOTH readings are backed by the catalogue and NEITHER may be preferred.
  // Before this fix the raw reading won silently and 'M12' was added with no
  // question asked — a silent wrong printing.
  {
    const before = await ownedNumbers();
    const out = await scanResolve({ name: 'Ambi Card', ocr_text: 'M12 . TLA . EN' });
    assert.strictEqual(out.action, 'staged_unresolved',
      `both readings are real printings -> MUST queue, not pick one. got ${JSON.stringify(out)}`);
    assert.strictEqual(out.reason, 'ambiguous');
    const nums = out.candidates.map(c => c.number).sort();
    assert.deepStrictEqual(nums, ['12', 'M12'],
      `the queue must offer the UNION of both readings, got ${JSON.stringify(nums)}`);
    // The property that matters: nothing silently entered the collection.
    assert.deepStrictEqual(await ownedNumbers(), before,
      'an ambiguous reading must add NOTHING');
    pass('FBUG1-TC6', 'when both readings are real printings the card QUEUES with the union and adds nothing');
  }

  // --- BUG1-TC7: owned printings sort first in that union ------------------
  //
  // Per PR 6I banding: the printing he already owns is usually the one in hand,
  // so the ambiguous queue entry must put it first and keep resolution one tap.
  {
    await db.run(
      `INSERT INTO collection (user_id, card_id, quantity, condition, list_type)
       VALUES (?, 'ambi-12', 2, 'Near Mint', 'collection')`, [userId]);
    const out = await scanResolve({ name: 'Ambi Card', ocr_text: 'M12 . TLA . EN' });
    assert.strictEqual(out.action, 'staged_unresolved');
    assert.strictEqual(out.candidates[0].number, '12',
      `the OWNED printing must sort first, got ${out.candidates.map(c => c.number).join(',')}`);
    pass('FBUG1-TC7', 'the ambiguous union is sorted owned-first');
  }

  // --- BUG1-TC8: a number matching NOTHING still never adds ----------------
  //
  // The catalogue remains the validator. 'M1508' strips to '1508', and neither
  // reading exists for this card, so it must queue exactly as before.
  {
    const before = await ownedNumbers();
    const out = await scanResolve({ name: DFC, ocr_text: 'M1508 . TLA . EN' });
    assert.strictEqual(out.action, 'staged_unresolved', `got ${JSON.stringify(out)}`);
    assert.deepStrictEqual(await ownedNumbers(), before, 'a read matching nothing adds nothing');
    pass('FBUG1-TC8', 'a reading backed by no catalogue row still queues and adds nothing');
  }

  // --- BUG1-TC9: DFC resolution is not regressed --------------------------
  //
  // No number at all: the combined name must still fall back to the front face
  // and offer all FOUR printings, as Zach's queue correctly showed.
  {
    const out = await scanResolve({ name: DFC, ocr_text: '' });
    assert.strictEqual(out.action, 'staged_unresolved');
    assert.strictEqual(out.candidates.length, 4,
      `all four Avatar Aang printings must be offered, got ${out.candidates.length}`);
    pass('FBUG1-TC9', 'DFC front-face resolution still offers all four printings');
  }

  console.log(`\nscan_rarity_prefix.test.js: ${passed} cases passed`);
}

main()
  .then(async () => { if (server) server.close(); await db.close?.(); process.exit(0); })
  .catch(async (err) => { console.error('FAIL:', err); if (server) server.close(); process.exit(1); });
