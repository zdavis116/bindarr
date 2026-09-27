// Card-scan routes, ported 1:1 from scrybox (backend/src/routes/cardscan.js).
//
// WHY THIS FILE EXISTS AT ALL -- the bug that made it necessary:
//
// frontend/src/utils/clientScan.js was ported byte-identical from upstream,
// and its hydrateResults() POSTs the proven Scryfall ids to
// /api/cardscan/cards to turn them into real card rows. That route was never
// ported. So every on-device read ended in `hydrate failed`, deviceCard came
// back null, and EVERY SCAN silently fell through to the old server path --
// including the per-card dedupe window, which lives inside the on-device
// branch and therefore never ran once.
//
// Zach saw the consequence directly: "Look at my staged area there is still a
// ton of duplicates. It's not doing any duplicate blocking or anything." The
// duplicate blocking was fine. It was unreachable.
//
// The lesson worth keeping: porting a client without its server is not a
// partial port, it is a broken one, and it fails silently because the client
// has a fallback.
const express = require('express');
const scryfallApi = require('../scryfallApi');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// AUTHED, like every other data route in this app. Upstream's copy is not,
// because its scanner sits behind a different session model -- this is the one
// deliberate deviation in the file, and it is a deviation toward OUR security
// posture rather than away from it. Without it, /api/cardscan/cards would be
// an unauthenticated card-catalogue lookup on a box reachable over Tailscale.
router.use(authenticateToken);

// Turn one pipeline result into the row shape the scanner tray renders.
// Transcribed from upstream's hydrate(); the only difference is that our
// scryfallApi.getCardById already takes the `mtg-` prefix, which upstream's
// does too, so the call is unchanged.
async function hydrate(result) {
  const out = {
    number: result.scene_number,
    ok: !!result.ok,
    error: result.ok ? undefined : result.error,
    title: result.title || result.identified?.name || null,
    via: result.footer_ocr?.resolved_by || result.identified?.via || null,
  };
  const sid = result.ok && result.card?.id;
  if (sid) {
    const card = await scryfallApi.getCardById(`mtg-${sid}`).catch(() => null);
    if (card) out.card = card;
    // A printing the reader proved but the catalogue does not know about is
    // not an answer the tray can use. Saying so lets the client fall back to
    // the server path instead of staging a row with nothing in it.
    else { out.ok = false; out.error = 'printing not in the card database yet'; }
  }
  return out;
}

// POST /api/cardscan/cards
//
// The on-device reader has already PROVEN these ids by reading the title and
// the collector footer. This endpoint does not identify anything -- it maps a
// proven id to a catalogue row. That is why it is cheap and why it is safe to
// call on every successful scan.
router.post('/cards', async (req, res) => {
  const items = req.body?.results;
  if (!Array.isArray(items) || items.length < 1 || items.length > 8) {
    return res.status(400).json({ ok: false, error: 'Expected 1-8 results' });
  }
  // Validate the id SHAPE before touching the database. These ids come from a
  // model running on the user's phone, and a malformed one should be a 400
  // rather than a lookup.
  const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (items.some(x => !x || !ID.test(String(x.scryfallId || '')))) {
    return res.status(400).json({ ok: false, error: 'Invalid card id' });
  }
  const results = await Promise.all(items.map(x => hydrate({
    ok: true,
    scene_number: x.number,
    title: x.title,
    card: { id: x.scryfallId },
    footer_ocr: { resolved_by: x.via },
  })));
  res.json({ ok: true, results });
});

module.exports = router;
