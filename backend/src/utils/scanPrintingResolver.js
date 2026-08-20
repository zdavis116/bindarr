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
async function resolveScannedPrinting({ matchedName, ocrText, userId }) {
  const ocr = parseCollectorStrip(ocrText);
  const all = await printingsByName(matchedName);

  // The card is not in the catalogue at all. Not a printing problem.
  if (!all.length) {
    return { action: 'queue', reason: 'unreadable', candidates: [], ocr };
  }

  const candidates = await sortOwnedFirst(all, userId);

  // Does this card's frame even print a number? If every printing of it
  // predates the 2015 frame there is nothing to read, and saying "unreadable"
  // would imply a better photo might help. It would not — the information is
  // physically absent from the card.
  const anyFramePrints = all.some(r => framePrintsNumber(r.release_date));

  if (!ocr.confident || ocr.number == null) {
    return {
      action: 'queue',
      reason: anyFramePrints ? 'unreadable' : 'no_number',
      candidates,
      ocr,
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

  // THE RARITY-LETTER FALLBACK, and it runs ONLY when the number as read
  // matched nothing at all.
  //
  // Zach's Avatar Aang read as 'M0207': the printed rarity letter glued to the
  // front of a CORRECT number. The parser deliberately does not "correct" that
  // — some cards genuinely carry letter-prefixed numbers, and rewriting one of
  // those would silently record a different printing. So the catalogue decides:
  // if the number AS READ matches no printing of this card, and the
  // rarity-stripped reading matches some, the stripped reading was the real
  // one. If both match nothing, the card queues exactly as it does today.
  //
  // This can only ever turn a QUEUE into an ADD when a real catalogue row backs
  // it. It can never change WHICH row a successful read selected, because it
  // does not run when the read already matched.
  if (!byNumber.length && ocr.numberAlt) {
    byNumber = all.filter(r => sameNumber(r.number, ocr.numberAlt));
  }

  let matches = byNumber;
  if (ocr.set && byNumber.length > 1) {
    // Only consulted when there is a genuine ambiguity to break. When the
    // number already yields exactly one printing there is nothing to
    // disambiguate, so a misread set has no way to do damage.
    const bySet = matches.filter(r => String(r.set_id || '').toLowerCase() === ocr.set);
    // A set filter that empties the list is a MISREAD, not a signal. Zach's
    // Avatar Aang read as set 'taa' when the catalogue stores 'tla' — one
    // letter. Letting that veto the candidates would discard a correct number
    // and queue a card that should have been added.
    if (bySet.length) matches = bySet;
  }

  // Zero matches means the read did not correspond to any real printing of this
  // card — the 'M1508' case from the benchmark. The catalogue caught it.
  if (matches.length === 0) {
    return { action: 'queue', reason: 'unreadable', candidates, ocr };
  }

  // Several printings share this number (different sets, or the set code was
  // not legible). Ask; do not pick the likeliest.
  if (matches.length > 1) {
    const ranked = await sortOwnedFirst(matches, userId);
    return { action: 'queue', reason: 'ambiguous', candidates: ranked, ocr };
  }

  return { action: 'add', printing: matches[0], ocr };
}

module.exports = {
  resolveScannedPrinting,
  printingsByName,
  sortOwnedFirst,
  sameNumber,
  framePrintsNumber,
  FRAME_REDESIGN_YEAR,
};
