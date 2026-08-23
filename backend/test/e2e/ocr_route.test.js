// Collector-number OCR, exercised THROUGH THE REAL ROUTE.
//
// WHY THIS SUITE EXISTS. Twice now the OCR pipeline has been "verified" by
// something that prepared its own input:
//
//   PR 8  benchmarked the module on a crop it built itself and scored 12/15.
//         The route fed it a different crop. Live scans read flavour text.
//   PR 22 swept crop offsets against images IT rectified from the original and
//         picked 0.924. The route was passing preprocessCard's 500x700, so the
//         module upscaled a ~8px strip 1.5x and read blur. Measured through the
//         real route, EVERY offset from 0.86 to 0.96 scored 0/4 — and offsets
//         where the text half-appeared returned FABRICATED numbers that still
//         reported confident=true ("SEI 39/302 M").
//
// Both were green. Neither touched the route. So this suite POSTs a real image
// to a REAL express app with the REAL collection routes and a REAL database,
// and asserts on result.ocr.number — the field the client actually reads.
//
// A test that calls collectorNumberOcr directly would pass on both the broken
// and the fixed code and is therefore not evidence. Do not add one here.
//
// HONEST LIMIT OF THIS FIXTURE, because it changes what TC1 proves. The input is
// a real card image composited into a synthetic scene
// (test/helpers/stagedCardPhoto.js): right resolution, right typography, right
// framing, real JPEG loss — but no sensor noise, no motion blur, no lens MTF
// falloff. Measured: at Zach's stated framing the OLD BROKEN PATH ALSO SCORES
// 4/4 on this fixture. So TC1 is a regression gate, not a reproduction.
//
// TC1B is the case that actually discriminates: with the card small in frame and
// softened, the old path fabricated confident-but-wrong numbers ("26" and "160"
// for #263 and #168) and the new path reads 4/4. That is the mechanism from
// production — too few pixels on the strip — reproduced where this fixture can
// still show it.
const assert = require('assert');
const express = require('express');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-ocrroute-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');
const collectorNumberOcr = require('../../src/utils/collectorNumberOcr');
const { stagedCards } = require('../helpers/stagedCardPhoto');

let server;
let base;
let passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

