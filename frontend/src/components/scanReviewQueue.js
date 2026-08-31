// The scan review queue: where a scanned card goes when we do not know exactly
// which printing it is.
//
// WHY THIS IS A SEPARATE, FETCH-INJECTED CONTROLLER
//
// Two reasons, and the second is the important one.
//
// 1. CameraScanner.jsx is ~1800 lines and nothing in this repo runs a browser,
//    so logic living inside it is untestable by construction. Pulling the
//    routing decision out here means the rule that actually protects the
//    collection — only an exactly-resolved printing is added — can be driven by
//    a test instead of asserted about by grepping source. Same shape as
//    buylistSync.js.
//
// 2. THE SERVER IS THE SOURCE OF TRUTH, ALWAYS. The queue lives in
//    `scan_review_queue`, not in React state. Zach scans stacks of hundreds on
//    a phone; a backgrounded Safari tab, a dropped connection or a reload must
//    not lose the pile of pending decisions. So this controller never invents
//    queue contents: every mutation is followed by a re-read, and `entries` is
//    only ever whatever the last GET returned. A local mirror would drift, and
//    a drifted queue is indistinguishable from a lost one.
//
// WHAT THIS DELIBERATELY DOES NOT DO: decide anything about a printing. The
// catalogue is the validator (see backend/src/utils/scanPrintingResolver.js).
// This file transports decisions; it does not make them.

// The three reasons a card can be waiting, in Zach's words rather than the
// resolver's. These need DIFFERENT wording because they need different
// reactions from him: "this card prints no number" is a fact about the card and
// a rescan cannot help, whereas "could not read" might just be glare.
const REASON_TEXT = {
  unreadable: 'Could not read the collector number — pick the printing you scanned.',
  no_number: 'This card prints no collector number — pick the printing you scanned.',
  ambiguous: 'Several printings share that number — pick the one you scanned.',
};

const FALLBACK_REASON = 'Needs a printing chosen.';

export function describeReason(reason) {
  return REASON_TEXT[reason] || FALLBACK_REASON;
}

export function createScanReviewQueue({ fetchImpl = fetch, onChange = () => {} } = {}) {
  // `entries` is a CACHE OF THE LAST SERVER READ, never an authority. Nothing
  // in this file appends to it, splices it, or edits an entry in place.
  let entries = [];
  // Counted separately from `entries.length` on purpose: during scanning the
  // count must rise the moment the server says "queued", so the badge is
  // honest, without paying a full queue GET (thumbnails and all) per scan on a
  // phone. `refresh()` reconciles it to the server's own row count.
  let pendingCount = 0;
  let loading = false;
  let error = null;

  const state = () => ({ entries, pendingCount, loading, error });
  const emit = () => onChange(state());

  async function readJson(res) {
    try {
      return await res.json();
    } catch {
      return {};
    }
  }

  // Send one scanned card to the server for the add-or-queue decision.
  //
  // THIS REPLACES A DIRECT POST TO /api/collection. That old path is exactly
  // why Zach's scans landed as wrong printings: it added whatever the image
  // matcher's top candidate was, and the index is built from unique_artwork so
  // the correct printing was frequently not even a candidate. Here the server
  // adds ONLY when the OCR read narrowed the catalogue to exactly one row.
  //
  // PR 11: `titleText` is the OCR'd card TITLE, and it is now a first-class
  // identifier rather than a hint. The server resolves title+number FIRST and
  // only falls back to the CLIP `name`, so a scan whose artwork was blown out
  // by a torch reflection can still be identified. Either identifier may be
  // empty; the server refuses only when BOTH are.
  async function submitScan({ name, titleText = '', ocrText = '', crop = null, quantity = 1, printingHint = null, printing, condition, location_id, stage = false, matchInliers = null }) {
    try {
      const body = { name: name || '', title_text: titleText || '', ocr_text: ocrText || '', quantity };
      if (crop) body.crop = crop;
      // WHICH PRINTING the artwork matched, when the artwork could tell the
      // printings apart. Distinct from `printing` below, which is the FINISH
      // (nonfoil/foil/etched) — different concept, confusingly similar name.
      // The server validates this against the catalogue and ignores it unless
      // it resolves to exactly one real printing.
      // A SET-ONLY HINT IS VALID AND MUST SURVIVE. When the art cannot tell two
      // printings apart (every basic land), the scanner sends the set WITHOUT a
      // number so the collector-number read can pick within it. Requiring both
      // here silently dropped exactly the hint the ambiguous case depends on.
      if (printingHint && printingHint.set) {
        body.printing_hint = { set: printingHint.set };
        if (printingHint.number) body.printing_hint.number = printingHint.number;
      }
      // Finish is NEVER inferred from the image (plan task G2). Whatever the
      // scanner explicitly holds is passed through; nothing here reads pixels.
      if (printing !== undefined) body.printing = printing;
      if (condition !== undefined) body.condition = condition;
      if (location_id !== undefined) body.location_id = location_id;
      // STAGE INSTEAD OF ADD. The resolution is identical; only the destination
      // changes, so a resolved scan waits in the session until Zach adds it.
      if (stage) body.stage = true;
      if (Number.isFinite(matchInliers)) body.match_inliers = matchInliers;

      const res = await fetchImpl('/api/scan-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await readJson(res);

      if (!res.ok) {
        error = data.error || 'Scan could not be resolved.';
        emit();
        return { action: 'error', added: false, error };
      }

      if (data.action === 'added') {
        error = null;
        emit();
        return { action: 'added', added: true, card: data.card, entry_id: data.entry_id, ocr: data.ocr };
      }

      // STAGED: resolved to an exact printing, but NOT in the collection. It
      // waits in the session for Zach's Add All. `added` stays false so no
      // caller can mistake a staged card for an owned one.
      if (data.action === 'staged') {
        error = null;
        emit();
        return {
          action: 'staged', added: false, card: data.card,
          staged_id: data.staged_id, ocr: data.ocr,
        };
      }

      // UNRESOLVED: staged with no printing chosen. NOT in the collection.
      //
      // This used to be action 'queued', writing to a separate review queue with
      // its own screen. Zach deleted that: "get rid of the queue because having
      // the queue and scanner section seem redundant." The row now lands in the
      // same Scanned list as everything else, carrying its candidates, and Add
      // All refuses while any such row remains -- so an unidentified card cannot
      // be forgotten in a second list and can never reach the collection
      // unnoticed.
      error = null;
      emit();
      return {
        action: 'staged_unresolved',
        added: false,
        reason: data.reason,
        staged_id: data.staged_id,
        candidates: data.candidates || [],
        ocr: data.ocr,
      };
    } catch (e) {
      error = e.message || 'Scan could not be resolved.';
      emit();
      return { action: 'error', added: false, error };
    }
  }

  // THE QUEUE-READING HALF OF THIS MODULE IS GONE.
  //
  // refresh(), resolveEntry() and discardEntry() read and wrote /api/scan-queue,
  // which no longer exists. Zach deleted the review queue: "get rid of the queue
  // because having the queue and scanner section seem redundant." Unresolved
  // scans now live in scan_staging alongside resolved ones and are read,
  // resolved and discarded through the staging controller (scanStaging.js).
  //
  // What remains here is submitScan -- the SCAN endpoint client. It kept its
  // name for now because every call site uses it; the name is a leftover, not a
  // second queue.

  return {
    submitScan,
    describeReason,
    getState: state,
  };
}
