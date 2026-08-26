const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
const db = require('../db');
const scryfallApi = require('../scryfallApi');
const scanMatch = require('../scanMatch');
const setIndex = require('../setIndex');

const { authenticateToken, searchLimiter } = require('../middleware/auth');
const { resolveCardPrice, parseCardRow, recordPrice } = require('../utils/priceHelpers');
const { parseSetList } = require('../utils/setQuery');
const { compartmentLabel, isBinderType, rebalanceCompartmentByScheme } = require('../utils/compartmentSort');
const { checkedOutAllocation, inDeckQuantities, resolveCompartmentAndPosition, describePlacement } = require('../utils/collectionHelpers');
const { splitPrice } = require('../utils/splitPrice');
const commanderRules = require('../utils/commanderRules');
const { FinishError, finishColumnsFromBody } = require('../utils/finishes');
const { resolveScannedPrinting, WEAK_MATCH_INLIERS } = require('../utils/scanPrintingResolver');
const collectorNumberOcr = require('../utils/collectorNumberOcr');
const cardTitleOcr = require('../utils/cardTitleOcr');
const rgbArtMatch = require('../rgbArtMatch');
const scanProfile = require('../scanProfile');
const { parseCollectorStrip } = require('../utils/collectorNumberParse');
const {
  InvariantError,
  requireOwnedCompartment,
  requireOwnedLocation,
  assertCapacityFor
} = require('../utils/storageInvariants');
const {
  RequestBoundsError,
  positiveInteger,
  requireArray,
  uniqueIntegerIds,
  boundedProduct
} = require('../utils/requestBounds');

const router = express.Router();

router.use(authenticateToken);

// Stamp each result with how many copies the user already owns, so browsing a
// set shows what is already in the binder instead of inviting duplicate adds.
// A collection-scope search already reports owned_qty from its own join.
//
// PR 6G: also stamps `in_deck_qty` -- how many copies are committed to decks
// ACROSS ALL DECKS. That figure used to be computed client-side from whichever
// deck happened to be open, so the same card read "In Deck: 1" in one deck and
// "In Deck: 0" in another, telling the user a card was free when it was already
// sleeved elsewhere. It is computed here, on the server, for the same reason
// availability is: it is a fact about the WHOLE collection, and no single
// screen has the information to derive it.
//
// `owned_qty - in_deck_qty` is therefore the number genuinely free, and it is
// stamped as `available_qty` so no caller has to do that subtraction itself.
//
// PR 6G item 3 (Zach, 2026-08-18): "searching when inside the deck would allow
// you to search on cards you own/dont own and that is where show available
// count becomes nice in that because you can see if you even have it and then
// even farther it marks it as missing".
//
// So the SEARCH ITSELF must answer "do I even have this, and is it free?" --
// otherwise the user finds the card and then has to go and look it up a second
// time somewhere else. AVAILABLE MEANS GENUINELY FREE: owned minus committed
// across ALL decks, the same figure the In Deck fix in this PR establishes.
// Owned-minus-this-deck would be the false-availability bug in a new costume.
//
// It is stamped here rather than derived on the client for the reason the whole
// PR turns on: the client only ever holds ONE deck, so it cannot subtract the
// commitments it cannot see. An explicit 0 rather than an absent field, so an
// unowned card reads as a confident "none" instead of a blank the UI would have
// to guess about.
async function attachOwnedQty(cards, userId) {
  if (!Array.isArray(cards) || cards.length === 0 || !userId) return;
  const ids = cards.map(c => c.id).filter(Boolean);
  if (ids.length === 0) return;
  const rows = await db.all(
    `SELECT card_id, SUM(quantity) AS qty FROM collection
     WHERE user_id = ? AND list_type = 'collection' AND card_id IN (${ids.map(() => '?').join(',')})
     GROUP BY card_id`,
    [userId, ...ids]
  );
  const owned = new Map(rows.map(r => [r.card_id, r.qty]));

  // Keyed on (card_id, finish) because that is the app's deck identity. A
  // search row that does not state a finish (a name-scoped catalogue result)
  // has no single variant to report, so it sums every finish of the printing --
  // which is the honest answer to "is this card spoken for", the question the
  // user is actually asking when looking at such a row.
  const inDeck = await inDeckQuantities(userId);
  for (const c of cards) {
    c.owned_qty = owned.get(c.id) || 0;
    if (c.finish) {
      c.in_deck_qty = inDeck.get(`${c.id}|${c.finish}`) || 0;
    } else {
      let total = 0;
      for (const [key, qty] of inDeck) {
        if (key.slice(0, key.lastIndexOf('|')) === c.id) total += qty;
      }
      c.in_deck_qty = total;
    }
    // Clamped at zero. A negative would only be possible if commitments
    // outran ownership (a card sold while still required by a deck), and
    // "-1 free" is not a thing a user can act on; "0 free, and the deck says
    // missing" is.
    c.available_qty = Math.max(0, c.owned_qty - c.in_deck_qty);
  }
}

// PR 6I item 3: put the printings the user OWNS at the top of a catalogue
// search.
//
// TWO PLACES RANK, AND BOTH ARE NEEDED — they fix different halves of the same
// problem, and neither is redundant:
//
//   * scryfallApi.queryLocal() ranks IN SQL, before LIMIT/OFFSET. That is what
//     decides WHICH rows land on page 1 out of ~104k. No amount of sorting here
//     could rescue an owned printing sitting on page 5.
//   * this sorts the page that is about to be sent. It covers the results that
//     came from SCRYFALL rather than the local table, which never passed
//     through that SQL at all, so without it a cache-miss search would still
//     bury an owned printing.
//
// It reads the SAME fields the row displays (owned_qty / available_qty, just
// stamped by attachOwnedQty) rather than re-deriving ownership, so the order
// and the badge cannot disagree. That is the standing rule in this codebase:
// one implementation of a fact, not two.
//
// STABLE, and deliberately so. Ties keep whatever order the caller produced —
// Scryfall relevance, exact-match-first, collector number — so this ADDS a
// leading band and changes nothing else about the ordering.
function ownedBand(card) {
  if ((card.available_qty ?? 0) > 0) return 0;   // owned and free
  if ((card.owned_qty ?? 0) > 0) return 1;       // owned but fully committed
  return 2;                                       // not owned
}

function sortOwnedFirst(cards) {
  if (!Array.isArray(cards)) return cards;
  // Array.prototype.sort is stable in Node, so decorating is unnecessary; the
  // comparator returning 0 for a tie preserves the incoming order.
  return cards.sort((a, b) => ownedBand(a) - ownedBand(b));
}

