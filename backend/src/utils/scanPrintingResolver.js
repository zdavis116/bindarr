// Resolve a scanned card to an EXACT printing, or refuse and explain why.
//
// THE DESIGN CONSTRAINT THAT DECIDES THIS FILE (measured, see
// docs/PR8-COLLECTOR-NUMBER-OCR.md): the scan index is built from Scryfall's
// `unique_artwork` bulk — ONE ENTRY PER ILLUSTRATION. A C21 Sol Ring and a CMM
// Sol Ring collapse to a single index entry. In all five printing misses the
// correct printing had rank -1: it was not in the candidate list AT ALL.
//
// So OCR CANNOT re-rank scan candidates. There is nothing to re-rank. It reads
// the number and LOOKS THE PRINTING UP IN card_cache, keyed on the card NAME
// (image matching gets identity right 100% of the time) plus the number,
// narrowed by set code when legible. OCR is a CATALOGUE LOOKUP KEY, not a
// scoring signal.
//
// THE CATALOGUE IS ALSO THE VALIDATOR, and this is what makes the whole thing
// safe rather than merely careful. Benchmarking showed tesseract occasionally
// fabricates a character — reading "M1508" for "1508". That string does not
// exist in card_cache for that card, so the lookup returns ZERO printings and
// the card queues for review. A misread does not become a wrong card in the
// collection; it becomes a question. The only reads that can auto-add are ones
// that matched a real catalogue row exactly.
const db = require('../db');
const { parseCollectorStrip } = require('./collectorNumberParse');
const { normaliseTitle, bestTitleMatch } = require('./cardTitleMatch');

// Does this card's frame print a collector number in the bottom-left?
//
// MEASURED, and it corrects the spec. The spec says "pre-1996 cards carry no
// number"; I cropped and inspected every frame family in the benchmark corpus
// and the real boundary is the 2015 frame redesign. The 1993 frame (Alpha,
// Beta, Arabian Nights) AND the 2003 frame (8ED, 10E, M12) both carry only an
// artist credit and a copyright line. That is a far larger exclusion than the
// spec assumed — most of the back catalogue, not just the oldest cards.
//
// CAVEAT, AND IT IS LOAD-BEARING: card_cache has NO `frame` column and no
// release date, and the `sets` table is only populated for sets the user has
// actually browsed. So this cannot be answered reliably from local data.
//
// Rather than infer it from data that may not be there — which would mislabel
// cards whenever `sets` happened to be empty — this is used ONLY to choose the
// wording of the queue reason, never to decide whether a card is added. A
// wrong guess here costs Zach a slightly misleading label on a queue entry he
// was going to look at anyway. It can never cause a card to be added.
//
// `release_date` is consulted when present and the answer is 'unreadable' when
// it is not, because "I could not read it" is the weaker, safer claim: it does
// not assert something about the card that we cannot actually check.
const FRAME_REDESIGN_YEAR = 2015;

// BELOW THIS, AN ART MATCH IS NOISE RATHER THAN AN IDENTIFICATION.
//
// Measured on Zach's 33-scan session, ORB inliers for the top candidate:
//
//   correct identifications   47, 61, 63, 65, 68, 73, 84, 96, 98, 100, 105, 116, 126, 141
//   wrong / foil guesses       4,  7,  8,  8,  8,  9,  9, 10, 10, 10, 11, 12, 19, 23
//
// The two populations barely overlap, and 25 sits in the gap. It is deliberately
// set at the TOP of the noise band rather than the middle: the cost of calling a
// real match "weak" is only that the printed number gets consulted too, which is
// harmless when they agree. The cost of calling noise "strong" is a wrong card
// entering the collection silently, which is the failure Bindarr must not have.
const WEAK_MATCH_INLIERS = 25;

