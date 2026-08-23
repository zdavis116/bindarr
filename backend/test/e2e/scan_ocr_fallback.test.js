// THE OCR FALLBACK: when the matcher finds nothing but the card's printed
// catalogue address was read cleanly, use it.
//
// Zach: "If we have both set and number we should just use OCR as the fallback."
//
// FROM REAL PRODUCTION DATA. Queue entries 113 and 114 on the dev box:
//   matched_name : ''                              (the matcher found nothing)
//   ocr_number   : '295'   ocr_set : 'msh'
//   ocr_raw      : 'L 0295 / MSH * EN % DOMENICO CAVA'
// A clean, complete, correct read of the collector strip. We knew exactly which
// printing it was and it queued anyway, because add-or-queue was driven
// entirely by the art matcher.
//
// Exercised THROUGH THE REAL ROUTE with a real express app and a real database,
// because a test that called the resolver directly would pass on code that is
// broken through the route — this repo has been bitten by that twice.
const assert = require('assert');
const express = require('express');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `bindarr-ocrfb-${process.pid}.db`);
process.env.DB_PATH = dbPath;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-only-password';

const db = require('../../src/db');
const collectionRoutes = require('../../src/routes/collection');

let server, base, token, passed = 0;
function pass(id, msg) { passed++; console.log(`PASS: ${id} - ${msg}`); }

async function api(pathname, body) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}

async function main() {
  await db.initDb();
  const u = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?,?,'member',?)`,
    ['ocrfb', db.hashPassword('test-only-password'), `share-ocrfb-${process.pid}`]);
  token = `ocrfb-${process.pid}`;
  await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)`,
    [token, u.lastID, new Date(Date.now() + 600000).toISOString()]);

  // The real card from entry 113/114, plus a decoy sharing its number in
  // another set — so a set-blind number lookup would pick the wrong one.
  await db.run(
    `INSERT INTO card_cache (id, oracle_id, name, set_id, number)
     VALUES (?,?,?,?,?), (?,?,?,?,?), (?,?,?,?,?)`,
    ['msh-295', 'o-swamp-msh', 'Swamp', 'msh', '295',
     'dmu-295', 'o-swamp-dmu', 'Swamp', 'dmu', '295',
     'tla-090', 'o-crawler', 'Canyon Crawler', 'tla', '90']);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', collectionRoutes);
  server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  // --- FOF-TC1: THE PRODUCTION CASE -------------------------------------
  //
  // Matcher found nothing; OCR read the strip perfectly. Before this change
  // that queued with reason 'unreadable' and zero candidates.
  {
    const r = await api('/api/scan-resolve', {
      name: '',                                   // matcher returned nothing
      ocr_text: 'L 0295\nMSH \u2022 EN % DOMENICO CAVA',
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.action, 'added',
      `a clean set+number read must identify the card, got '${r.body.action}'`);
    assert.strictEqual(r.body.card.id, 'msh-295',
      'and it must be the MSH printing, not the DMU one sharing that number');
    pass('FOF-TC1', 'a clean set+number read adds the card when the matcher found nothing');
  }

  // --- FOF-TC2: THE SET CODE IS LOAD-BEARING ------------------------------
  //
  // Two sets print a #295 Swamp. A number-only read must NOT pick one: that is
  // exactly the silent wrong-printing Zach cannot reconcile against a physical
  // shoebox.
  {
    const r = await api('/api/scan-resolve', {
      name: '',
      ocr_text: '0295',                           // number, no set code
    });
    assert.strictEqual(r.body.action, 'queued',
      'a number with no set code must NEVER be resolved to a printing');
    pass('FOF-TC2', 'a number without a set code queues instead of guessing');
  }

  // --- FOF-TC3: AN ADDRESS THAT MATCHES NOTHING STILL QUEUES ---------------
  //
  // A misread strip must degrade to "ask Zach", never to a wrong add.
  {
    const r = await api('/api/scan-resolve', {
      name: '',
      ocr_text: 'L 0999\nZZZ \u2022 EN',
    });
    assert.strictEqual(r.body.action, 'queued',
      'a set+number that matches no catalogue row must queue');
    pass('FOF-TC3', 'an unmatched set+number queues rather than inventing a card');
  }

  // --- FOF-TC4: THE FALLBACK IS A FALLBACK, NOT AN OVERRIDE ----------------
  //
  // When the matcher DOES identify the card, the existing path decides. 100% of
  // clean-image identification depends on that route.
  //
  // REVISED FOR THE DISAGREEMENT RULE. This case originally sent a matcher hit
  // for Canyon Crawler alongside a strip reading 'MSH 0295' — a DIFFERENT real
  // card — and asserted 'added', because at the time the strip could not
  // contradict the matcher at all.
  //
  // That is exactly the bug Zach hit: he scanned H.E.R.B.I.E. Scout Unit
  // (msh #247) and the app staged Jeskai Windscout (ktk #44). Two blue fliers,
  // the strip said msh, nothing compared them, and the wrong card entered
  // staging looking as clean as the right ones. His rule: "it should flag with
  // the option to chose the set+number."
  //
  // So a strip pointing at a different real card must now QUEUE with both
  // readings, and that is asserted in FOF-TC5. What this case still protects is
  // the property in its title: OCR does not override a successful match. Here
  // the strip AGREES with the matcher, and agreement must add without asking.
  {
    const r = await api('/api/scan-resolve', {
      name: 'Canyon Crawler',                     // matcher worked
      ocr_text: 'L 0090\nTLA \u2022 EN',           // and the strip says the same card
    });
    assert.strictEqual(r.body.action, 'added', JSON.stringify(r.body));
    assert.strictEqual(r.body.card.id, 'tla-090',
      'when the strip agrees with the matcher, the card is added without asking');
    pass('FOF-TC4', 'a strip that agrees with the match adds without a prompt');
  }

  // --- FOF-TC5: A DISAGREEMENT IS FLAGGED, NOT DECIDED --------------------
  //
  // THE H.E.R.B.I.E. CASE. The art matched one card; the printed collector strip
  // resolves to a different REAL one. Neither silently wins:
  //
  //   - overriding would swap one card for another with no visible trace, and a
  //     silent swap cannot be reconciled against a physical stack.
  //   - ignoring the strip is what put the wrong card in staging.
  //
  // Both go in front of Zach, strip answer first, and he picks in one tap.
  {
    const r = await api('/api/scan-resolve', {
      name: 'Canyon Crawler',                     // the art says this
      ocr_text: 'L 0295\nMSH \u2022 EN',           // the CARD says this
    });
    assert.strictEqual(r.body.action, 'queued',
      `a strip pointing at a different real card must not add silently: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.reason, 'disagreement');
    const ids = (r.body.candidates || []).map(c => c.id);
    assert.strictEqual(ids[0], 'msh-295',
      'the strip’s answer is offered FIRST — the card stating its own catalogue address');
    assert.ok(ids.includes('tla-090'),
      'and the art match is still offered, so he can choose it');
    pass('FOF-TC5', 'art vs printed number disagreement queues with both, strip first');
  }

  console.log(`\nscan_ocr_fallback.test.js: ${passed} cases passed`);
  server.close();
  process.exit(0);
}

main().catch(e => { console.error('FAIL:', e.message); if (server) server.close(); process.exit(1); });