// 1. Search English MTG cards through Scryfall.
//
// `commanders=1` FILTERS THE RESULTS TO LEGAL COMMANDERS ONLY.
//
// The commander picker in the Create New Deck modal used this route unfiltered
// and therefore offered any card at all -- so the user could pick a Sol Ring,
// press create, and be refused by a rule they had no way to see coming. A
// picker that offers a choice the app will then reject is worse than no picker.
//
// THE FILTER REUSES isLegalCommanderCard, THE REFUSAL'S OWN RULE. That is the
// point and it is not merely tidy: a second, simpler notion of "legal
// commander" here (say, a type_line regex) would drift from the real one and
// reintroduce the same disagreement in the opposite direction -- wrongly hiding
// legal planeswalker commanders and Backgrounds. One rule, one implementation,
// so the picker and the refusal cannot disagree by construction.
//
// OPT-IN, never applied by default: the deck Add Cards search and the manual
// collection add both use this route and must keep seeing every card.
router.get('/search', searchLimiter, async (req, res) => {
  const { name, number, set, scope = 'database', prints } = req.query;
  const commandersOnly = req.query.commanders === '1';
  // 1-based page over `limit`-sized pages.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(req.query.limit, 10) || 60));
  try {
    const { cards, total } = await scryfallApi.searchCards(name, number, set, scope, req.user.id, 'en', prints === '1', page, limit);
    // Filtered BEFORE ownership is stamped, so the work of the ownership join
    // is not spent on rows that are about to be discarded.
    const visible = commandersOnly
      ? cards.filter(card => commanderRules.isLegalCommanderCard(card))
      : cards;
    await attachOwnedQty(visible, req.user.id);
    // PR 6I item 3. AFTER attachOwnedQty, necessarily: the band is computed
    // from the very fields it stamps. Applied to EVERY search this route
    // serves — deck Add Cards, the commander picker, and any future caller —
    // because it sits at the route rather than in one screen's handler. That
    // is what makes "every search that returns catalogue results" true by
    // construction instead of by remembering to repeat it.
    sortOwnedFirst(visible);
    // Header, not the body: every existing caller expects a bare array here.
    if (total != null) {
      // The total is NOT re-stated when filtering. It describes the upstream
      // match count, and quietly replacing it with the filtered page's length
      // would make paging think it had reached the end. A filtered search that
      // pages is a genuine limitation, flagged rather than papered over.
      res.set('X-Total-Count', String(total));
      res.set('Access-Control-Expose-Headers', 'X-Total-Count');
    }
    res.json(visible);
  } catch (error) {
    console.error(error);
    if (error.message === 'INVALID_API_KEY') {
      return res.status(403).json({ error: 'Invalid API Key' });
    }
    if (error.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    if (error.message === 'UPSTREAM_UNAVAILABLE') {
      return res.status(503).json({ error: 'Card API is having trouble. Try again in a moment.' });
    }
    res.status(500).json({ error: 'Search failed' });
  }
});

// 1b. Identify a scanned card image by CLIP embedding similarity.
//
// PR 8: optionally also OCR the collector-number strip (`ocr: true`). It is
// OPT-IN so the existing scan path keeps its measured ~1.1s exactly as PR 22
// left it; a client that does not ask for OCR pays nothing.
//
// The OCR read is RETURNED, not acted upon. This route stays READ-ONLY — it
// identifies, it does not add. The client passes the read to /scan-resolve,
// which is the only place that decides between adding and queueing.
// The set code to SHOW for a queued scan. Prefers a candidate the catalogue
// recognises over the raw first token: 'MSH*EN' parses to 'mshen' first, which
// is not a real set, while 'msh' is right there in the candidate list. Falls
// back to the raw token when nothing validates, so a genuinely unreadable strip
// still shows what was read.
// GROUND TRUTH FOR THE CAPTURE CORPUS.
//
// Zach asked whether scanning ~40 varied cards could be turned into a
// regression corpus. It can, but ONLY if each capture is paired with what the
// card ACTUALLY was -- an image with no label is a picture, not a test case.
//
// Every capture I have investigated so far needed him to tell me the answer in
// chat ("should be namor the sub-mariner"), which does not scale past a handful
// and is exactly the manual step a corpus is supposed to remove.
//
// The app already knows the truth at two moments:
//   - he resolves a queued scan by PICKING the right card
//   - he corrects or confirms a staged row before committing
//
// Both are recorded here as a sidecar JSON next to the image. Diagnostics only:
// this never affects a scan, and a failure is swallowed.
let lastDumpName = null;

async function labelCapture(file, truth) {
  if (!process.env.SCAN_DUMP_DIR || !file) return;
  try {
    const dir = process.env.SCAN_DUMP_DIR;
    await fsp.writeFile(
      path.join(dir, file.replace(/\.jpg$/, '.json')),
      JSON.stringify({ ...truth, labelled_at: new Date().toISOString() }, null, 2));
  } catch { /* a labelling failure must never affect a scan */ }
}

async function pickDisplaySet(ocr) {
  const cands = ocr?.setLineCandidates?.length
    ? ocr.setLineCandidates
    : (ocr?.setCandidates || []);
  for (const c of cands) {
    const row = await db.get(
      'SELECT 1 FROM card_cache WHERE LOWER(set_id) = LOWER(?) LIMIT 1', [c]);
    if (row) return c;
  }
  return ocr?.set ?? null;
}

router.post('/scan-match', searchLimiter, async (req, res) => {
  // STAGE PROFILING, off unless SCAN_PROFILE=1. See scanProfile.js: the stages
  // we have measured only account for ~2.2s of a scan that runs 2.1-4.9s, so
  // this times EVERY stage including the ones never looked at (base64 decode,
  // DB hydration, JSON serialisation) and reports what is left over.
  const prof = scanProfile.start();
  try {
    const { image, set = '', recallK, orb, ocr } = req.body || {};
    const game = 'mtg';
    const lang = 'en';
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Missing image' });
    prof.set('b64len', image.length);
    const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
    const buf = Buffer.from(base64, 'base64');
    prof.mark('base64-decode');
    prof.set('bytes', buf.length);
    if (buf.length < 100) return res.status(400).json({ error: 'Invalid image data' });

    // FULL-RESOLUTION SCAN DUMP — diagnostics only, OFF unless explicitly asked
    // for by environment variable.
    //
    // WHY THIS EXISTS. The review queue stores a 220x308 THUMBNAIL, which is all
    // that survives for later inspection. Tuning the OCR strip window against
    // that thumbnail means tuning against blur: it is a ninth of the resolution
    // the phone actually uploads, and it has already produced two "fixes" that
    // measured well and failed on the real thing. This writes the exact bytes
    // the pipeline received, so a window can be verified against the real input
    // instead of a proxy for it.
    //
    // Fire-and-forget and fully swallowed: a diagnostics feature must never be
    // able to fail a scan of a card Zach is physically holding.
    if (process.env.SCAN_DUMP_DIR) {
      // NAMED SYNCHRONOUSLY, WRITTEN ASYNCHRONOUSLY.
      //
      // The write is fire-and-forget so diagnostics can never delay a scan. But
      // the NAME has to be recorded now: /scan-resolve arrives later and stamps
      // it onto the queue row, and if the name were assigned inside the async
      // block it could still be the PREVIOUS capture's when that happens.
      //
      // Known limitation, stated rather than hidden: this is module-level, so
      // it assumes scans are handled one at a time. That holds for one person
      // scanning a stack -- the flow is scan, resolve, scan -- but two
      // simultaneous scanners would cross their labels. The corpus is a
      // single-user debugging aid, so that is acceptable; a second user would
      // need the name carried through the request instead.
      const dumpName = `scan-${Date.now()}.jpg`;
      lastDumpName = dumpName;
      (async () => {
        try {
          const dir = process.env.SCAN_DUMP_DIR;
          await fsp.mkdir(dir, { recursive: true });
          // KEEP THE NEWEST, NOT THE OLDEST.
          //
          // This used to STOP WRITING once 40 files existed, so the dump froze
          // on the first 40 scans ever taken and every later session wrote
          // nothing. Twice now Zach has reported a specific bad card and the
          // capture simply was not there -- once I compared unrelated photos
          // because of it, and once (Turtle-Duck) I could not investigate at
          // all and had to ask him to rescan.
          //
          // A debugging aid that silently keeps the LEAST relevant data is
          // worse than none: it looks like it is working.
          //
          // Now it always writes and evicts the oldest, so the dump is a
          // rolling window over the MOST RECENT scans -- which is the only part
          // anyone ever wants. Still bounded, still a debugging aid.
          await fsp.writeFile(path.join(dir, dumpName), buf);
          const files = (await fsp.readdir(dir).catch(() => []))
            .filter(f => f.endsWith('.jpg'))
            .sort();
          // CAP RAISED FOR A LABELLED CAPTURE SESSION.
          //
          // Zach is scanning ~40 varied cards deliberately, to build a real
          // regression corpus. At 40 the dump would evict the first half of his
          // own session while he was still scanning it -- and a scan session is
          // 2-4 captures per card, not one, so 40 cards is well over 100 files.
          //
          // 400 files at ~700KB is under 300MB against 18GB free on dev. Still
          // bounded, still rotating newest-first.
          const KEEP = Number(process.env.SCAN_DUMP_KEEP || 400);
          for (const stale of files.slice(0, Math.max(0, files.length - KEEP))) {
            await fsp.unlink(path.join(dir, stale)).catch(() => {});
          }
        } catch { /* diagnostics must never affect a scan */ }
      })();
    }

    const result = await scanMatch.match(buf, game, 8, set, { recallK, orb, lang, prof });
    if (result.candidates && result.candidates.length > 0) {
      // DB HYDRATION — up to 8 candidates, each up to 2 queries, never timed.
      await prof.time('db-hydrate-candidates', async () => {
      const hydrated = await Promise.all(result.candidates.map(async (cand) => {
        let row = null;
        // INDEXED LOOKUP FIRST, then the slow general form only if it misses.
        //
        // Both of these queries used to SCAN all 105,156 rows of card_cache, up
        // to 16 times per scan (8 candidates x 2 queries) -- measured at 249ms,
        // 8% of the scan.
        //
        // The cause is that `OR LOWER(set_name) = LOWER(?)` and
        // `LOWER(name) = LOWER(?)` are not sargable: wrapping an indexed column
        // in a function throws the index away, and the OR forces a scan even
        // though idx_card_cache_set_num(set_id, number) exists and matches the
        // first half perfectly.
        //
        // EXPLAIN QUERY PLAN before: SCAN card_cache (both queries).
        //
        // So try the indexed equality first. It answers the overwhelming
        // majority of lookups, because `cand.set` comes from the catalogue in
        // the first place and is already lowercase. The permissive form is kept
        // verbatim as a fallback for the cases it was added for -- a set_name
        // spelled out, or a name differing in case -- so NOTHING that resolved
        // before stops resolving. It just no longer costs a table scan every
        // time.
        if (cand.set && cand.number) {
          row = await db.get(
            `SELECT * FROM card_cache WHERE set_id = ? AND number = ? LIMIT 1`,
            [cand.set, cand.number]
          );
          if (!row) {
            row = await db.get(
              `SELECT * FROM card_cache WHERE (set_id = ? OR LOWER(set_name) = LOWER(?)) AND number = ? LIMIT 1`,
              [cand.set, cand.set, cand.number]
            );
          }
        }
        if (!row && cand.name) {
          row = await db.get(
            `SELECT * FROM card_cache WHERE name = ? LIMIT 1`,
            [cand.name]
          );
          if (!row) {
            row = await db.get(
              `SELECT * FROM card_cache WHERE LOWER(name) = LOWER(?) LIMIT 1`,
              [cand.name]
            );
          }
        }
        return row ? { ...cand, card: parseCardRow(row) } : cand;
      }));
      result.candidates = hydrated;
      });
    }

    // OCR gets its OWN rectification of the card, from the ORIGINAL upload.
    //
    // It used to reuse `preprocessCard(buf)` — the matcher's 500x700 — and that
    // was the bug. The collector-number strip is ~5% of the card's height, so
    // at 500x700 it arrives ~8px tall and blurred; upscaling it 1.5x inside the
    // OCR module could not put back detail already thrown away. Measured through
    // this exact route, every crop offset from 0.86 to 0.96 read 0/4 correct,
    // and the near-misses returned FABRICATED numbers with confident=true —
    // which would silently record a printing Zach does not own.
    //
    // rectifyCard warps the SAME detected quad (same card, same region, same
    // crop fractions) sampled from the full-resolution buffer instead. The
    // MATCHER IS UNTOUCHED: it still calls preprocessCard and still gets its
    // tuned 500x700, and card identification is unchanged.
    //
    // Cost is a second WARP only — ~160ms on top of a ~1.1s scan — because the
    // detection is REUSED from the match above rather than re-run. Detecting the
    // card twice cost ~350ms and bought nothing: it is the same photo, so it
    // finds the same quad.
    if (ocr) {
      const t0 = Date.now();
      try {
        // WARP ONLY THE TWO BANDS OCR ACTUALLY READS.
        //
        // Zach: "I would rather not have duplicate work."
        //
        // This warp was 322-345ms, the most expensive step after ORB, because it
        // sampled a 2000px source and wrote a full 1500x2100 card. OCR only ever
        // looks at the collector strip (~2.8% of the card) and the title
        // (~3.8%) -- the other ~93% was warped at full resolution and discarded.
        //
        // NOT the "merge the two warps" idea, which I measured and rejected:
        // deriving the matcher's 500x700 by downscaling the big warp cost 84ms
        // against the 76ms warp it replaced, a net LOSS. This is the opposite --
        // warp LESS, not warp once.
        //
        // Same transform, same 2000px source, same sampling; only the output
        // canvas is smaller. Verified pixel-identical to cropping the full warp
        // across 25 captures, worst channel difference 0/255. That matters
        // beyond tidiness: every OCR threshold in this project was tuned on
        // those exact pixels, so anything less than identical invalidates them.
        //
        //     full-card warp   345ms
        //     strip-only        52ms
        //     title-only        54ms
        //     -------------------------
        //     saving           239ms per scan
        //
        // The two run concurrently, as the OCR passes already do.
        const [stripImg, titleImg] = await prof.time('ocr-rectify-warp', () => Promise.all([
          scanMatch.rectifyCard(buf, {
            width: collectorNumberOcr.OCR_W,
            height: collectorNumberOcr.OCR_H,
            detection: result.detection,
            region: collectorNumberOcr.STRIP,
          }),
          scanMatch.rectifyCard(buf, {
            width: collectorNumberOcr.OCR_W,
            height: collectorNumberOcr.OCR_H,
            detection: result.detection,
            region: cardTitleOcr.TITLE_BAND,
          }),
        ]));
        // Preserves the existing contract: `rectified` is truthy only when a
        // card was actually found, which is what gates OCR below.
        const rectified = stripImg;
        // No card found -> no read. Reading the strip position off a photo that
        // was never rectified would OCR the background, and a confident number
        // from the background is worse than no number: the review queue exists
        // for "we don't know", it cannot catch "we're sure and wrong".
        // BOTH OCR PASSES RUN AT ONCE.
        //
        // Zach: "I would like to work on speed next." Measured over 38 real
        // scans, the two reads cost 378ms (collector strip) and 291ms (title)
        // and ran STRICTLY ONE AFTER THE OTHER -- 669ms of a 3112ms scan spent
        // waiting on two independent operations.
        //
        // They are independent in every way that matters: different crops of
        // the same rectified image, and DIFFERENT TESSERACT WORKERS. The
        // workers were already separate (see cardTitleOcr's comment: sharing
        // one would mean calling setParameters per crop and racing on shared
        // worker state), so nothing is contended by overlapping them.
        //
        // Started here, awaited together below. Neither read can affect the
        // other's result, so the only change is which of them we wait for.
        const titlePromise = rectified
          ? prof.time('ocr-card-title', () => cardTitleOcr.readCardTitle(titleImg, { preCropped: true }))
          : Promise.resolve('');
        const raw = rectified
          ? await prof.time('ocr-collector-strip', () => collectorNumberOcr.readCollectorStrip(stripImg, { preCropped: true }))
          : '';

        // SCAN TRACE. Off unless SCAN_TRACE=1.
        //
        // WHY THIS EXISTS. Zach's queue recorded ocr_raw='' / 'Pe' / 'CT ———' on
        // cards that read 27/34 correctly when the SAME dumped bytes are pushed
        // through the SAME functions offline. Detection, rectify, the strip
        // window and the parser have each been measured and each works. So the
        // difference is something about the LIVE REQUEST, and no amount of
        // reasoning about the code has found it — three separate theories tonight
        // were all disproved by measurement.
        //
        // This records what the live path ACTUALLY had in its hands, so the two
        // runs can be compared field by field instead of argued about:
        //   - was there a detection at all, and what shape was its quad
        //   - did rectifyCard return an image, and what size
        //   - what did OCR read from it
        // A quad aspect far from ~0.7, or rectified=null, or a wildly different
        // read for a file that reads fine offline, each point at a different
        // culprit.
        //
        // Fire-and-forget and fully swallowed: diagnostics must never be able to
        // fail a scan of a card Zach is physically holding.
        if (process.env.SCAN_TRACE) {
          try {
            const q = result.detection?.quad;
            let quadAr = null;
            if (q?.length === 4) {
              const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
              const w = (d(q[0], q[1]) + d(q[3], q[2])) / 2;
              const h = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
              quadAr = h ? +(w / h).toFixed(3) : null;
            }
            const meta = rectified ? await sharp(rectified).metadata() : null;
            console.log('SCAN_TRACE ' + JSON.stringify({
              bytes: buf.length,
              detection: !!result.detection,
              quadAr,
              detW: result.detection?.detW ?? null,
              rectified: meta ? `${meta.width}x${meta.height}` : null,
              rawOcr: raw.replace(/\n/g, '|').slice(0, 60),
              topCandidate: result.candidates?.[0]?.name ?? null,
              inliers: result.candidates?.[0]?.inliers ?? null,
            }));
          } catch { /* a trace must never affect a scan */ }
        }

        // PR 11: THE TITLE, from the SAME rectified image.
        //
        // One rectification, two crops. The expensive parts of the OCR path are
        // the detection (~350ms, already reused from the match above) and the
        // warp (~160ms); a second crop off the buffer we already hold costs
        // only the recognition itself, and the title band is a single short
        // line so it is the cheaper of the two reads.
        //
        // This is the signal that survives a torch highlight. CLIP reads the
        // ARTWORK, which is exactly what a specular reflection blows out; the
        // printed title is still legible in the same photo. Reading it here
        // means /scan-resolve can identify the card even when the match above
        // returned noise.
        // Already running -- started alongside the collector strip above.
        const titleRaw = await titlePromise;
        result.ocr = { ...parseCollectorStrip(raw), title: titleRaw.trim(), ms: Date.now() - t0 };

        // PHASE 1b: rgbArt SHADOW MODE. Off unless RGBART_SHADOW=1.
        //
        // Computes the rgbArt hash of this scan and logs its answer ALONGSIDE
        // the ORB answer. Nothing is returned to the client and nothing about
        // the scan changes — Gate 1b is "rgbArt >= ORB on real scans", and that
        // has to be measured on Zach's actual photos before rgbArt is trusted
        // with an identification.
        //
        // It hashes the SAME rectified image the OCR path already produced, so
        // it costs one hash (~30ms) and no extra detection or warp.
        //
        // WHY IT REUSES `rectified` RATHER THAN THE RAW UPLOAD. The index was
        // built from Scryfall's flat card images. A raw phone photo is angled,
        // cropped loose and lit unevenly; rectified is the warped, card-shaped
        // version. Comparing like with like is the whole point — hashing the
        // raw upload would measure the detector's failures, not rgbArt's.
        //
        // Consequence, stated honestly: when detection fails, rectified is null
        // and rgbArt gets no turn at all. Those scans are logged as skipped
        // rather than as rgbArt failures, because they are not.
        if (process.env.RGBART_SHADOW) {
          const tShadow = Date.now();
          try {
            const shadow = rectified ? await rgbArtMatch.identify(rectified, 3) : null;
            const orbTop = result.candidates?.[0] ?? null;
            console.log('RGBART_SHADOW ' + JSON.stringify({
              ts: new Date().toISOString(),
              skipped: rectified ? null : 'no-detection',
              orb: orbTop ? { name: orbTop.name, set: orbTop.set, number: orbTop.number,
                              inliers: orbTop.inliers ?? null } : null,
              rgb: shadow ? { name: shadow.top.name, set: shadow.top.set,
                              number: shadow.top.number, dist: shadow.top.dist,
                              margin: shadow.margin, ms: shadow.ms } : null,
              rgbRunners: shadow ? shadow.hits.slice(1).map(h => ({ name: h.name, dist: h.dist })) : null,
              ocrNumber: result.ocr?.number ?? null,
              ocrTitle: (result.ocr?.title || '').slice(0, 40),
              agree: (shadow && orbTop)
                ? shadow.top.name.toLowerCase() === String(orbTop.name || '').toLowerCase()
                : null,
            }));
          } catch { /* shadow mode must never affect a scan */ }
          // Attribute shadow mode's own cost, so the profile shows what the
          // scan would cost WITHOUT this measurement running.
          prof.set('shadowMs', Date.now() - tShadow);
        }
      } catch (e) {
        console.warn('scan-match OCR failed:', e.message);
        result.ocr = { number: null, set: null, confident: false, raw: '', title: '', ms: Date.now() - t0 };
      }
    }

    // Internal geometry, in DETECTION-image pixel coordinates. It exists to let
    // the OCR path re-warp without re-detecting; it means nothing to a client and
    // would only invite one to depend on an internal coordinate space, so it is
    // deleted rather than shipped.
    delete result.detection;

    // RESPONSE SERIALISATION. The payload carries a base64 JPEG thumbnail and
    // up to 8 hydrated card rows, so this is not free and has never been timed.
    prof.mark('pre-serialise');
    const payload = JSON.stringify(result);
    prof.mark('json-serialise');
    prof.set('respBytes', payload.length);
    res.type('application/json').send(payload);
    prof.done();
  } catch (error) {
    console.error('scan-match failed:', error.message);
    prof.done();
    res.status(500).json({ error: 'Scan match failed' });
  }
});

// --- PR 8: collector-number OCR and the scan review queue -------------------

// Persist one unresolved scan. SERVER-SIDE ON PURPOSE: the queue must survive a
// page reload and a session end. Zach scans stacks of hundreds; losing the
// queue to a dropped connection or a backgrounded Safari tab would be worse
// than prompting inline, which is the design this replaces.
//
// The candidate list is SNAPSHOTTED as JSON rather than recomputed on read. It
// is stored already sorted owned-first, so the queue renders in the order that
// makes the common case a single tap without re-querying ownership per entry.
async function enqueueScanReview({ userId, matchedName, reason, ocr, candidates, crop }) {
  // Only the fields the review UI needs. Storing whole card_cache rows would
  // bloat the table and, worse, freeze prices into it.
  const slim = (candidates || []).map(c => ({
    id: c.id,
    name: c.name,
    set_id: c.set_id,
    set_name: c.set_name,
    number: c.number,
    image_url: c.image_url,
    finishes: c.finishes,
    owned_qty: c.owned_qty || 0,
  }));
  const result = await db.run(
    `INSERT INTO scan_review_queue
      (user_id, matched_name, reason, ocr_number, ocr_set, ocr_confident, ocr_raw, candidates_json, crop_data_url, dump_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId, matchedName, reason,
      ocr?.number ?? null,
      // SHOW THE SET CODE THE CATALOGUE BELIEVES, NOT THE RAW FIRST TOKEN.
      //
      // Zach: "the queue had MSHEN as the set code that wasn't right."
      //
      // `ocr.set` is whatever set-shaped token appeared FIRST on the strip. For
      // 'MSH*EN' that is 'mshen' -- the set code fused with the language code,
      // which is not a real set and never was. The parser knows this: it also
      // returns 'msh' in setCandidates, and every resolution path tries those
      // candidates against the catalogue.
      //
      // Storing the raw first token made the queue display a set code that does
      // not exist, so a row the resolver had understood perfectly well looked
      // like a failed read. Reporting our best VALIDATED reading instead means
      // the queue shows Zach what the scanner actually concluded.
      //
      // Purely a display concern -- ocr_raw still carries the unedited text, so
      // nothing diagnostic is lost.
      await pickDisplaySet(ocr),
      ocr?.confident ? 1 : 0,
      (ocr?.raw ?? '').slice(0, 500),
      JSON.stringify(slim),
      crop || null,
      // PIN THE CAPTURE TO THE ROW, not to whatever was scanned most recently.
      // Resolving 18 queued cards after a session would otherwise write all 18
      // labels onto the last image scanned.
      lastDumpName,
    ]
  );
  return { id: result.lastID };
}

// Resolve one scanned card.
//
// Scanning must not stop to ask questions. Zach, 2026-08-20: "maybe when
// scanning hold the unknown cards till im done scanning and then let me go
// through all the unknown cards and update them correctly that way it doesnt
// slow scanning down."
//
// So this route makes exactly one decision per scanned card:
//   - the OCR read narrowed the catalogue to EXACTLY ONE printing -> add it
//   - anything else -> put it in the review queue and move on
// There is no third branch and no "most likely" fallback.
router.post('/scan-resolve', async (req, res) => {
  try {
    const { name, title_text = '', ocr_text = '', printing_hint = null, crop, quantity, stage, match_inliers } = req.body || {};
    // NAME IS NO LONGER REQUIRED, and that is the point of PR 11.
    //
    // It used to be, because CLIP's match was the only way to identify a card.
    // On a glare-hit photo CLIP returns noise, so requiring its name meant the
    // scan could not be resolved at all — even when the title and collector
    // number were both plainly legible in the same image. Now EITHER signal can
    // identify the card, so the requirement is that AT LEAST ONE is present.
    //
    // This is a widening, not a loosening: whichever name is used still has to
    // be backed by a real catalogue printing before anything is added.
    if (typeof name !== 'string' && name != null) {
      return res.status(400).json({ error: 'name must be a string' });
    }
    if (typeof title_text !== 'string') {
      return res.status(400).json({ error: 'title_text must be a string' });
    }
    // A scan has to carry SOMETHING identifying. Before the OCR fallback that
    // meant a name or a title, because those were the only two routes to a card.
    // The collector strip is now a third: set code + number is the printing's
    // own catalogue address, so a scan that read it is identifiable even when
    // image matching and the title both came up empty — which is exactly the
    // shape of Zach's queue entries 113 and 114.
    if (!name && !title_text && !ocr_text) {
      return res.status(400).json({ error: 'name, title_text or ocr_text is required' });
    }
    // Bound the free-text fields. `name` is a card name, `title_text` is one
    // short line of recognised text and `ocr_text` is two; anything far larger
    // is a malformed or hostile client, and an unbounded string here would be
    // stored verbatim in the queue row. The crop is a data URL and is bounded
    // too — the client sends a ~220px JPEG thumbnail, so 512KB is generous.
    if (name && name.length > 300) {
      return res.status(400).json({ error: 'name is too long' });
    }
    if (title_text.length > 300) {
      return res.status(400).json({ error: 'title_text is too long' });
    }
    if (typeof ocr_text !== 'string' || ocr_text.length > 2000) {
      return res.status(400).json({ error: 'ocr_text must be a string under 2000 characters' });
    }
    if (crop != null && (typeof crop !== 'string' || crop.length > 512 * 1024)) {
      return res.status(400).json({ error: 'crop must be a data URL under 512KB' });
    }
    const qty = positiveInteger(quantity === undefined ? 1 : quantity, { name: 'quantity', max: 1000 });

    // BOUND THE PRINTING HINT. Same treatment as every other free-text field:
    // it reaches a SQL comparison, so its shape is checked here rather than
    // trusted. A malformed hint is DROPPED, not rejected — it is an optimisation
    // (the artwork already named the printing), and refusing the whole scan over
    // it would turn a bad hint into a lost card. The resolver validates the
    // surviving value against the catalogue anyway, so the worst a bogus hint
    // can do is fail to match and fall through to the normal path.
    // THE NUMBER IS OPTIONAL. A set-only hint is the basic-land case: the art
    // identifies the CARD and its set confidently, but cannot say which of
    // several identical printings it is, so the collector-number read decides
    // within that set. Requiring a number here rejected precisely the hint that
    // case needs. Bounds are still enforced on whatever is present.
    let hint = null;
    const okStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= 20;
    if (printing_hint && typeof printing_hint === 'object' && okStr(printing_hint.set)) {
      hint = { set: printing_hint.set };
      if (okStr(printing_hint.number)) hint.number = printing_hint.number;
    }

    const outcome = await resolveScannedPrinting({
      matchedName: name || '',
      titleText: title_text,
      ocrText: ocr_text,
      printingHint: hint,
      userId: req.user.id,
      // HOW GOOD THE ART MATCH ACTUALLY WAS.
      //
      // Without this the resolver cannot tell a 141-inlier identification from
      // an 8-inlier guess, so it treats both as "the art decided it" and the
      // printed collector number never gets to contradict a confident-looking
      // wrong answer. On Zach's foils ORB returned 8-12 inliers -- noise -- and
      // named four different wrong cards for the same card, while OCR read its
      // number correctly every time.
      //
      // Bounded and validated like every other client value; a missing or
      // bogus value simply means "strength unknown" and the old behaviour.
      matchInliers: Number.isFinite(match_inliers) ? match_inliers : null,
    });

    if (outcome.action === 'add') {
      // STAGE INSTEAD OF ADDING, when the client asks for it.
      //
      // Zach: "instead of auto putting in my collection. Just putting aside and
      // at the end letting me add all. That way I can ensure no weirdness
      // occurred or ensure there isn't any dupes."
      //
      // The RESOLUTION is unchanged — the same identity rules decide the same
      // printing. Only the destination moves: `scan_staging` instead of
      // `collection`, so nothing is owned until he presses Add All. Opt-in via
      // the request rather than a server default so the existing direct-add
      // behaviour, and every test that covers it, is untouched.
      if (stage) {
        const staged = await stageScannedCard({
          userId: req.user.id,
          body: req.body,
          cardId: outcome.printing.id,
          quantity: qty,
          crop,
          matchInliers: Number.isFinite(req.body?.match_inliers) ? req.body.match_inliers : null,
        });
        return res.json({
          action: 'staged',
          staged_id: staged.id,
          flag: staged.flag,
          card: parseCardRow(outcome.printing),
          ocr: { number: outcome.ocr.number, set: outcome.ocr.set, confident: outcome.ocr.confident },
          resolved_by: outcome.titleName && outcome.usedName === outcome.titleName ? 'title' : 'clip',
        });
      }
      // FINISH IS NEVER INFERRED FROM THE IMAGE (plan task G2). Special
      // treatments share artwork AND collector numbers with the standard
      // printing, so no still image can tell them apart. The finish used is
      // whatever the CLIENT explicitly supplied; when it supplies nothing the
      // app's declared default applies. Nothing here looks at pixels to decide
      // it, and the request body is passed through unchanged so
      // finishColumnsFromBody stays the single place that interprets a finish.
      const added = await addCardToCollection(req.user, {
        ...req.body,
        card_id: outcome.printing.id,
        quantity: qty,
      });
      return res.json({
        action: 'added',
        entry_id: added.id,
        card: parseCardRow(outcome.printing),
        ocr: { number: outcome.ocr.number, set: outcome.ocr.set, confident: outcome.ocr.confident },
        // Which signal identified the card. Diagnostic only — it exists so the
        // scanner's existing debug panel can show whether the title or CLIP
        // carried a scan, which is the measurement this PR will be judged on.
        resolved_by: outcome.titleName && outcome.usedName === outcome.titleName ? 'title' : 'clip',
      });
    }

    // Queued. The card is NOT in the collection and must not be counted as
    // owned anywhere until Zach resolves it.
    const entry = await enqueueScanReview({
      userId: req.user.id,
      // THE NAME THE RESOLVER ACTUALLY USED, not the one CLIP guessed.
      //
      // The queue entry is what Zach reads when deciding, so it must name the
      // card the candidates below it belong to. With text-first resolution the
      // title routinely identifies a card CLIP got wrong (that is the whole
      // point), and labelling the entry with CLIP's discarded guess would show
      // him 'Avatar Aang' above a list of Fated Firepower printings. Falling
      // back to `name` covers the case where the title read nothing.
      matchedName: outcome.usedName || name || '',
      reason: outcome.reason,
      ocr: outcome.ocr,
      candidates: outcome.candidates,
      crop,
    });
    return res.json({
      action: 'queued',
      queue_id: entry.id,
      reason: outcome.reason,
      candidates: outcome.candidates.map(parseCardRow),
      ocr: { number: outcome.ocr.number, set: outcome.ocr.set, confident: outcome.ocr.confident },
    });
  } catch (error) {
    if (error instanceof AddCardError || error instanceof RequestBoundsError
        || error instanceof InvariantError || error instanceof FinishError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('scan-resolve failed:', error);
    res.status(500).json({ error: 'Failed to resolve scanned card' });
  }
});

// The pending queue, oldest first — the order he scanned the stack in, which is
// the order the physical pile is still in.
router.get('/scan-queue', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT * FROM scan_review_queue WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
      [req.user.id]
    );
    res.json({
      entries: rows.map(r => ({
        id: r.id,
        matched_name: r.matched_name,
        reason: r.reason,
        ocr: { number: r.ocr_number, set: r.ocr_set, confident: !!r.ocr_confident, raw: r.ocr_raw },
        candidates: JSON.parse(r.candidates_json || '[]'),
        crop: r.crop_data_url || null,
        created_at: r.created_at,
      })),
    });
  } catch (error) {
    console.error('scan-queue failed:', error);
    res.status(500).json({ error: 'Failed to load review queue' });
  }
});

// Resolve one entry: Zach picked a printing (and a finish, explicitly).
//
// The card moves from the queue INTO the collection through the SAME
// addCardToCollection path a manual add uses, so placement, finish
// canonicalisation and the capacity invariants all apply identically. The queue
// row is deleted in the same transaction-shaped sequence, so a card is never in
// both states and never in neither.
router.post('/scan-queue/:id/resolve', async (req, res) => {
  try {
    // Route params are strings; parse before validating. A non-numeric id is a
    // client bug, not a missing row, so it is a 400 rather than a 404.
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    const entry = await db.get(
      `SELECT * FROM scan_review_queue WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Queue entry not found' });

    const { card_id } = req.body || {};
    if (!card_id) return res.status(400).json({ error: 'card_id is required' });

    // The chosen printing must be one the queue actually offered. Without this
    // the endpoint would add ANY card id a client sent while claiming it came
    // from a scan.
    const offered = JSON.parse(entry.candidates_json || '[]').map(c => c.id);
    if (offered.length && !offered.includes(card_id)) {
      return res.status(400).json({ error: 'Chosen printing was not among the scanned candidates' });
    }

    const added = await addCardToCollection(req.user, { ...req.body, card_id });
    // GROUND TRUTH: he just told us what the card really is by picking it.
    // The queue row carries the raw OCR that produced the mistake, so the
    // sidecar records both the truth and what the scanner had believed.
    const truthRow = await db.get(
      `SELECT name, set_id, number FROM card_cache WHERE id = ?`, [card_id]);
    await labelCapture(entry.dump_file || null, {
      source: 'queue-resolve',
      truth: truthRow || { card_id },
      scanner_said: { matched_name: entry.matched_name || null, reason: entry.reason || null },
      ocr: {
        number: entry.ocr_number ?? null,
        set: entry.ocr_set ?? null,
        raw: entry.ocr_raw ?? null,
      },
    });
    await db.run(`DELETE FROM scan_review_queue WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json({ resolved: true, entry_id: added.id, card_id });
  } catch (error) {
    if (error instanceof AddCardError || error instanceof RequestBoundsError
        || error instanceof InvariantError || error instanceof FinishError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('scan-queue resolve failed:', error);
    res.status(500).json({ error: 'Failed to resolve queue entry' });
  }
});

// Discard an entry: it was a misscan, or he does not want the card. Deleting
// from the queue is safe precisely BECAUSE the queue is not the collection —
// nothing is removed from what he owns.
router.delete('/scan-queue/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    const result = await db.run(
      `DELETE FROM scan_review_queue WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!result.changes) return res.status(404).json({ error: 'Queue entry not found' });
    res.json({ discarded: true });
  } catch (error) {
    console.error('scan-queue delete failed:', error);
    res.status(500).json({ error: 'Failed to discard queue entry' });
  }
});