async function createUser(username) {
  const inserted = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, 'member', ?)`,
    [username, db.hashPassword('test-only-password'), `share-${username}-${process.pid}`]
  );
  const token = `${username}-${process.pid}`;
  await db.run(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
    [token, inserted.lastID, new Date(Date.now() + 600_000).toISOString()]
  );
  return { id: inserted.lastID, token };
}

async function seedPrinting({ id, oracle_id, name, set_id, set_name, number, finishes }) {
  await db.run(
    `INSERT OR REPLACE INTO card_cache
      (id, oracle_id, name, supertype, subtypes, types, rarity, set_id, set_name,
       number, image_url, type_line, cmc, color_identity, legalities, finishes, last_updated)
     VALUES (?, ?, ?, 'MTG', '[]', '[]', 'Rare', ?, ?, ?, '', 'Artifact', 1, '[]', ?, ?, CURRENT_TIMESTAMP)`,
    [id, oracle_id, name, set_id, set_name, number,
     JSON.stringify({ commander: 'legal' }), JSON.stringify(finishes || ['nonfoil'])]
  );
  await db.run(`INSERT OR REPLACE INTO sets (id, name, release_date) VALUES (?, ?, '2021-01-01')`,
    [set_id, set_name]);
}

async function main() {
  await db.initDb();
  const user = await createUser('ocrrouteuser');

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  // Routers mount at BARE /api in this app.
  app.use('/api', collectionRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const post = (p, body) => fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
    body: JSON.stringify(body),
  });

  const cards = await stagedCards();

  // --- FOCR-TC1: the route reads the collector number off a staged photo -----
  //
  // THE REGRESSION GATE. Against the broken route this was 0/4 with fabricated
  // reads; it must be 4/4 with zero fabrications.
  {
    let correct = 0;
    const fabricated = [];
    const latencies = [];
    for (const c of cards) {
      const res = await post('/api/scan-match', {
        image: `data:image/jpeg;base64,${c.jpeg.toString('base64')}`,
        ocr: true,
      });
      assert.strictEqual(res.status, 200, `scan-match failed for ${c.name}`);
      const body = await res.json();
      assert.ok(body.ocr, 'ocr:true must produce an ocr block on the response');
      latencies.push(body.ocr.ms);
      if (body.ocr.number === c.number) correct++;
      else if (body.ocr.number) {
        fabricated.push(`${c.name}: read "${body.ocr.number}", is #${c.number} (raw ${JSON.stringify(body.ocr.raw)})`);
      }
      console.log(`  ${c.name.padEnd(26)} want=${c.number.padEnd(4)} got=${String(body.ocr.number).padEnd(6)} confident=${body.ocr.confident} ${body.ocr.ms}ms`);
    }

    // A FABRICATED read is the dangerous failure, not a missed one: a wrong
    // number silently records a printing Zach does not own, and the review queue
    // cannot catch it because OCR never admits doubt. A missed read just queues.
    assert.strictEqual(fabricated.length, 0,
      `OCR fabricated ${fabricated.length} confident-but-wrong number(s):\n  ${fabricated.join('\n  ')}`);
    assert.strictEqual(correct, cards.length,
      `expected ${cards.length}/${cards.length} correct through the real route, got ${correct}`);
    console.log(`  OCR latency through the route: ${latencies.join(', ')}ms`);
    pass('FOCR-TC1', `the real route reads ${correct}/${cards.length} collector numbers with 0 fabrications`);
  }

  // --- FOCR-TC1B: the DISCRIMINATING case — card small in frame and softened --
  //
  // THIS IS THE ONE THAT FAILS ON THE OLD CODE. TC1 above passes either way on
  // this fixture, so on its own it would be the same kind of false comfort that
  // shipped this bug twice. Verified by reverting the route to
  // `preprocessCard(buf)`: TC1 still passed, TC1B failed with two confident
  // fabrications ("26" for Sol Ring #263, "160" for Llanowar Elves #168). Both
  // would have silently recorded a printing Zach does not own.
  //
  // WHAT IT DOES AND DOES NOT MODEL. The staged photo here is ~2400px wide. The
  // CLIENT CURRENTLY CAPS UPLOADS AT 1280px (CameraScanner SCAN_UPLOAD_W), so
  // this case proves the SERVER mechanism — the fix is real and this is a valid
  // regression gate for it — while running above the resolution the app actually
  // sends today.
  //
  // That gap is deliberate and documented rather than hidden, because it is the
  // real remaining limit: measured, the fix only outperforms the old path once
  // the CARD ITSELF is wider than ~500px in the uploaded image. Below that the
  // matcher's 500x700 warp is already an upscale and there is no extra detail to
  // recover, so at upload=1280 with a distant card (~404px of card) OLD and NEW
  // score identically. Raising SCAN_UPLOAD_W is what would convert this server
  // fix into headroom for distant cards; it is not done here because it is a
  // client change that needs measuring on Zach's phone for latency and memory.
  {
    const { CARDS, fetchArt, stagePhoto } = require('../helpers/stagedCardPhoto');
    const sharp = require('sharp');

    let correct = 0;
    const fabricated = [];
    for (const c of CARDS) {
      const staged = await stagePhoto(await fetchArt(c), { scale: 0.32 });
      // Lens softness. Real optics always have some; a composited scene has none,
      // and without it this fixture is sharper than any photograph.
      const jpeg = await sharp(staged).blur(1.6).jpeg({ quality: 88 }).toBuffer();

      const res = await post('/api/scan-match', {
        image: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        ocr: true,
      });
      assert.strictEqual(res.status, 200, `scan-match failed for distant ${c.name}`);
      const body = await res.json();
      if (body.ocr.number === c.number) correct++;
      // A WRONG NUMBER ONLY COUNTS AS A FABRICATION IF IT WAS CONFIDENT.
      //
      // This assertion's own message has always said "confident-but-wrong",
      // because that is the failure that matters: nothing downstream adds a card
      // on an unconfident read, so it degrades to the review queue — which is
      // exactly what the queue is for. A wrong number that ANNOUNCES it is
      // unreliable is a handled case, not a fabrication.
      //
      // The distinction became load-bearing when the strip window was widened to
      // catch the collector line on more cards (0.900/0.090, 17/20 on Zach's real
      // scans against 12/20 before). The cost of a taller window is that on a
      // distant card it sometimes catches the strip PARTIALLY: Sol Ring #263
      // reads as "26} \" — a clipped last digit with the sliced glyph misread as
      // punctuation. "26" is a real collector number, so no downstream check can
      // tell it is wrong.
      //
      // parseCollectorStrip now detects that shape — digits glued to
      // non-alphanumeric debris — and refuses to mark it confident. The number is
      // still reported because it is real information, but nothing acts on it
      // alone. Asserting on confident-and-wrong is what this case was always
      // describing.
      else if (body.ocr.number && body.ocr.confident) {
        fabricated.push(`${c.name}: read "${body.ocr.number}", is #${c.number} (confident=${body.ocr.confident}, raw ${JSON.stringify(body.ocr.raw)})`);
      }
      console.log(`  [distant] ${c.name.padEnd(26)} want=${c.number.padEnd(4)} got=${String(body.ocr.number).padEnd(6)} confident=${body.ocr.confident}`);
    }

    assert.strictEqual(fabricated.length, 0,
      `a distant card produced ${fabricated.length} confident-but-wrong number(s) — this is the production failure:\n  ${fabricated.join('\n  ')}`);
    assert.strictEqual(correct, CARDS.length,
      `expected ${CARDS.length}/${CARDS.length} on the distant/softened case (the old path scored 2/4 with 2 fabrications), got ${correct}`);
    pass('FOCR-TC1B', 'a card small in frame and softened reads correctly instead of fabricating');
  }

  // --- FOCR-TC2: the internal detection geometry is NOT leaked to clients ----
  //
  // rectifyCard needs the matcher's quad, so match() now returns it. It is in an
  // internal coordinate space; shipping it would invite a client to depend on
  // something we resize freely.
  {
    const res = await post('/api/scan-match', {
      image: `data:image/jpeg;base64,${cards[0].jpeg.toString('base64')}`,
      ocr: true,
    });
    const body = await res.json();
    assert.strictEqual(body.detection, undefined,
      'internal detection geometry must not be part of the API response');
    pass('FOCR-TC2', 'the internal detection geometry stays server-side');
  }

  // --- FOCR-TC3: no OCR requested means no OCR cost and no ocr block ---------
  {
    const res = await post('/api/scan-match', {
      image: `data:image/jpeg;base64,${cards[0].jpeg.toString('base64')}`,
    });
    const body = await res.json();
    assert.strictEqual(body.ocr, undefined,
      'OCR is opt-in; a client that does not ask must not pay for it');
    pass('FOCR-TC3', 'scan-match without ocr:true returns no ocr block');
  }

  // --- FOCR-TC4: a confident single-printing read is ADDED, not QUEUED -------
  //
  // THE SECOND HALF OF THE BUG. With OCR returning nothing, every scanned card
  // fell through to the review queue and Zach got an unusable pile after a
  // handful of scans. This path — read the number, resolve it to exactly one
  // printing, put it in the collection without asking — had NEVER once run end
  // to end with a working read.
  //
  // It is driven by the number the ROUTE actually produced above, not by a
  // hand-written string, so it cannot pass while OCR is broken.
  {
    const c = cards[0]; // Sol Ring, c21 #263
    await seedPrinting({
      id: 'ocr-solring-c21', oracle_id: 'ocr-o-solring', name: c.name,
      set_id: c.set, set_name: 'Commander 2021', number: c.number,
      finishes: ['nonfoil', 'foil'],
    });

    const matchRes = await post('/api/scan-match', {
      image: `data:image/jpeg;base64,${c.jpeg.toString('base64')}`,
      ocr: true,
    });
    const matched = await matchRes.json();
    assert.strictEqual(matched.ocr.number, c.number,
      'this case is meaningless unless the route actually read the number');

    const before = (await db.get(`SELECT COUNT(*) n FROM collection WHERE user_id = ?`, [user.id])).n;
    const queuedBefore = (await db.get(`SELECT COUNT(*) n FROM scan_review_queue WHERE user_id = ?`, [user.id])).n;

    // Exactly what the scanner sends: the name it matched plus the RAW text the
    // route read. Nothing is hand-corrected in between.
    const resolveRes = await post('/api/scan-resolve', {
      name: c.name,
      ocr_text: matched.ocr.raw,
      quantity: 1,
    });
    assert.strictEqual(resolveRes.status, 200, 'scan-resolve must succeed');
    const outcome = await resolveRes.json();

    assert.strictEqual(outcome.action, 'added',
      `a confident read resolving to exactly one printing must be ADDED, not queued. got ${JSON.stringify(outcome)}`);
    assert.strictEqual(outcome.card.number, c.number, 'and it must be the printing that was read');
    assert.strictEqual(
      (await db.get(`SELECT COUNT(*) n FROM collection WHERE user_id = ?`, [user.id])).n,
      before + 1, 'the card must really be in the collection');
    assert.strictEqual(
      (await db.get(`SELECT COUNT(*) n FROM scan_review_queue WHERE user_id = ?`, [user.id])).n,
      queuedBefore, 'and NOTHING may have been added to the review queue');
    pass('FOCR-TC4', 'a confident single-printing read from the real route is added, not queued');
  }

  // --- FOCR-TC5: an unreadable image still queues rather than inventing ------
  //
  // The safety half of the same property. Given a picture with no card in it,
  // the route must produce NO number. Degrading to the queue is correct; a
  // confident number off the background would be the worst possible outcome.
  {
    const sharp = require('sharp');
    const blank = await sharp({
      create: { width: 1200, height: 1600, channels: 3, background: { r: 230, g: 230, b: 230 } },
    }).jpeg().toBuffer();

    const res = await post('/api/scan-match', {
      image: `data:image/jpeg;base64,${blank.toString('base64')}`,
      ocr: true,
    });
    assert.strictEqual(res.status, 200, 'a cardless photo is a normal outcome, not an error');
    const body = await res.json();
    assert.strictEqual(body.ocr.number, null,
      `no card means no number; got "${body.ocr.number}" from raw ${JSON.stringify(body.ocr.raw)}`);
    assert.strictEqual(body.ocr.confident, false, 'and it must not claim confidence');
    pass('FOCR-TC5', 'a cardless photo yields no number instead of a fabricated one');
  }

  console.log(`\nocr_route.test.js: ${passed} cases passed`);
}

main()
  .then(async () => {
    await collectorNumberOcr.shutdown();
    if (server) server.close();
    await db.close?.();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('FAIL: FOCR-TC0', err);
    await collectorNumberOcr.shutdown();
    if (server) server.close();
    process.exit(1);
  });