// Resolve a collector strip to exactly one real printing, or null.
//
// EVERY set candidate is tried, not just the first: parseCollectorStrip has no
// catalogue, so it returns every set-shaped token it saw, and on real scans the
// first is wrong roughly a quarter of the time ('mshen' for 'MSH*EN', artist
// names, noise). The catalogue is the judge. Exactly one hit is an answer; two
// different hits are ambiguity and must not resolve.
async function printingFromStrip(ocr) {
  const codes = ocr.setCandidates?.length ? ocr.setCandidates : (ocr.set ? [ocr.set] : []);
  const numbers = [ocr.number, ocr.numberAlt].filter(Boolean);
  const hits = [];
  for (const code of codes) {
    for (const num of numbers) {
      const hit = await printingBySetNumber(code, num);
      if (hit && !hits.some(h => h.id === hit.id)) hits.push(hit);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

function framePrintsNumber(releaseDate) {
  if (!releaseDate) return true;             // unknown -> assume readable, queue as 'unreadable'
  const year = parseInt(String(releaseDate).slice(0, 4), 10);
  if (!Number.isFinite(year)) return true;
  return year >= FRAME_REDESIGN_YEAR;
}

// The scan index and the catalogue do not agree on what a two-part card is
// CALLED, and the disagreement is not uniform. That is the whole problem.
//
// The scan index is built from Scryfall's `unique_artwork` bulk, which for any
// multi-part card carries the COMBINED "Front // Back" name. The catalogue
// (card_cache) stores the card object's OWN name, and Scryfall sets that
// differently by layout:
//
//   SPLIT / ADVENTURE / flip ('Dusk // Dawn', 'Consecrate // Consume',
//     "Obyra's Attendants // Desperate Parry") -> stored COMBINED. 916 rows in
//     the live catalogue. These match today and MUST keep matching.
//
//   TRANSFORMING DFC ('Avatar Aang // Aang, Master of Elements') -> stored as
//     the FRONT FACE ONLY: name='Avatar Aang'. These matched NOTHING, so the
//     resolver took its "not in the catalogue" branch and produced a queue
//     entry with zero candidates — an entry with nothing to tap, from which
//     the card could never be added at all.
//
// So there is no single name to look up, and no way to tell the two layouts
// apart from the name string alone: both are "A // B". The catalogue has to
// answer the question.
//
// ORDER IS LOAD-BEARING, and this is the part that must not be "simplified"
// later. The combined name is tried FIRST and the front face is a FALLBACK
// that runs ONLY when the combined name returned nothing. Two live catalogue
// rows show why: 'Bind // Liberate' and 'Smelt // Herd // Saw' each have a
// standalone row for their front face ('Bind', 'Smelt') that is a DIFFERENT
// CARD. Truncating first — or merging both result sets — would offer
// Weatherlight's 'Bind' as a printing of 'Bind // Liberate'. That is a silent
// wrong card, the exact failure this file exists to prevent, and it would look
// perfectly successful.
//
// Splitting on the FIRST ' // ' is deliberate: 'Smelt // Herd // Saw' has a
// front face of 'Smelt', not 'Smelt // Herd'.
function frontFaceName(name) {
  const i = name.indexOf(' // ');
  return i === -1 ? null : name.slice(0, i);
}

// Look up ONE printing by its printed set code and collector number.
//
// THE OCR FALLBACK. Zach: "If we have both set and number we should just use
// OCR as the fallback."
//
// WHY THIS IS SAFE, AND WHY IT IS NOT A GUESS. Every other route in this file
// identifies the CARD and then has to work out WHICH PRINTING. This one is the
// other way round: the set code and collector number printed on the card ARE the
// printing's primary key. If both are read and they resolve to exactly one row,
// there is nothing left to infer. It is a stronger identification than an art
// match, not a weaker one — the card is telling us its own catalogue address.
//
// THE FAILURE THIS FIXES. Zach's queue entries 113 and 114:
//   matched_name : ''                              (the matcher found nothing)
//   ocr_number   : '295'   ocr_set : 'msh'
//   raw          : 'L 0295 / MSH * EN % DOMENICO CAVA'
// A clean, complete, correct read of the strip. We knew exactly which printing
// it was, and it queued anyway, because add-or-queue was driven entirely by the
// art matcher and matched_name was empty. Two independent bugs were masking
// each other: the crop was cutting the strip off on the scans where the matcher
// worked, and the matcher was failing on the scans where the crop was right.
//
// EXACTLY ONE ROW OR NOTHING. A set+number pair that matches several rows (or
// none) falls straight through to the existing queue path. Nothing is added on
// a partial or ambiguous read.
async function printingBySetNumber(setCode, number) {
  if (!setCode || !number) return null;
  // Collector numbers are strings ('123a', 'A-12', 'GR1') and are printed
  // zero-padded ('0295' for #295), so compare on the numeric-stripped form as
  // well as verbatim rather than trusting one shape.
  const bare = String(number).replace(/^0+(?=\d)/, '');
  const rows = await db.all(
    `SELECT c.*, s.release_date AS release_date
       FROM card_cache c
       LEFT JOIN sets s ON s.id = c.set_id
      WHERE LOWER(c.set_id) = LOWER(?)
        AND (c.number = ? OR c.number = ?)`,
    [setCode, String(number), bare]
  );
  // Ambiguity here would mean the catalogue has two rows at one address, which
  // should not happen — but if it does, ASK rather than pick.
  return rows.length === 1 ? rows[0] : null;
}

// Look up every catalogue printing of a card by NAME.
//
// Name is the join key because image matching identifies the card reliably
// (12/12 measured) while it cannot identify the printing.
async function printingsByName(name) {
  if (!name) return [];
  // LEFT JOIN, never INNER: `sets` is only populated for sets the user has
  // browsed, so an inner join would silently drop most printings of a card and
  // make the catalogue look like it had fewer options than it does — turning
  // an 'ambiguous' into a wrong 'add'. release_date is a nice-to-have for
  // wording the queue reason; the printing rows are not.
  const lookup = (n, includeCombinedPrefix) => db.all(
    `SELECT c.*, s.release_date AS release_date
       FROM card_cache c
       LEFT JOIN sets s ON s.id = c.set_id
      WHERE LOWER(c.name) = LOWER(?)${includeCombinedPrefix ? ' OR LOWER(c.name) LIKE LOWER(?)' : ''}
      ORDER BY c.set_id, c.number`,
    includeCombinedPrefix ? [n, `${n} // %`] : [n]
  );

  // 1. The name exactly as the scan index gave it. For a split/adventure card
  //    this is the stored name and it hits directly. The ` // %` prefix arm is
  //    the pre-existing reverse case: the scan supplied a FRONT face and the
  //    catalogue stores the combined name.
  const direct = await lookup(name, true);
  if (direct.length) return direct;

  // 2. Nothing under the combined name. ONLY NOW consider the front face —
  //    the transforming-DFC case. EXACT match only, never widened with the
  //    ` // %` prefix: widening here would let a front face reach back into
  //    OTHER combined cards that share it, which is precisely the collision
  //    the ordering above is protecting against.
  const front = frontFaceName(name);
  if (!front) return direct;               // no ' // ' at all: nothing to fall back to
  return lookup(front, false);
}

// Narrow printings to those whose collector number matches the OCR read.
//
// STRING COMPARISON, NEVER NUMERIC. Scryfall collector_number values include
// '123a', 'star', 'A-12', 'GR1'. parseInt('123a') is 123 and would match the
// WRONG printing while looking perfectly successful — a silent wrong card,
// which is the failure mode this whole PR exists to prevent.
//
// The one normalisation applied is leading zeros, because cards print the
// padded form ('0263') while card_cache stores the bare one ('263'). That is a
// difference in RENDERING of the same value, not a different value.
function sameNumber(catalogueNumber, ocrNumber) {
  if (catalogueNumber == null || ocrNumber == null) return false;
  const norm = (v) => {
    const s = String(v).trim().toLowerCase();
    return /^\d+$/.test(s) ? (s.replace(/^0+/, '') || '0') : s;
  };
  return norm(catalogueNumber) === norm(ocrNumber);
}

// Rank printings with the ones Zach OWNS first — PR 6I's banding.
//
// When cataloguing he works through stacks from ONE source, so the printing he
// already owns most of is usually the one physically in his hand. That is what
// keeps "always ask" cheap: the right answer is normally the first row, so the
// common case is a single tap rather than a hunt through 30 printings.
//
// Stable: ties keep catalogue order (set, then number), so this ADDS a leading
// band and changes nothing else.
async function sortOwnedFirst(rows, userId) {
  if (!rows.length || !userId) return rows;
  const ids = rows.map(r => r.id);
  const owned = await db.all(
    `SELECT card_id, SUM(quantity) AS qty FROM collection
      WHERE user_id = ? AND list_type = 'collection'
        AND card_id IN (${ids.map(() => '?').join(',')})
      GROUP BY card_id`,
    [userId, ...ids]
  );
  const qty = new Map(owned.map(r => [r.card_id, r.qty]));
  return rows
    .map((row, i) => ({ row, i, owned: qty.get(row.id) || 0 }))
    .sort((a, b) => (b.owned - a.owned) || (a.i - b.i))
    .map(x => ({ ...x.row, owned_qty: x.owned }));
}

// Resolve the card's NAME from the OCR'd title, against the catalogue.
//
// THIS IS THE TEXT-FIRST ENTRY POINT, and it is why the artwork stopped being a
// single point of failure. Zach: "get name of card and set number and find it,
// it should be unique majority of the time."
//
// A CANDIDATE-POOL DECISION LIVES HERE and it is the load-bearing one.
//
// The obvious implementation is `SELECT name FROM card_cache` and fuzzy-match
// the read against every distinct name. That is wrong for this app in a way
// that is invisible until it hurts: the fuzzy matcher's safety depends on its
// MARGIN over the runner-up, and the runner-up gets closer the more names are
// in the pool. Against the full ~30k-name catalogue almost every read has some
// name 1-2 edits away, so the margin gate would refuse nearly everything — and
// the natural "fix" for that would be to widen the tolerance, which is exactly
// the change that starts silently recording wrong cards.
//
// So the pool is narrowed by SQL FIRST, on a prefix of the normalised read, and
// the fuzzy match only ever runs on that shortlist. The prefix is short (4
// chars) so a misread later in the name cannot exclude the right card, and the
// LIKE is anchored so SQLite can use an index if one exists.
//
// Returns the catalogue NAME (the catalogue's own spelling), or null. NULL IS A
// NORMAL AND FREQUENT OUTCOME — the caller falls back to CLIP.
const TITLE_PREFIX_LEN = 4;

async function nameFromTitle(titleText) {
  const read = normaliseTitle(titleText);
  if (read.length < TITLE_PREFIX_LEN) return null;

  // OCR frequently prepends junk from the frame's left edge ('| Skyclave
  // Relic', '( Lazav, ...'), so the read's own prefix is not reliable. Take
  // prefixes of the first TWO words to give the shortlist two chances, and let
  // the fuzzy matcher adjudicate whatever comes back.
  const words = read.split(' ').filter(w => w.length >= TITLE_PREFIX_LEN);
  const prefixes = words.slice(0, 2).map(w => w.slice(0, TITLE_PREFIX_LEN));
  if (!prefixes.length) return null;

  // Distinct names only: a card with 40 printings should occupy one slot in the
  // pool, not 40. The fuzzy matcher tolerates duplicates but the pool stays
  // small and the margin stays meaningful.
  const clauses = prefixes.map(() => `LOWER(c.name) LIKE ?`).join(' OR ');
  const rows = await db.all(
    `SELECT DISTINCT c.name FROM card_cache c WHERE ${clauses} LIMIT 500`,
    prefixes.map(p => `${p}%`)
  );
  // Also allow the prefix to appear after a leading article or mid-name, which
  // an anchored LIKE misses ('The One Ring' when the read starts 'One ').
  const extra = await db.all(
    `SELECT DISTINCT c.name FROM card_cache c WHERE ${prefixes.map(() => `LOWER(c.name) LIKE ?`).join(' OR ')} LIMIT 500`,
    prefixes.map(p => `% ${p}%`)
  );

  const pool = [...new Set([...rows, ...extra].map(r => r.name))];
  if (!pool.length) return null;

  const m = bestTitleMatch(titleText, pool);
  return m ? m.name : null;
}

// Decide what a scan should DO.
//
// Returns one of:
//   { action: 'add',   printing, ocr }              exactly one printing matched
//   { action: 'queue', reason, candidates, ocr }    anything else
//
// `action: 'add'` is reachable ONLY when a confident read narrowed the
// catalogue to exactly one row. Everything else queues. There is deliberately
// no "best guess" branch and no confidence threshold to tune: the catalogue
// either identified one printing or it did not.
//
// FINISH IS NEVER DECIDED HERE. Special treatments (surge foil, etched) share
// artwork AND collector numbers with the standard printing, so no still image
// can separate them — plan task G2 requires finish is never inferred from an
// image. Nothing in this file reads or writes a finish; the caller supplies it
// explicitly or the card queues.
//
// RESOLUTION ORDER (PR 11). The artwork is no longer the primary identifier:
//
//   1. TITLE + collector number. If the OCR'd title resolves to exactly one
//      catalogue name and the number then yields exactly one printing, that is
//      the answer — even when CLIP disagrees. CLIP is the signal that fails on
//      a glared card; the printed text is the one that survives.
//   2. The SET NARROWS ties. It never vetoes. (measured: number 12/15, set 7/15)
//   3. CLIP is the FALLBACK, used when the title is unreadable — which is
//      today's behaviour, unchanged, and still 100% on clean images.
//   4. A title matching nothing NEVER adds. The catalogue is still the validator.
async function resolveScannedPrinting({ matchedName, titleText, ocrText, userId, printingHint = null, matchInliers = null }) {
  const ocr = parseCollectorStrip(ocrText);

  // STEP 1: the title decides the card, when it can.
  //
  // `titleName` being null is the ordinary case for an old frame, a bad angle
  // or a blown-out nameplate, and it costs nothing: the CLIP name is still
  // there. This can only ever ADD an identification route, never remove one.
  const titleName = titleText ? await nameFromTitle(titleText) : null;

  // Which name do we look printings up under? The TITLE wins when it resolved,
  // because it is the signal that survives the failure mode this PR exists for.
  //
  // BUT IT ONLY WINS IF THE CATALOGUE BACKS IT. `printingsByName` is the same
  // validator every other path goes through: a title that resolves to a name
  // with no printings falls through to zero candidates and queues, exactly like
  // a number that matches nothing. Nothing is added on the strength of the
  // title alone.
  let all = [];
  let usedName = null;
  if (titleName) {
    all = await printingsByName(titleName);
    if (all.length) usedName = titleName;
  }
  // STEP 3: fall back to CLIP's name. This is the pre-PR-11 path verbatim, and
  // it must stay verbatim — 100% of clean-image identification depends on it.
  if (!all.length && matchedName) {
    all = await printingsByName(matchedName);
    if (all.length) usedName = matchedName;
  }

  // STEP 3b: THE PRINTED CATALOGUE ADDRESS, WHEN THE ART IS GUESSING.
  //
  // Zach: "For the OCR first you could use set code and set number you don't
  // need title if you have those both."
  //
  // He is right, and the measurement backs him: on his 33 real scans the
  // collector strip read 29/31, while TITLE OCR resolved 0 of 6 judged scans
  // ("SuPer poNper Serum", "| ron Strucker, Hypyg,"). The title sits on top of
  // foiled artwork in a stylised font; the number is matte black on a white
  // strip in a fixed position with a rigid, catalogue-checkable format. So the
  // "OCR first" architecture for Bindarr means SET+NUMBER first, not title
  // first — which is why this no longer waits on a title read.
  //
  // FOILS. ORB returned 8-12 inliers — noise — and named FOUR DIFFERENT wrong
  // cards across four photos of the same Evil's Thrall, while OCR read msh #128
  // correctly every time. The problem was not that the art match was weak; it
  // is that nothing downstream KNEW it was weak, so the strip's answer was
  // demoted to a tiebreak inside a candidate list built around the wrong card.
  //
  // WHAT THIS DELIBERATELY DOES NOT DO: override a STRONG art match. Zach's
  // earlier rule stands — "it should flag with the option to chose the
  // set+number" — so a confident match that disagrees with the strip still goes
  // to the review queue rather than being silently swapped. This only refuses
  // to let a guess suppress a fact.
  const artIsNoise = Number.isFinite(matchInliers) && matchInliers <= WEAK_MATCH_INLIERS;
  if (artIsNoise && ocr.number) {
    const exact = await printingFromStrip(ocr);
    if (exact && !all.some(r => r.id === exact.id)) {
      return {
        action: 'add',
        printing: exact,
        ocr,
        titleName,
        usedName: exact.name,
        resolvedBy: 'ocr-over-weak-art',
      };
    }
  }

  // Neither the title nor CLIP found a card in the catalogue.
  //
  // THE OCR FALLBACK (Zach: "If we have both set and number we should just use
  // OCR as the fallback"). Before giving up, try the card's own printed
  // catalogue address. See printingBySetNumber: when the set code AND the
  // collector number are both read and resolve to exactly ONE row, the card has
  // told us precisely which printing it is — that is a stronger identification
  // than an art match, not a weaker one, because there is nothing left to infer.
  //
  // THIS IS THE PATH THAT RESCUES QUEUE ENTRIES 113 AND 114: matched_name was
  // empty, OCR had read 'L 0295 / MSH * EN' cleanly, and the card queued anyway
  // because add-or-queue was driven entirely by the matcher.
  if (!all.length) {
    // THE OCR FALLBACK, using EVERY set code the strip offered.
    //
    // Zach: "If we have both set and number we should just use OCR as the
    // fallback", and "You should use all information possible."
    //
    // parseCollectorStrip cannot tell which token is the set — it has no
    // catalogue — so it hands back every set-shaped token it saw. Measured on 20
    // real scans the FIRST one is wrong on five: 'wml' and 'turn' came off the
    // artist line, 'mma' out of noise, 'msi' is 'MSH' misread, 'mshen' is
    // 'MSH*EN' glued together. Taking the first would have fed 'mma 213' to the
    // catalogue — and mma IS a real set, so that resolves to a REAL CARD THAT IS
    // NOT THE ONE IN HIS HAND.
    //
    // So every candidate is tried and the catalogue is the judge. The safety
    // property is unchanged and is what makes trying several safe: a candidate
    // only wins if set+number resolves to EXACTLY ONE printing, and if two
    // different candidates each resolve, that is ambiguity and it queues rather
    // than picking. More signal, not looser rules.
    if (ocr.number) {
      const codes = ocr.setCandidates?.length ? ocr.setCandidates : (ocr.set ? [ocr.set] : []);
      const numbers = [ocr.number, ocr.numberAlt].filter(Boolean);
      const hits = [];
      for (const code of codes) {
        for (const num of numbers) {
          const exact = await printingBySetNumber(code, num);
          if (exact && !hits.some(h => h.id === exact.id)) hits.push(exact);
        }
      }
      if (hits.length === 1) {
        return {
          action: 'add',
          printing: hits[0],
          ocr,
          titleName,
          usedName: hits[0].name,
          resolvedBy: 'ocr',
        };
      }
      // Two or more real printings matched different readings of the same strip.
      // That is genuinely ambiguous — offer them rather than pick.
      if (hits.length > 1) {
        return {
          action: 'queue',
          reason: 'ambiguous',
          candidates: await sortOwnedFirst(hits, userId),
          ocr,
          titleName,
          usedName,
        };
      }
    }
    // Still nothing to offer. Queues with no candidates exactly as before.
    return { action: 'queue', reason: 'unreadable', candidates: [], ocr, titleName, usedName };
  }

  const candidates = await sortOwnedFirst(all, userId);

  // DOES THE PRINTED NUMBER AGREE WITH THE ART MATCH?
  //
  // Zach scanned H.E.R.B.I.E. Scout Unit (msh #247) and the app staged Jeskai
  // Windscout (ktk #44) — two blue fliers with similar composition. The collector
  // strip said msh, nothing compared the two, and the wrong card entered staging
  // looking exactly as clean as the right ones.
  //
  // Until now the strip was only ever a FALLBACK: it ran when the matcher found
  // nothing, and never got to contradict a match the matcher was confident about.
  // So a confident wrong match was unchallengeable even though the card itself
  // was stating its own catalogue address.
  //
  // His rule, and it is better than either option I offered him:
  //
  //   "it should flag with the option to chose the set+number"
  //
  // Not an override — silently swapping one card for another is a state change
  // he cannot reconcile against a physical stack. And not a bare warning either,
  // which says something is wrong without saying what. Both readings are put in
  // front of him and he picks in one tap. That is what the review queue is FOR.
  if (ocr.number) {
    const codes = ocr.setCandidates?.length ? ocr.setCandidates : (ocr.set ? [ocr.set] : []);
    const numbers = [ocr.number, ocr.numberAlt].filter(Boolean);
    const matchedIds = new Set(all.map(r => r.id));
    const strip = [];
    for (const code of codes) {
      for (const num of numbers) {
        const hit = await printingBySetNumber(code, num);
        // Only a DISAGREEMENT matters. A strip that resolves to one of the
        // printings the matcher already offered is agreement, and agreement
        // needs no decision from him.
        if (hit && !matchedIds.has(hit.id) && !strip.some(s => s.id === hit.id)) strip.push(hit);
      }
    }
    if (strip.length === 1) {
      return {
        action: 'queue',
        reason: 'disagreement',
        // The strip's answer FIRST: it is the card telling us its own catalogue
        // address, which is stronger evidence than an art similarity score.
        candidates: [strip[0], ...candidates],
        ocr,
        titleName,
        usedName,
      };
    }
  }

  // Does this card's frame even print a number? If every printing of it
  // predates the 2015 frame there is nothing to read, and saying "unreadable"
  // would imply a better photo might help. It would not — the information is
  // physically absent from the card.
  const anyFramePrints = all.some(r => framePrintsNumber(r.release_date));

  // THE ART ALREADY DECIDED IT. Zach's rule:
  //
  //   "I'm fine if it's right card wrong printing, fix with the queue — but I
  //    would like for that to be the case only if the art isn't unique and we
  //    couldn't get set number."
  //
  // When the name resolves to exactly ONE printing in the catalogue there is no
  // ambiguity for the collector number to resolve. Nothing is being guessed:
  // this is the only printing that exists, so reading the number could not
  // change the answer, only fail to produce it.
  //
  // This ran AFTER the `ocr.confident` gate below, which meant a card with one
  // printing and an unreadable strip was queued as 'unreadable' — asking Zach
  // to choose from a list of one. Measured on his 7-scan session: every entry
  // queued with a CONFIDENT, CORRECT art match and an OCR read of '—' or ''.
  // The collector number is 6pt text at the card's edge; making the whole scan
  // depend on it put the hardest signal on the critical path, which is why the
  // scanner needed 7 attempts to add one card.
  //
  // Ordering matters and is the entire fix: uniqueness is checked BEFORE
  // legibility, so the strip is only consulted when it can actually change the
  // outcome. Multi-printing cards are untouched — they still require the number
  // and still queue without it, so no printing is ever silently guessed.
  if (all.length === 1) {
    return { action: 'add', printing: all[0], ocr, titleName, usedName };
  }

  // THE ARTWORK NAMED A SPECIFIC PRINTING — the alt-art case.
  //
  // The scan index is built per ARTWORK, so a confident match identifies one
  // printing, not just a card. Zach: "some should be auto matches like legend
  // of Roku and dai li agents because they are alt arts of the card so image
  // alone should be enough for them." He is right, and the client was throwing
  // that answer away: it sent only the NAME, so this resolver re-looked-up all
  // three printings of 'The Legend of Roku' and queued the very question the
  // matcher had already answered.
  //
  // THE HINT IS VALIDATED, NEVER TRUSTED. It must select exactly one row of the
  // printings this card actually has. A hint that matches nothing, or somehow
  // matches several, is discarded and the normal number-then-queue path runs —
  // so a stale or malformed client can widen nothing.
  //
  // The client only sends this when the ARTWORK CAN tell the printings apart.
  // Where a same-name runner-up scores nearly as well (basic lands and other
  // low-art cards, which share one frame across every printing) it withholds
  // the hint, because there the image genuinely does not identify the printing.
  // That check lives client-side because the ORB scores live there; this side
  // enforces only that whatever arrives is a real, unique printing.
  if (printingHint && printingHint.set && printingHint.number) {
    const hintSet = String(printingHint.set).toLowerCase();
    const hintNumber = String(printingHint.number);
    const hinted = all.filter(r =>
      String(r.set_id || '').toLowerCase() === hintSet && sameNumber(r.number, hintNumber));
    if (hinted.length === 1) {
      return { action: 'add', printing: hinted[0], ocr, titleName, usedName, resolvedBy: 'artwork' };
    }
  }

  // THE HINT'S SET + THE READ NUMBER. This is the basic-land case, and it is
  // the one that has been sending Zach's Forests to the queue.
  //
  // MEASURED on 22 basic lands from his real scans: the matcher identified the
  // card correctly EVERY time and OCR read the number reliably (Forest #295
  // seven times, Plains #288 five, Mountain #293 three — identical on repeats).
  // The single unreliable signal was the OCR'd SET CODE, which came back as
  // 'rvryg', 'nard', 'rrr', 'ere', 'mshen', null. So the resolver held a good
  // name, a good number and a garbage set, and refused.
  //
  // The artwork hint carries the set the MATCHER saw, which is not a guess: it
  // matched a specific catalogue row. Combining that trustworthy set with the
  // trustworthy number resolves the printing without ever consulting the one
  // signal that fails.
  //
  // SAFETY IS UNCHANGED, and rests on the same rule as every other path: this
  // only fires when set+number resolve to EXACTLY ONE printing of the card the
  // matcher already named. Two matches is ambiguity and falls through to the
  // queue; zero matches falls through as well. Nothing is added on the strength
  // of the hint alone.
  if (printingHint && printingHint.set && ocr.confident && ocr.number != null) {
    const hintSet = String(printingHint.set).toLowerCase();
    const inHintSet = all.filter(r =>
      String(r.set_id || '').toLowerCase() === hintSet && sameNumber(r.number, ocr.number));
    if (inHintSet.length === 1) {
      return {
        action: 'add',
        printing: inHintSet[0],
        ocr,
        titleName,
        usedName,
        resolvedBy: 'artwork-set+ocr-number',
      };
    }
  }

  if (!ocr.confident || ocr.number == null) {
    return {
      action: 'queue',
      reason: anyFramePrints ? 'unreadable' : 'no_number',
      candidates,
      ocr,
      titleName,
      usedName,
    };
  }

  // NUMBER FIRST. THE SET IS ONLY EVER A TIE-BREAKER.
  //
  // The primary key is the matched card NAME plus the collector NUMBER. Image
  // matching gets the name right 100% of the time and the number measured
  // 12/15; the SET measured only 7/15 on the same corpus, so it is by some way
  // the least reliable thing OCR produces here and must never be able to
  // OVERRULE the two signals that are better than it.
  //
  // Concretely, the set may do exactly one job: choose between printings that
  // the NUMBER has already matched. It may not eliminate the last candidate,
  // and it may not promote a row the number did not match.
  let byNumber = all.filter(r => sameNumber(r.number, ocr.number));

  // THE RARITY-LETTER FALLBACK IS TWO LOOKUPS AND A UNION, NOT AN ELSE-BRANCH.
  //
  // Zach's Avatar Aang read as 'M0207': the printed rarity letter glued to the
  // front of a CORRECT number. The parser deliberately does not "correct" that
  // — some cards genuinely carry letter-prefixed numbers, and rewriting one of
  // those would silently record a different printing. So the CATALOGUE decides
  // which reading was real.
  //
  // This originally ran only when the raw reading matched NOTHING, and that
  // ordering hid a silent wrong-printing bug. C1, R1, U1, P1, S1, T1 and L1 are
  // all real Scryfall collector numbers, so a card can genuinely hold BOTH a
  // rarity-shaped row ('M12') and a digits-only row ('12'). With an else-branch
  // the raw reading won and the card was ADDED as 'M12' with no question asked
  // — the exact silent wrong printing this file exists to prevent, and one Zach
  // could never reconcile against the physical card in his hand.
  //
  // So BOTH readings are looked up, always, and their results UNIONED. The
  // count then decides, exactly as it does for every other path here:
  //   only one reading is backed by the catalogue -> that reading was real
  //   both are backed                             -> genuine ambiguity, QUEUE
  //   neither                                     -> queue, as before
  //
  // Note this cannot loosen anything: `numberAlt` is null unless the reading is
  // exactly one rarity letter followed by digits, so 'GR1' (two letters) and
  // 'A-12' (not the rarity shape) still resolve only as themselves.
  if (ocr.numberAlt) {
    const byAlt = all.filter(r => sameNumber(r.number, ocr.numberAlt));
    // Union by identity, preserving catalogue order and never duplicating a row
    // that both readings happened to select.
    const seen = new Set(byNumber.map(r => r.id));
    byNumber = byNumber.concat(byAlt.filter(r => !seen.has(r.id)));
  }

  let matches = byNumber;
  if (byNumber.length > 1) {
    // EVERY SET CANDIDATE, NOT JUST THE FIRST.
    //
    // parseCollectorStrip hands back every set-shaped token it saw, in reading
    // order, precisely because it cannot tell which is the set — it has no
    // catalogue. This code was using only `ocr.set`, which is the FIRST token,
    // and throwing the rest away.
    //
    // Zach's basic land: the strip read "| ABS a / L 0295 / MSH *EN % DOMEN".
    // Candidates were ['abs', 'msh', 'domen'] — the correct 'msh' was RIGHT
    // THERE in second place, but 'abs' was tried alone, matched nothing, and
    // the card queued as ambiguous with four identical Forests to choose
    // between. Using the whole list resolves it outright.
    //
    // This cannot loosen anything. The set is still only ever a TIE-BREAKER
    // among printings the NUMBER already matched: it can neither promote a row
    // the number missed nor empty the list. If two different candidates each
    // narrow to a different printing, that is genuine ambiguity and the
    // `matches.length > 1` check below still queues it.
    const codes = ocr.setCandidates?.length
      ? ocr.setCandidates
      : (ocr.set ? [ocr.set] : []);
    const bySet = matches.filter(r => codes.includes(String(r.set_id || '').toLowerCase()));
    // A set filter that empties the list is a MISREAD, not a signal. Zach's
    // Avatar Aang read as set 'taa' when the catalogue stores 'tla' — one
    // letter. Letting that veto the candidates would discard a correct number
    // and queue a card that should have been added.
    if (bySet.length) matches = bySet;
  }

  // Zero matches means the read did not correspond to any real printing of this
  // card — the 'M1508' case from the benchmark. The catalogue caught it.
  if (matches.length === 0) {
    return { action: 'queue', reason: 'unreadable', candidates, ocr, titleName, usedName };
  }

  // Several printings share this number (different sets, or the set code was
  // not legible). Ask; do not pick the likeliest.
  if (matches.length > 1) {
    const ranked = await sortOwnedFirst(matches, userId);
    return { action: 'queue', reason: 'ambiguous', candidates: ranked, ocr, titleName, usedName };
  }

  return { action: 'add', printing: matches[0], ocr, titleName, usedName };
}

module.exports = {
  resolveScannedPrinting,
  nameFromTitle,
  printingsByName,
  sortOwnedFirst,
  sameNumber,
  framePrintsNumber,
  FRAME_REDESIGN_YEAR,
};