// --- THE SCAN STAGING AREA -------------------------------------------------
//
// Zach: "instead of auto putting in my collection. Just putting aside and at the
// end letting me add all. That way I can ensure no weirdness occurred or ensure
// there isn't any dupes." And on presentation: flag what is suspicious, because
// a flat list of sixty rows gets skimmed, not reviewed.
//
// Staged scans are NOT owned. They live in their own table so that is true by
// construction rather than by every caller remembering to filter — the same
// property the review queue relies on.

// Stage a scanned card. Returns the row plus its flag, so the client can show
// immediately that something wants a second look.
router.post('/scan-stage', async (req, res) => {
  try {
    const { card_id, quantity, finish, condition, location_id, crop, match_inliers } = req.body || {};
    if (!card_id || typeof card_id !== 'string') {
      return res.status(400).json({ error: 'card_id is required' });
    }
    const qty = positiveInteger(quantity === undefined ? 1 : quantity, { name: 'quantity', max: 1000 });

    // The card must exist in the catalogue. Staging an unknown id would defer
    // the failure to commit time, when he has already scanned the whole stack
    // and put the physical cards away — the worst possible moment to find out.
    const card = await db.get(`SELECT id, name FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) return res.status(400).json({ error: 'Unknown card_id' });

    // Flagging lives in stageScannedCard so this endpoint and /scan-resolve's
    // stage mode cannot drift apart on what a flag means.
    const staged = await stageScannedCard({
      userId: req.user.id,
      body: { finish, condition, location_id },
      cardId: card_id,
      quantity: qty,
      crop,
      matchInliers: Number.isFinite(match_inliers) ? match_inliers : null,
    });

    res.json({ staged: true, id: staged.id, card_id, name: card.name, flag: staged.flag });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('scan-stage failed:', error);
    res.status(500).json({ error: 'Failed to stage scanned card' });
  }
});

// The staged session, oldest first — the order he scanned, which is the order
// the physical stack is in. Flagged rows are counted separately so the UI can
// lead with "3 need a look" instead of making him find them.
router.get('/scan-stage', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT s.*, c.name, c.set_id, c.number, c.image_url
         FROM scan_staging s
         LEFT JOIN card_cache c ON c.id = s.card_id
        WHERE s.user_id = ?
        ORDER BY s.created_at ASC, s.id ASC`,
      [req.user.id]);
    res.json({
      entries: rows.map(r => ({
        id: r.id,
        card_id: r.card_id,
        name: r.name,
        set_id: r.set_id,
        number: r.number,
        image_url: r.image_url,
        quantity: r.quantity,
        finish: r.finish,
        condition: r.condition,
        location_id: r.location_id,
        flag: r.flag,
        match_inliers: r.match_inliers,
        crop: r.crop_data_url || null,
        created_at: r.created_at,
      })),
      total: rows.length,
      flagged: rows.filter(r => r.flag).length,
    });
  } catch (error) {
    console.error('scan-stage list failed:', error);
    res.status(500).json({ error: 'Failed to load staged scans' });
  }
});

