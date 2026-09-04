const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const mox = require('../utils/moxfieldApi');
const { planSync, applySync } = require('../utils/moxfieldSync');


// Moxfield sends lowercase format strings ('commander'); Bindarr stores them
// capitalised, matching what NewDeckModal writes.
function normaliseFormat(raw) {
  const f = String(raw || '').trim().toLowerCase();
  if (!f) return 'Standard';
  return f.charAt(0).toUpperCase() + f.slice(1);
}

// A commander deck is 100 cards including the commander. Derived from the
// format rather than counted from the payload, which changes as he edits.
function targetSizeFor(format) {
  return String(format).toLowerCase() === 'commander' ? 100 : 60;
}

const router = express.Router();
router.use(authenticateToken);

// MOXFIELD SYNC.
//
// Zach builds decks in Moxfield and wants Bindarr to follow them, so he can see
// what he owns versus what he needs to buy.
//
// Two owners, two levels:
//   MOXFIELD owns which cards are in the deck.
//   BINDARR  owns which printing each row asks for.
//
// A deck with moxfield_public_id IS NULL was built locally and is never touched.

// Which Moxfield account we mirror.
router.get('/moxfield/account', async (req, res) => {
  try {
    const acct = await db.get(
      `SELECT id, username, display_name, last_checked_at, last_error
         FROM moxfield_accounts WHERE user_id = ?`, [req.user.id]);
    res.json({ account: acct || null });
  } catch (err) {
    res.status(500).json({ error: 'Could not read the Moxfield account', message: err.message });
  }
});

// Link an account. Verifies the user exists before storing it, so a typo fails
// here rather than silently syncing nothing forever.
router.post('/moxfield/account', async (req, res) => {
  const username = String((req.body || {}).username || '').trim();
  if (!username) return res.status(400).json({ error: 'A Moxfield username is required' });
  try {
    const user = await mox.getUser(username);
    await db.run(
      `INSERT INTO moxfield_accounts (user_id, username, display_name)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, username) DO UPDATE SET display_name = excluded.display_name`,
      [req.user.id, user.userName, user.displayName]);
    res.json({ account: user });
  } catch (err) {
    // A 403 is Cloudflare, not a bad username. Saying which is which matters:
    // they call for opposite reactions.
    const status = err.status === 403 ? 503 : (err.status === 404 ? 404 : 500);
    res.status(status).json({ error: err.message });
  }
});

router.delete('/moxfield/account', async (req, res) => {
  try {
    await db.run(`DELETE FROM moxfield_accounts WHERE user_id = ?`, [req.user.id]);
    // Deliberately NOT clearing moxfield_public_id on decks: unlinking the
    // account should not silently orphan decks he may want to relink.
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not unlink', message: err.message });
  }
});

// The author's public decks, with which are already mirrored here.
router.get('/moxfield/decks', async (req, res) => {
  try {
    const acct = await db.get(
      `SELECT username FROM moxfield_accounts WHERE user_id = ?`, [req.user.id]);
    if (!acct) return res.status(400).json({ error: 'No Moxfield account linked' });

    const summaries = await mox.getAuthorDeckSummaries(acct.username);
    const linked = await db.all(
      `SELECT id, name, moxfield_public_id, moxfield_updated_at, moxfield_synced_at
         FROM decks WHERE user_id = ? AND moxfield_public_id IS NOT NULL`, [req.user.id]);
    const byPublicId = new Map(linked.map(d => [d.moxfield_public_id, d]));

    res.json({
      account: acct.username,
      decks: summaries.map(s => {
        const local = byPublicId.get(s.publicId);
        return {
          public_id: s.publicId,
          name: s.name,
          format: s.format,
          last_updated_at: s.lastUpdatedAtUtc,
          bindarr_deck_id: local ? local.id : null,
          bindarr_deck_name: local ? local.name : null,
          // Cheap change detection: compare Moxfield's stamp with the one we
          // stored at the last sync, no full fetch required.
          changed: Boolean(local && local.moxfield_updated_at !== s.lastUpdatedAtUtc),
          last_synced_at: local ? local.moxfield_synced_at : null
        };
      })
    });
  } catch (err) {
    const status = err.status === 403 ? 503 : 500;
    res.status(status).json({ error: err.message });
  }
});

// PREVIEW. Changes nothing.
router.get('/moxfield/decks/:publicId/plan', async (req, res) => {
  try {
    const deck = await db.get(
      `SELECT id FROM decks WHERE user_id = ? AND moxfield_public_id = ?`,
      [req.user.id, req.params.publicId]);
    const payload = await mox.getDeckDetails(req.params.publicId);
    const plan = await planSync(req.user.id, deck ? deck.id : -1, payload);
    res.json({ bindarr_deck_id: deck ? deck.id : null, ...plan });
  } catch (err) {
    const status = err.status === 403 ? 503 : (err.status === 404 ? 404 : 500);
    res.status(status).json({ error: err.message });
  }
});

// APPLY. Creates the local deck on first sync, then reconciles.
router.post('/moxfield/decks/:publicId/sync', async (req, res) => {
  try {
    const payload = await mox.getDeckDetails(req.params.publicId);

    let deck = await db.get(
      `SELECT id FROM decks WHERE user_id = ? AND moxfield_public_id = ?`,
      [req.user.id, req.params.publicId]);

    let created = false;
    if (!deck) {
      // FORMAT AND SIZE COME FROM MOXFIELD.
      //
      // Inserting only (user_id, name, moxfield_public_id) left format and
      // target_size on their column defaults -- 'Standard' and 60 -- so a
      // commander deck read "100 out of 60 cards".
      const format = normaliseFormat(payload.format);
      const r = await db.run(
        `INSERT INTO decks (user_id, name, moxfield_public_id, format, target_size)
         VALUES (?, ?, ?, ?, ?)`,
        [req.user.id, payload.name || 'Untitled', req.params.publicId,
         format, targetSizeFor(format)]);
      deck = { id: r.lastID };
      created = true;
    }

    const plan = await planSync(req.user.id, deck.id, payload);
    const applied = await applySync(req.user.id, deck.id, plan);

    // Record what this sync reconciled against. Without it, every surface that
    // asks "has Moxfield moved since?" compares against null forever.
    const stamp = plan.deck.last_updated_at || null;
    await db.run(
      `UPDATE decks SET moxfield_updated_at = ?, moxfield_synced_at = ? WHERE id = ?`,
      [stamp, stamp, deck.id]);

    res.json({ bindarr_deck_id: deck.id, created, ...applied, skipped: plan.skipped });
  } catch (err) {
    const status = err.status === 403 ? 503 : (err.status === 404 ? 404 : 500);
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
