// POST /api/cardscan/frame -- the server fallback, in the shape the scan loop
// expects.
//
// THIS REPLACES A CONTAINER WE DO NOT HAVE. Upstream's route of the same name
// proxies a JPEG to a separate OCR service (cardscan:8321) whose source is not
// in the scrybox repo and is not published. The scan loop's contract is what
// matters, not who fulfils it:
//
//     JPEG in  ->  { ok, frame, candidates[], results[] }
//
// cvScan (cornelius + milo) answers exactly that question locally, so it is
// wired in here and the loop above it is untouched. Verified on this box
// already: 109,711-card catalogue, ~1.0s a frame, and it independently agreed
// with the on-device reader on the frame the corpus had mislabelled.
//
// WHAT THE LOOP NEEDS FROM EACH FIELD, because getting these wrong is silent:
//   frame       {width,height} -- serverAllowed() measures "same place" against
//                                 the frame diagonal, so a missing frame makes
//                                 the backoff meaningless rather than noisy.
//   candidates  [{number, box, eligible, status}] -- drives the hint text and
//                                 the "is this the same card" comparison.
//   results     [{ok, card, title, number}] -- ok+card is what gets staged.
const express = require('express');
const cvScan = require('../cvScan');
const scryfallApi = require('../scryfallApi');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

// A proven Scryfall id -> a catalogue row. Shared by /cards and /frame.
//
// NO `mtg-` PREFIX: our card_cache stores bare uuids, and getCardById()
// queries the cache with the string it is handed. Passing `mtg-<uuid>` would
// miss the cache on EVERY lookup and fall through to the Scryfall API --
// slow, rate-limited, and broken offline. Verified against the live database
// (106,443 rows, ids like `0000419b-0bba-4488-8f7a-6194544ce91e`).
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
    const card = await scryfallApi.getCardById(sid).catch(() => null);
    if (card) out.card = card;
    else { out.ok = false; out.error = 'printing not in the card database yet'; }
  }
  return out;
}

// POST /api/cardscan/cards
//
// The reader has already PROVEN these ids by reading title + collector footer.
// This maps them to rows; it does not identify anything.
router.post('/cards', async (req, res) => {
  const items = req.body?.results;
  if (!Array.isArray(items) || items.length < 1 || items.length > 8) {
    return res.status(400).json({ ok: false, error: 'Expected 1-8 results' });
  }
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

// The cosine gate. cvScan reports `verified: false` because no geometric
// verification runs, which routes the answer to this threshold rather than an
// inlier count. 0.55 is the value the existing client used for the same
// embedding, kept rather than re-derived.
const SCORE_MIN = 0.55;

// POST /api/cardscan/frame
router.post('/frame',
  express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '15mb' }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) {
      return res.status(400).json({ ok: false, error: 'Missing image' });
    }
    try {
      const out = await cvScan.match(req.body, 'mtg', 8, {});
      const top = out.candidates?.[0] || null;

      // A frame the catalogue cannot place is a REFUSAL, not a guess. cvScan
      // flags notInCatalog when the top hit does not sit far enough above its
      // neighbours -- exactly the case where picking the best score would
      // stage the wrong printing.
      const good = top && !out.notInCatalog && top.score >= SCORE_MIN;

      // The card's bounding box in the frame's own pixels, derived from
      // cornelius's four corners. serverAllowed() normalises the box centre
      // against the frame diagonal to decide "same card, same place", so BOTH
      // of these must be real numbers or the backoff silently compares
      // nothing and never engages.
      const corners = out.corners || null;
      const frame = out.frameSize || { width: null, height: null };
      let box = null;
      if (Array.isArray(corners) && corners.length >= 4) {
        const xs = corners.map(p => p.x);
        const ys = corners.map(p => p.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        box = [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
      }

      const results = [];
      if (good) {
        const id = String(top.cardId).replace(/^mtg-/, '');
        const row = await hydrate({
          ok: true, scene_number: 0, title: null,
          card: { id }, footer_ocr: { resolved_by: 'cv' },
        });
        results.push(row);
      } else {
        // Carry the reason through: the loop turns a status into the hint the
        // user sees, and "no card" must be distinguishable from "a card I
        // could not place".
        results.push({
          number: 0, ok: false,
          error: top ? 'not confidently in the catalogue' : 'no card found',
          title: null, via: 'cv',
        });
      }

      res.json({
        ok: true,
        frame,
        candidates: [{
          number: 0,
          box,
          quad: null,
          eligible: !!top,
          status: top ? (good ? 'ok' : 'unresolved') : 'no card',
        }],
        results,
        timings: {},
      });
    } catch (e) {
      console.error('[cardscan/frame]', e);
      res.status(500).json({ ok: false, error: e.message || 'scan failed' });
    }
  });

// POST /api/cardscan/status -- is the local fallback usable at all?
router.get('/status', async (req, res) => {
  try {
    res.json({ ok: true, ready: cvScan.isBuilt('mtg', 'en') });
  } catch {
    res.json({ ok: false, ready: false });
  }
});

module.exports = router;