// Update one staged row before committing — quantity, finish, condition,
// location. This is the whole point of staging: fixing a scan BEFORE it becomes
// collection data, rather than hunting it down afterwards.
router.patch('/scan-stage/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    const row = await db.get(`SELECT * FROM scan_staging WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!row) return res.status(404).json({ error: 'Staged entry not found' });

    const { quantity, finish, condition, location_id } = req.body || {};
    const qty = quantity === undefined ? row.quantity
      : positiveInteger(quantity, { name: 'quantity', max: 1000 });

    await db.run(
      `UPDATE scan_staging SET quantity = ?, finish = ?, condition = ?, location_id = ?
        WHERE id = ? AND user_id = ?`,
      [qty, finish || row.finish, condition || row.condition,
       location_id === undefined ? row.location_id : location_id, id, req.user.id]);
    res.json({ updated: true, id });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('scan-stage patch failed:', error);
    res.status(500).json({ error: 'Failed to update staged scan' });
  }
});

// Drop one staged row — a mis-scan he does not want.
router.delete('/scan-stage/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: 'id must be a positive integer' });
    }
    const out = await db.run(`DELETE FROM scan_staging WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!out.changes) return res.status(404).json({ error: 'Staged entry not found' });
    res.json({ discarded: true, id });
  } catch (error) {
    console.error('scan-stage delete failed:', error);
    res.status(500).json({ error: 'Failed to discard staged scan' });
  }
});

// COMMIT THE SESSION — "add all".
//
// ALL OR NOTHING. Every row is added inside one transaction, and any failure
// rolls the whole thing back and leaves staging untouched. A partial commit is
// the worst outcome available here: Zach would have some unknown subset of a
// physical stack in his collection with no way to tell which, and no way to
// reconcile it against the pile in his hand. Refusing loudly and changing
// nothing is always recoverable; a silent partial commit is not.
router.post('/scan-stage/commit', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT * FROM scan_staging WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
      [req.user.id]);
    if (!rows.length) return res.json({ committed: 0, entries: [] });

    const added = [];
    // db.withTransaction, not raw BEGIN/COMMIT: addCardToCollection opens its
    // own transaction, and this helper makes a nested call JOIN the outer one
    // instead of failing with "cannot start a transaction within a transaction".
    // That nesting is exactly what makes the batch atomic — every card is added
    // inside ONE transaction, so a failure on card 40 unwinds cards 1-39 too.
    await db.withTransaction(async () => {
      for (const r of rows) {
        const entry = await addCardToCollection(req.user, {
          card_id: r.card_id,
          quantity: r.quantity,
          finish: r.finish,
          condition: r.condition,
          location_id: r.location_id,
        });
        added.push({ staged_id: r.id, entry_id: entry.id, card_id: r.card_id });
      }
      await db.run(`DELETE FROM scan_staging WHERE user_id = ?`, [req.user.id]);
    });
    res.json({ committed: added.length, entries: added });
  } catch (error) {
    if (error instanceof AddCardError || error instanceof RequestBoundsError
        || error instanceof InvariantError || error instanceof FinishError) {
      // The staging table is intact — he can fix the offending row and retry.
      return res.status(error.status).json({ error: error.message, committed: 0 });
    }
    console.error('scan-stage commit failed:', error);
    res.status(500).json({ error: 'Failed to commit staged scans', committed: 0 });
  }
});

// Abandon the whole session without adding anything.
router.delete('/scan-stage', async (req, res) => {
  try {
    const out = await db.run(`DELETE FROM scan_staging WHERE user_id = ?`, [req.user.id]);
    res.json({ discarded: out.changes || 0 });
  } catch (error) {
    console.error('scan-stage clear failed:', error);
    res.status(500).json({ error: 'Failed to clear staged scans' });
  }
});

// Put a resolved scan into the staging session, and work out whether the row
// deserves a second look.
//
// SHARED by /scan-stage and by /scan-resolve's stage mode, so the flag rules
// exist in exactly one place. Two copies would drift, and a flag that means
// something different depending on which endpoint created it is worse than no
// flag at all.
//
// FLAGS ARE COMPUTED NOW AND STORED, not derived when the list renders: the
// answer depends on the state of the session AT THE MOMENT OF THE SCAN ("was
// this already staged when I scanned it?"), and recomputing later against a
// mutated session would silently change what Zach is being told.
async function stageScannedCard({ userId, body = {}, cardId, quantity, crop, matchInliers }) {
  const finish = body.finish || body.printing || 'nonfoil';
  const condition = body.condition || 'Near Mint';
  const locationId = body.location_id || null;

  // ONLY FLAG A REPEAT WITHIN THIS SESSION, never "you already own one".
  //
  // Zach: "I shouldnt get a warning in the scanned list if this card is in my
  // collection already only if I scanned it twice this session."
  //
  // He is right, and the old comment here already made his argument without
  // following it: owning a second copy is a perfectly normal thing for a
  // collector to do ON PURPOSE. Flagging it warns about the intended outcome of
  // the action he just took.
  //
  // The cost is not just noise. Flags exist so the rows that need attention sit
  // at the top of a long list; a flag that fires on ordinary behaviour trains
  // him to skim past all of them, including 'low_confidence', which is the one
  // that questions whether the app identified the right card at all.
  //
  // Scanning the same card TWICE IN ONE SESSION is different: it usually means
  // the scanner double-fired on one piece of cardboard, and that is a genuine
  // question about the physical stack in front of him.
  let flag = null;
  const dup = await db.get(
    `SELECT id FROM scan_staging WHERE user_id = ? AND card_id = ? AND finish = ?`,
    [userId, cardId, finish]);
  if (dup) flag = 'duplicate_in_session';
  // A weak match outranks the others: it questions whether this is even the
  // right card, where the others only say "you have one already" — which is a
  // perfectly normal thing for a collector to do on purpose.
  // SAME THRESHOLD THE RESOLVER USES. This was a hardcoded 25 while
  // scanPrintingResolver had moved to 32, so scans the resolver considered
  // noise were shown to Zach unflagged. Importing it keeps one definition of
  // "the art match is guessing".
  if (Number.isFinite(matchInliers) && matchInliers <= WEAK_MATCH_INLIERS) {
    flag = 'low_confidence';
  }

  const ins = await db.run(
    `INSERT INTO scan_staging
       (user_id, card_id, quantity, finish, condition, location_id, flag, match_inliers, crop_data_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, cardId, quantity, finish, condition, locationId, flag,
     Number.isFinite(matchInliers) ? matchInliers : null,
     typeof crop === 'string' ? crop.slice(0, 200000) : null]);

  // LABEL THE SUCCESSES TOO, not only the failures.
  //
  // Only queue-resolve was labelling, which meant the corpus could only ever
  // learn from scans that went WRONG. Zach's session staged 42 cards and queued
  // 15: labelling just the queue throws away three quarters of the evidence,
  // and the staged ones are the POSITIVE controls -- they are how a tuning run
  // proves a change did not break what already worked.
  //
  // A staged row is a card he accepted, so it is ground truth of the same kind
  // as a queue resolution, just with the scanner having been right.
  //
  // Diagnostics only: labelCapture swallows its own failures and returns
  // immediately when no dump is configured.
  const truth = await db.get(
    `SELECT name, set_id, number FROM card_cache WHERE id = ?`, [cardId]);
  await labelCapture(lastDumpName, {
    source: 'scan-stage',
    truth: truth || { card_id: cardId },
    scanner_said: { matched_name: truth?.name || null },
    match_inliers: Number.isFinite(matchInliers) ? matchInliers : null,
    flag,
  });

  return { id: ins.lastID, flag };
}

// Build/verify a per-set ORB index
router.post('/prepare-set', searchLimiter, async (req, res) => {
  try {
    const { set } = req.body || {};
    const game = 'mtg';
    const lang = 'en';
    const supported = true;
    const sets = parseSetList(set);
    if (!supported || !sets.length) return res.json({ ready: false, supported });
    const pending = sets.filter(s => !setIndex.isReady(game, s, lang));
    if (pending.length === 0) return res.json({ ready: true });

    // A set that cannot be built (no such set for this language, or the provider
    // has no card data for it) has to be reported, not polled forever. Without
    // this the client sat on "fetching card list" indefinitely while every poll
    // kicked off another doomed build.
    const failures = pending
      .map(s => ({ set: s, error: setIndex.buildFailed(game, s, lang) }))
      .filter(f => f.error);
    const buildable = pending.filter(s => !setIndex.buildFailed(game, s, lang));
    if (buildable.length === 0) {
      return res.json({ ready: false, building: false, failed: true, failures, error: failures[0].error });
    }

    buildable.forEach(s => setIndex.ensureSet(game, s, lang).catch(() => {}));
    // Report the first still-building set's progress for the UI bar, plus any
    // sets in the list that already failed (a multi-set scan can be part ready).
    res.json({ ready: false, building: true, progress: setIndex.setProgress(game, buildable[0], lang), pending: buildable, failures });
  } catch (error) {
    console.error('prepare-set failed:', error.message);
    res.status(500).json({ error: 'Prepare set failed' });
  }
});

// 2. Get User's Collection
router.get('/collection', async (req, res) => {
  try {
    const listType = req.query.list_type || 'collection';
    const isTrade = req.query.is_trade;
    const compId = req.query.compartment_id;

    let filterSql = `WHERE c.user_id = ? AND c.list_type = ?`;
    let filterParams = [req.user.id, listType];

    if (isTrade !== undefined) {
      filterSql += ` AND c.is_trade = ?`;
      filterParams.push(isTrade === 'true' || isTrade === '1' ? 1 : 0);
    }
    if (compId !== undefined) {
      filterSql += ` AND c.compartment_id = ?`;
      filterParams.push(compId);
    }

    const query = `
      SELECT
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.finish,
        c.purchase_price,
        c.compartment_id,
        c.position,
        c.added_at,
        c.is_trade,
        c.favorite,
        c.list_type,
        c.notes,
        cc.name,
        cc.oracle_id,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.type_line,
        cc.cmc,
        cc.color_identity,
        cc.rarity,
        -- The printing's own finish list. Carried so the finish picker can
        -- offer only the versions that physically exist (plan requirement G1);
        -- without it parseCardRow yields [] and every picker falls back to
        -- offering all three, which is what let a user record a foil of a card
        -- that was never printed in foil.
        cc.finishes,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_reverse_holofoil,
        cc.tcgplayer_url,
        cc.cardmarket_url,
        l.id as location_id,
        l.name as location_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label,
        cp.capacity as compartment_capacity
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);

    const alloc = await checkedOutAllocation(req.user.id);
    // The cross-deck commitment, computed ONCE for the whole listing rather
    // than per row. Browse Collection is the screen the false-availability bug
    // was reported on, so the figure has to be carried here -- fixing it only
    // on the search route would leave it wrong exactly where it was seen.
    const inDeck = await inDeckQuantities(req.user.id);

    const formatted = rows.map(row => ({
      ...parseCardRow(row),
      price_trend: resolveCardPrice(row),
      checked_out_qty: alloc.get(row.entry_id) || 0,
      // Keyed on (card_id, finish): the app's deck identity. A committed foil
      // must not make the nonfoil of the same printing read as spoken for --
      // they are different physical objects.
      in_deck_qty: inDeck.get(`${row.card_id}|${row.finish || 'nonfoil'}`) || 0,
      compartment_display_label: row.compartment_id
        ? compartmentLabel({ idx: row.compartment_idx, label: row.compartment_label }, row.location_type)
        : null,
      sub_location: row.compartment_id
        ? `${row.location_type === 'Binder' ? 'Page' : 'Row'} ${row.compartment_idx}`
        : ''
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch collection' });
  }
});

// Shared by the single add below and the bulk add after it, so one card and two
// hundred cards travel exactly the same path (cache lookup, compartment
// resolution, rebalance, price history). Throws AddCardError for caller-visible
// failures; anything else is a genuine 500.
class AddCardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function addCardToCollection(user, body) {
  const {
    card_id,
    quantity = 1,
    condition = 'Near Mint',
    purchase_price = 0,
    location_id = null,
    list_type = 'collection',
    is_trade = 0,
    stackable = false
  } = body;
  const req = { user, body };

  // Resolve the finish ONCE, at the boundary, into the two columns to write.
  //
  // `finish` is authoritative (deck identity matches on it); `printing` is its
  // display mirror. Deriving both here rather than at each INSERT is what keeps
  // them from drifting -- and writing `finish` at all is what was missing:
  // every add previously left it on the column default, so a foil that DID get
  // stored still claimed to be nonfoil. An unrecognised value throws rather
  // than defaulting, so a finish the app cannot represent is refused instead of
  // silently recorded as something the card is not.
  const { finish, printing } = finishColumnsFromBody(body);

  if (!card_id) {
    throw new AddCardError(400, 'card_id is required');
  }

  // The card_cache lookup and any Scryfall fallback happen BEFORE the
  // transaction. A network call inside a transaction would hold SQLite's write
  // lock for the duration of an upstream request, stalling every other writer
  // behind an external dependency's latency.
  let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [card_id]);
  if (!card) {
    try {
      card = await scryfallApi.getCardById(card_id);
    } catch (error) {
      if (error.code === 'NON_ENGLISH_PRINTING') {
        throw new AddCardError(400, 'Only English card printings are supported.');
      }
      throw error;
    }
    if (!card) {
      throw new AddCardError(404, `Card ID ${card_id} not found.`);
    }
  }

  const count = quantity;

  // Placement resolution, the capacity reservation and every insert run in one
  // transaction. Resolving a slot outside the transaction and inserting inside
  // it is the race T5 covers: two callers resolve the same free slot before
  // either writes.
  const result = await db.withTransaction(async (tx) => {
    if (location_id) {
      await requireOwnedLocation(tx, location_id, req.user.id);
    }

    // Normalize the helper's "nowhere to put this" signal. It returns null when
    // every compartment (including overflow locations) is full, but an object
    // with a null compartment_id in other no-placement cases. Collapsing both
    // into one shape here keeps the rest of this function free of null guards.
    const resolved = (await resolveCompartmentAndPosition({
      dbClient: tx,
      locationId: location_id,
      userId: req.user.id,
      cardId: card_id,
      printing
    })) || { compartment_id: null, position: 0, full: true };

    const targetLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;

    // Reserve all `count` copies against the destination before writing any of
    // them, so a partially-fitting add is refused outright instead of filing
    // some copies and overflowing on the rest.
    if (resolved.compartment_id) {
      const compartment = await requireOwnedCompartment(tx, resolved.compartment_id, req.user.id);
      // `count` slots either way: a stackable row of N occupies N physical
      // slots, and N unstacked rows occupy N.
      await assertCapacityFor(tx, compartment, count);
    }

    let lastInsertedId = null;

    if (stackable) {
      const inserted = await tx.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, finish, purchase_price,
          location_id, compartment_id, position, is_trade, list_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        card_id, req.user.id, count, condition, printing, finish, purchase_price || 0,
        targetLocationId, resolved.compartment_id, resolved.position, is_trade ? 1 : 0, list_type
      ]);
      lastInsertedId = inserted.lastID;
    } else {
      for (let i = 0; i < count; i++) {
        const inserted = await tx.run(`
          INSERT INTO collection (
            card_id, user_id, quantity, condition, printing, finish, purchase_price,
            location_id, compartment_id, position, is_trade, list_type
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          card_id, req.user.id, condition, printing, finish, purchase_price || 0,
          targetLocationId, resolved.compartment_id, resolved.position + (i * 0.001), is_trade ? 1 : 0, list_type
        ]);
        lastInsertedId = inserted.lastID;
      }
    }

    if (resolved.compartment_id && targetLocationId) {
      const loc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [targetLocationId, req.user.id]);
      if (loc) {
        // Pass `tx`, not the module-level `db`. Both happen to work today --
        // `db.run` inside a transaction is routed onto the active transaction
        // via AsyncLocalStorage -- but relying on that ambient behavior means
        // the correctness of this call depends on an invisible context rather
        // than on what the code says. Any future refactor that moves this off
        // the ALS-tracked call path (a queue hop, a worker, a .then boundary)
        // would silently turn it into an out-of-transaction write.
        await rebalanceCompartmentByScheme(tx, resolved.compartment_id, loc.sort_order, loc.foil_sorting);
      }
    }

    return {
      message: 'Card added to collection',
      id: lastInsertedId,
      placement: resolved.compartment_id
        ? await describePlacement(tx, lastInsertedId, req.user.id)
        : null,
      container_full: !!resolved.full,
      rule_rejected: !!resolved.rejected
    };
  });

  // Price history is deliberately outside the transaction: it is derived
  // telemetry, not part of the collection invariant, and a price-write failure
  // must not roll back a legitimate add.
  await recordPrice(card_id, card.price_trend);

  return result;
}

// 3. Add Card to Collection
router.post('/collection', async (req, res) => {
  try {
    const body = { ...req.body };
    body.quantity = positiveInteger(body.quantity === undefined ? 1 : body.quantity, { name: 'quantity', max: 1000 });
    res.status(200).json(await addCardToCollection(req.user, body));
  } catch (error) {
    if (error instanceof AddCardError || error instanceof RequestBoundsError || error instanceof InvariantError || error instanceof FinishError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to add card' });
  }
});

// 3b. Bulk add: one shared condition/printing/quantity across many cards, so a
// set browse can be added in one action instead of one drawer per card.
const BULK_ADD_MAX = 250;
router.post('/collection/bulk-add', async (req, res) => {
  const { card_ids, ...shared } = req.body;
  try {
    requireArray(card_ids, { name: 'card_ids', minLength: 1, maxLength: BULK_ADD_MAX });
    if (card_ids.some(id => typeof id !== 'string' || !id) || new Set(card_ids).size !== card_ids.length) {
      throw new RequestBoundsError(400, 'card_ids must contain unique non-empty card IDs');
    }
    shared.quantity = positiveInteger(shared.quantity === undefined ? 1 : shared.quantity, { name: 'quantity', max: 1000 });
    boundedProduct([card_ids.length, shared.quantity], { name: 'expanded operations', max: 1000 });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  // Sequential on purpose: placement resolves against the rows already inserted,
  // so adds must not race each other for the same compartment slot.
  const added = [];
  const failed = [];
  for (const card_id of card_ids) {
    try {
      const result = await addCardToCollection(req.user, { ...shared, card_id });
      added.push({ card_id, id: result.id });
    } catch (error) {
      if (!(error instanceof AddCardError) && !(error instanceof FinishError)) console.error(error);
      failed.push({
        card_id,
        error: (error instanceof AddCardError || error instanceof FinishError)
          ? error.message
          : 'Failed to add card'
      });
    }
  }
  const qty = shared.quantity;
  res.status(failed.length && !added.length ? 500 : 200).json({
    message: failed.length
      ? `Added ${added.length} of ${card_ids.length} cards; ${failed.length} failed.`
      : `Added ${added.length} card${added.length === 1 ? '' : 's'}${qty > 1 ? ` (x${qty} each)` : ''} to collection.`,
    added: added.length,
    failed
  });
});

// 4. Update Collection Entry
router.put('/collection/:id', async (req, res) => {
  const { id } = req.params;
  const {
    quantity, condition, printing, purchase_price,
    location_id, compartment_id, list_type, is_trade, favorite, notes
  } = req.body;

  try {
    const requestedQty = quantity !== undefined
      ? positiveInteger(quantity, { name: 'quantity', max: 1000 })
      : 1;

    // The whole edit is one transaction. Placement resolution, the column
    // update, both rebalances and the auto-split inserts are steps of a single
    // logical mutation; running them as independent statements meant a failure
    // in any later step left the earlier ones committed. Capacity is also read
    // inside the transaction, which is what makes the check-then-write pair
    // atomic against a concurrent request (PR 6A uses BEGIN IMMEDIATE, so
    // transactions serialize and the loser observes the winner's rows).
    const outcome = await db.withTransaction(async (tx) => {
      const entry = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!entry) throw new InvariantError(404, 'Collection entry not found', 'ENTRY_NOT_FOUND');

      const isMoving = location_id !== undefined && location_id !== entry.location_id;
      let finalCompartmentId = entry.compartment_id;
      let finalLocationId = entry.location_id;
      let finalPosition = entry.position;
      let resolvedFull = false;
      let resolvedRejected = false;
      let targetCompartment = null;

      if (isMoving) {
        if (location_id === null || location_id === '') {
          finalLocationId = null;
          finalCompartmentId = null;
          finalPosition = 0;
        } else {
          // Authorize the destination before asking the placement engine to
          // find a slot in it.
          await requireOwnedLocation(tx, location_id, req.user.id);
          const resolved = (await resolveCompartmentAndPosition({
            dbClient: tx,
            locationId: location_id,
            userId: req.user.id,
            cardId: entry.card_id,
            printing: printing !== undefined ? printing : entry.printing
          })) || { compartment_id: null, position: 0, full: true };
          finalCompartmentId = resolved.compartment_id;
          finalLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;
          finalPosition = resolved.position;
          resolvedFull = !!resolved.full;
          resolvedRejected = !!resolved.rejected;
          if (finalCompartmentId) {
            targetCompartment = await requireOwnedCompartment(tx, finalCompartmentId, req.user.id);
          }
        }
      } else if (compartment_id !== undefined) {
        // A bare compartment_id from the body is attacker-controlled. Resolve it
        // through the ownership check and adopt its true parent location rather
        // than trusting the pair the client sent.
        if (compartment_id === null || compartment_id === '') {
          finalCompartmentId = null;
          finalLocationId = null;
          finalPosition = 0;
        } else {
          targetCompartment = await requireOwnedCompartment(tx, compartment_id, req.user.id);
          finalCompartmentId = targetCompartment.id;
          finalLocationId = targetCompartment.location_id;
        }
      } else if (finalCompartmentId) {
        targetCompartment = await requireOwnedCompartment(tx, finalCompartmentId, req.user.id);
      }

      // Reserve every slot this request will consume, up front, before any
      // write. `requestedQty` copies land in the destination; the edited row
      // itself is excluded from the occupancy count when it already sits there,
      // otherwise moving a card into its own compartment would count it twice.
      if (targetCompartment) {
        await assertCapacityFor(tx, targetCompartment, requestedQty, { excludeEntryId: entry.id });
      }

      const updates = [];
      const params = [];

      // One physical card = one row. The edited entry always stays quantity 1;
      // a quantity > 1 in the payload means "make this many copies" and is
      // fulfilled below by inserting extra single-card rows (auto-split).
      if (quantity !== undefined) { updates.push('quantity = ?'); params.push(1); }
      if (condition !== undefined) { updates.push('condition = ?'); params.push(condition); }
      // Both finish columns move together or neither does. Writing only the
      // display mirror here would leave `finish` -- the value deck identity
      // matches on -- describing the card the user just said it is not.
      if (printing !== undefined || req.body.finish !== undefined) {
        const columns = finishColumnsFromBody({ printing, finish: req.body.finish });
        updates.push('printing = ?', 'finish = ?');
        params.push(columns.printing, columns.finish);
      }

      if (purchase_price !== undefined) { updates.push('purchase_price = ?'); params.push(purchase_price); }
      if (isMoving || compartment_id !== undefined) {
        updates.push('location_id = ?', 'compartment_id = ?', 'position = ?');
        params.push(finalLocationId, finalCompartmentId, finalPosition);
      }
      if (list_type !== undefined) { updates.push('list_type = ?'); params.push(list_type); }
      if (is_trade !== undefined) { updates.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
      if (favorite !== undefined) { updates.push('favorite = ?'); params.push(favorite ? 1 : 0); }
      if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }

      if (updates.length > 0) {
        params.push(id, req.user.id);
        await tx.run(`UPDATE collection SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
      }

      if (isMoving && finalCompartmentId && finalLocationId) {
        const loc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [finalLocationId, req.user.id]);
        if (loc) await rebalanceCompartmentByScheme(tx, finalCompartmentId, loc.sort_order, loc.foil_sorting);
      }
      if (isMoving && entry.compartment_id && entry.compartment_id !== finalCompartmentId) {
        const oldLoc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [entry.location_id, req.user.id]);
        if (oldLoc) await rebalanceCompartmentByScheme(tx, entry.compartment_id, oldLoc.sort_order, oldLoc.foil_sorting);
      }

      // Auto-split: create the extra copies as their own single-card rows, mirroring
      // the edited entry's final placement so each copy occupies its own slot.
      if (requestedQty > 1) {
        const row = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (row) {
          for (let i = 1; i < requestedQty; i++) {
            await tx.run(`
              INSERT INTO collection (
                card_id, user_id, quantity, condition, printing, finish, purchase_price,
                location_id, compartment_id, position, is_trade, favorite, list_type
              ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              row.card_id, req.user.id, row.condition, row.printing, row.finish, row.purchase_price,
              row.location_id, row.compartment_id, (row.position || 0) + i * 0.001, row.is_trade, row.favorite, row.list_type
            ]);
          }
          if (row.compartment_id && row.location_id) {
            const loc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [row.location_id, req.user.id]);
            if (loc) await rebalanceCompartmentByScheme(tx, row.compartment_id, loc.sort_order, loc.foil_sorting);
          }
        }
      }

      const finalPlacement = isMoving && finalCompartmentId ? await describePlacement(tx, id, req.user.id) : null;
      return { placement: finalPlacement, container_full: resolvedFull, rule_rejected: resolvedRejected };
    });

    res.json({ message: 'Collection entry updated successfully', ...outcome });
  } catch (error) {
    if (error instanceof RequestBoundsError || error instanceof InvariantError || error instanceof FinishError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// 4b. Manual tap-to-place (Custom order)
router.post('/collection/:id/place', async (req, res) => {
  const { id } = req.params;
  const { compartment_id, slot, swap_with } = req.body;
  try {
    // Manual placement moves one or two physical cards between slots. Both the
    // swap and the single-place branch are multi-statement, so the whole handler
    // runs in one transaction: a swap that updated one card and then failed left
    // two cards occupying the same slot.
    const result = await db.withTransaction(async (tx) => {
      const entry = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!entry) throw new InvariantError(404, 'Collection entry not found', 'ENTRY_NOT_FOUND');

      const comp = await requireOwnedCompartment(tx, compartment_id, req.user.id);
      if (comp.sort_order !== 'custom') {
        throw new InvariantError(400, 'Manual placement is only available in Custom order', 'NOT_CUSTOM_ORDER');
      }

      const isBinder = isBinderType(comp.loc_type);

      if (swap_with) {
        const other = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [swap_with, req.user.id]);
        if (!other) throw new InvariantError(400, 'Swap target not found', 'SWAP_TARGET_NOT_FOUND');
        // A swap exchanges two existing placements, so it is capacity-neutral
        // and needs no reservation -- but the target's compartment must still
        // belong to the caller, or a swap becomes a way to write an arbitrary
        // compartment_id onto one's own row.
        if (other.compartment_id) {
          await requireOwnedCompartment(tx, other.compartment_id, req.user.id);
        }
        await tx.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [other.compartment_id, other.location_id, other.position, id, req.user.id]);
        await tx.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [entry.compartment_id, entry.location_id, entry.position, swap_with, req.user.id]);
        return { message: 'Cards swapped', placement: await describePlacement(tx, id, req.user.id) };
      }

      if (!Number.isInteger(slot) || slot < 1) {
        throw new InvariantError(400, 'Invalid slot', 'INVALID_SLOT');
      }

      // Only an incoming card consumes a slot; repositioning within the same
      // compartment does not. Capacity is read inside the transaction so a
      // concurrent add cannot claim the same last slot.
      //
      // Reserve the row's ACTUAL quantity, not a hardcoded 1. Occupancy is
      // defined as SUM(quantity) (see compartmentOccupancy), but this call site
      // reserved a single slot regardless of how many copies the row carried.
      // The UPDATE below moves the WHOLE row, so a stacked entry of quantity 3
      // consumed three slots while reserving one -- the compartment ends up
      // holding more cards than its capacity permits, and every later guard
      // then compares against a capacity the database has already violated.
      // Bindarr's normal path keeps one card per row, which is exactly why no
      // test caught this: stacked rows arrive from legacy data and imports, so
      // the defect is invisible until it hits precisely the data it corrupts.
      if (entry.compartment_id !== comp.id) {
        await assertCapacityFor(tx, comp, entry.quantity || 1, { excludeEntryId: entry.id });
      }

      const sourceComp = entry.compartment_id;
      if (isBinder) {
        await tx.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [comp.id, comp.loc_id, slot * 1000, id, req.user.id]);
      } else {
        await tx.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [comp.id, comp.loc_id, slot * 1000 - 500, id, req.user.id]);
        await rebalanceCompartmentByScheme(tx, comp.id, 'custom', null);
      }

      if (sourceComp && sourceComp !== comp.id) {
        const src = await tx.get(`SELECT l.type AS loc_type FROM compartments c JOIN locations l ON c.location_id = l.id WHERE c.id = ?`, [sourceComp]);
        if (src && !isBinderType(src.loc_type)) {
          await rebalanceCompartmentByScheme(tx, sourceComp, 'custom', null);
        }
      }

      return { message: 'Card placed', placement: await describePlacement(tx, id, req.user.id) };
    });

    res.json(result);
  } catch (error) {
    if (error instanceof RequestBoundsError || error instanceof InvariantError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to place card' });
  }
});

// 5. Delete Card from Collection
router.delete('/collection/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }
    res.json({ message: 'Card removed from collection' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card' });
  }
});

// 5b. Bulk actions
const BULK_ACTIONS = ['delete', 'move', 'trade', 'untrade', 'list_type', 'condition', 'printing', 'purchase_split', 'add_to_deck'];
// Allowed field values mirror the collection table CHECK constraints in db.js.
// Finish values are NOT listed here: utils/finishes.js owns that vocabulary, so
// there is one place to change when Magic gains a finish rather than a list per
// route that silently goes stale.
const BULK_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
router.post('/collection/bulk', async (req, res) => {
  // `confirm` applies ONLY to add_to_deck: it is the user having seen the
  // pre-flight report and chosen to proceed with the applicable part of their
  // selection. Every other bulk action ignores it.
  const { entry_ids = [], action, value, confirm = false } = req.body;
  let ids;
  try {
    ids = uniqueIntegerIds(entry_ids, { name: 'entry_ids', maxLength: 1000 });
  } catch (error) {
    if (error instanceof RequestBoundsError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
  if (!BULK_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const placeholders = ids.map(() => '?').join(',');

  try {
    if (action === 'add_to_deck') {
      const deckId = parseInt(value, 10);
      if (!deckId) return res.status(400).json({ error: 'Invalid deck_id' });
      // The deck's FORMAT is read, not just its existence. This route writes
      // deck requirements, so it is subject to the Commander singleton rule
      // like every other write path, and the rule is gated on format.
      const deck = await db.get(`SELECT id, format FROM decks WHERE id = ? AND user_id = ?`, [deckId, req.user.id]);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });

      // Group by the EXACT variant, not by card_id.
      //
      // This path is "add these cards I am looking at to a deck", and under
      // exact-only identity the selected collection rows already state their
      // own printing and finish -- so the requirement can be created without
      // ever guessing. Grouping by card_id alone would merge a nonfoil and a
      // foil copy into one requirement and silently drop one of the two
      // finishes the user actually selected.
      const rows = await db.all(
        `SELECT c.card_id, c.finish, cc.oracle_id, SUM(c.quantity) AS total_qty
         FROM collection c
         JOIN card_cache cc ON c.card_id = cc.id
         WHERE c.id IN (${placeholders}) AND c.user_id = ?
         GROUP BY c.card_id, c.finish, cc.oracle_id`,
        [...ids, req.user.id]
      );

      let added = 0;
      const skipped = [];

      // VALIDATE THE WHOLE SELECTION BEFORE WRITING ANY OF IT.
      //
      // Zach, 2026-08-18: "if its taking in a list it should verify the list
      // before adding and giving you errors if the list has issues like
      // duplicates or something."
      //
      // This replaces an earlier report-and-skip: the batch applied what it
      // could and named the refusals afterwards. That was not wrong about the
      // deck -- the rows always came out legal -- but it was wrong about the
      // USER, who discovered the problem only once part of their selection had
      // already been written, and could not tell which part.
      //
      // So this behaves like the import pre-flight, and it does so by CALLING
      // it rather than by growing a second copy: commanderRules.preflightDeckAdds
      // is the one implementation of "judge these many candidates against one
      // snapshot". One rule, one implementation, no drift.
      //
      // `confirm` is the user having SEEN the report and chosen to proceed --
      // the same shape as the import compare screen's apply step. Refused
      // cards are still named in that case, never silently dropped.
      const candidates = rows
        .filter(row => row.oracle_id)
        .map(row => ({ card_id: row.card_id, finish: row.finish, quantity: row.total_qty }));
      for (const row of rows) {
        if (!row.oracle_id) skipped.push(`${row.card_id} is missing Oracle identity`);
      }

      const preflight = await commanderRules.preflightDeckAdds(db, deck, candidates);
      const problems = [
        ...skipped.map(message => ({ code: 'CARD_UNKNOWN', message })),
        ...preflight.problems
      ];

      if (problems.length > 0 && !confirm) {
        // NOTHING HAS BEEN WRITTEN. This is a report, not a failure: the user
        // is being shown what will happen before it happens, and may send the
        // same request back with confirm:true to apply the rest.
        return res.status(409).json({
          error: problems[0].message,
          code: 'BULK_ADD_PREFLIGHT',
          problems,
          applicable: preflight.applicable,
          message: `${preflight.applicable} card(s) can be added; `
            + `${problems.length} cannot. Nothing has been added yet.`
        });
      }

      // One transaction for the whole batch: a partial add leaves the deck in a
      // state the user never asked for and cannot tell apart from success.
      await db.withTransaction(async (tx) => {
        for (const candidate of preflight.accepted) {
          const source = rows.find(
            r => r.card_id === candidate.card_id && r.finish === candidate.finish
          );
          const existing = await tx.get(
            `SELECT quantity FROM deck_cards
             WHERE deck_id = ? AND desired_card_id = ? AND desired_finish = ? AND board = 'mainboard'`,
            [deckId, candidate.card_id, candidate.finish]
          );
          const newQty = (existing ? existing.quantity : 0) + candidate.quantity;
          // Still written through commanderRules.writeDeckCard, the single
          // choke point every deck_cards write passes through. The pre-flight
          // above should mean this never refuses -- and that is exactly why it
          // stays. If the two ever disagree, the write throws and the whole
          // batch rolls back, rather than the deck quietly absorbing the
          // disagreement.
          await commanderRules.writeDeckCard(tx, deck, {
            oracle_id: source.oracle_id,
            desired_card_id: candidate.card_id,
            desired_finish: candidate.finish,
            board: 'mainboard',
            quantity: newQty
          });
          added += candidate.quantity;
        }
      });

      // Ownership is no longer a gate here (PR 6C requirement 5): adding a card
      // to a deck is a planning action and never fails on inventory. Shortfalls
      // surface as warnings on the deck view, and checkout is where physical
      // availability is actually enforced.
      const msg = problems.length
        ? `Added ${added} card(s). ${problems[0].message}`
        : `Added ${added} card(s) to deck`;
      return res.json({
        message: msg, affected: added, rejected: problems.length, problems
      });

    }

    if (action === 'delete') {
      const result = await db.run(`DELETE FROM collection WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, req.user.id]);
      return res.json({ message: `Deleted ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'trade' || action === 'untrade') {
      const result = await db.run(`UPDATE collection SET is_trade = ? WHERE id IN (${placeholders}) AND user_id = ?`, [action === 'trade' ? 1 : 0, ...ids, req.user.id]);
      return res.json({ message: `Updated ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'list_type') {
      if (!['collection', 'wishlist'].includes(value)) return res.status(400).json({ error: 'Invalid list_type' });
      const result = await db.run(`UPDATE collection SET list_type = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Moved ${result.changes} card(s) to ${value}`, affected: result.changes });
    }

    if (action === 'condition' || action === 'printing') {
      if (action === 'condition') {
        if (!BULK_CONDITIONS.includes(value)) return res.status(400).json({ error: 'Invalid condition' });
        const result = await db.run(
          `UPDATE collection SET condition = ? WHERE id IN (${placeholders}) AND user_id = ?`,
          [value, ...ids, req.user.id]
        );
        return res.json({ message: `Set condition on ${result.changes} card(s)`, affected: result.changes });
      }

      // Changing the finish in bulk must move BOTH columns together.
      //
      // This previously wrote only `printing`, the display mirror, leaving
      // `finish` untouched. Since deck identity matches on `finish`, a user who
      // bulk-marked a stack as Foil would see foil badges in the collection
      // while every deck still treated those cards as nonfoil -- two screens,
      // two answers, and no error anywhere. The whitelist is gone with it: the
      // finish module is the one place that decides what a finish may be.
      let finish;
      let printing;
      try {
        ({ finish, printing } = finishColumnsFromBody({ printing: value }));
      } catch (error) {
        if (error instanceof FinishError) return res.status(400).json({ error: error.message });
        throw error;
      }
      const result = await db.run(
        `UPDATE collection SET printing = ?, finish = ? WHERE id IN (${placeholders}) AND user_id = ?`,
        [printing, finish, ...ids, req.user.id]
      );
      return res.json({ message: `Set printing on ${result.changes} card(s)`, affected: result.changes });
    }

    // Distribute a total price paid (a pack/deck) across the selected entries,
    // writing each entry's per-card purchase_price. method 'weighted' splits
    // proportional to market value (price_trend); 'equal' splits evenly. Weighted
    // falls back to equal when no selected card has a market price.
    if (action === 'purchase_split') {
      const total = parseFloat(value && value.total);
      const method = value && value.method === 'equal' ? 'equal' : 'weighted';
      if (!(total >= 0)) return res.status(400).json({ error: 'total must be a non-negative number' });
      const rows = await db.all(
        `SELECT c.id, COALESCE(cc.price_trend, 0) AS price FROM collection c
         LEFT JOIN card_cache cc ON cc.id = c.card_id
         WHERE c.id IN (${placeholders}) AND c.user_id = ?`,
        [...ids, req.user.id]
      );
      if (rows.length === 0) return res.status(400).json({ error: 'No valid entries' });
      const sum = rows.reduce((s, r) => s + (r.price || 0), 0);
      const weighted = method === 'weighted' && sum > 0;
      const shares = splitPrice(rows.map(r => r.price || 0), total, method);
      for (let i = 0; i < rows.length; i++) {
        await db.run(`UPDATE collection SET purchase_price = ? WHERE id = ? AND user_id = ?`, [shares[i], rows[i].id, req.user.id]);
      }
      return res.json({ message: `Split $${total.toFixed(2)} across ${rows.length} card(s) (${weighted ? 'by value' : 'evenly'})`, affected: rows.length });
    }

    const locationId = value ? parseInt(value, 10) : null;
    // The whole batch is one transaction: a bulk move either relocates every
    // selected entry or none of them. The previous per-entry loop could report
    // "Moved 3 card(s)" after failing on the fourth, leaving the user with a
    // split selection they could not identify or undo.
    const moved = await db.withTransaction(async (tx) => {
      if (locationId) {
        await requireOwnedLocation(tx, locationId, req.user.id);
      }
      let count = 0;
      const touched = new Map();
      for (const id of ids) {
        const entry = await tx.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (!entry) continue;
        if (!locationId) {
          await tx.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [id, req.user.id]);
          count++;
          continue;
        }
        const resolved = (await resolveCompartmentAndPosition({
          dbClient: tx, locationId, userId: req.user.id, cardId: entry.card_id, printing: entry.printing
        })) || { compartment_id: null, position: 0, full: true };
        const finalLoc = resolved.compartment_id ? (resolved.location_id ?? locationId) : null;
        // Each entry claims its slot against the state produced by the earlier
        // entries in this same batch, because the reads run inside the
        // transaction. Exceeding capacity aborts the whole batch.
        if (resolved.compartment_id) {
          const compartment = await requireOwnedCompartment(tx, resolved.compartment_id, req.user.id);
          // Reserve the row's real quantity: the UPDATE below relocates the
          // whole row, so a stacked entry consumes that many slots.
          await assertCapacityFor(tx, compartment, entry.quantity || 1, { excludeEntryId: entry.id });
        } else {
          // No slot could be found for this entry. Refusing here is what makes
          // the operation all-or-nothing rather than silently partial.
          throw new InvariantError(400, 'COMPARTMENT_FULL', 'COMPARTMENT_FULL');
        }
        await tx.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [finalLoc, resolved.compartment_id, resolved.position, id, req.user.id]);
        touched.set(resolved.compartment_id, finalLoc);
        count++;
      }
      for (const [compId, locId] of touched) {
        const rbLoc = await tx.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [locId, req.user.id]);
        if (rbLoc) await rebalanceCompartmentByScheme(tx, compId, rbLoc.sort_order, rbLoc.foil_sorting);
      }
      return count;
    });
    return res.json({ message: `Moved ${moved} card(s)`, affected: moved });
  } catch (error) {
    if (error instanceof RequestBoundsError || error instanceof InvariantError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

// Saved Filter Presets
router.get('/collection/filters/presets', async (req, res) => {
  try {
    const presets = await db.all(
      `SELECT * FROM saved_filter_presets WHERE user_id = ? ORDER BY name ASC`,
      [req.user.id]
    );
    res.json({ presets });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch filter presets', message: error.message });
  }
});

router.post('/collection/filters/presets', async (req, res) => {
  const { name, filter_config, sort_config, is_default = 0 } = req.body;
  if (!name || !filter_config) {
    return res.status(400).json({ error: 'Preset name and filter_config are required' });
  }

  try {
    const result = await db.run(
      `INSERT INTO saved_filter_presets (user_id, name, filter_config, sort_config, is_default)
       VALUES (?, ?, ?, ?, ?)`,
      [
        req.user.id,
        name.trim(),
        typeof filter_config === 'string' ? filter_config : JSON.stringify(filter_config),
        typeof sort_config === 'string' ? sort_config : JSON.stringify(sort_config || []),
        is_default ? 1 : 0
      ]
    );
    res.status(201).json({ success: true, id: result.lastID });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save filter preset', message: error.message });
  }
});

router.delete('/collection/filters/presets/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM saved_filter_presets WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Filter preset not found' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete filter preset', message: error.message });
  }
});

module.exports = router;
