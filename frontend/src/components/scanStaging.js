// The scan staging session: cards scanned but NOT yet added to the collection.
//
// WHY THIS EXISTS. Zach: "instead of auto putting in my collection. Just putting
// aside and at the end letting me add all. That way I can ensure no weirdness
// occurred or ensure there isn't any dupes."
//
// Same controller shape as scanReviewQueue.js, and for the same two reasons:
//
// 1. CameraScanner.jsx is ~2800 lines and nothing in this repo runs a browser,
//    so logic living inside it cannot be tested. The rules that protect the
//    collection belong somewhere a test can drive them.
//
// 2. THE SERVER IS THE SOURCE OF TRUTH, ALWAYS. The session lives in
//    `scan_staging`, not in React state. Zach scans stacks of hundreds on a
//    phone; a backgrounded Safari tab, a locked screen, a dropped connection or
//    an accidental reload must not lose the pile. So this controller never
//    invents contents: every mutation is followed by a re-read, and `entries` is
//    only ever whatever the last GET returned. A local mirror would drift, and a
//    drifted session is indistinguishable from a lost one — which for a stack of
//    physical cards already put away is unrecoverable.
//
// WHAT THIS DELIBERATELY DOES NOT DO: decide whether a row is a duplicate, or
// whether he already owns it. The server computes that AT STAGE TIME and stores
// it, because the answer depends on the state of the session at the moment of
// the scan. Recomputing it here, later, against a mutated session would quietly
// change what he is being told.

// UNRESOLVED ROWS FIRST, then scan order.
//
// The advisory flags (low_confidence, duplicate_in_session, already_owned) are
// gone -- Zach removed all three from evidence: duplicates only happen when he
// taps to force one, and weak matches were right in every case he saw. "The
// only cards that should stand out are the ones that unresolved."
//
// A WEAK-MATCH highlight replaces low_confidence, on Zach's terms: he accepted
// the residual risk from the ocrHint break ("I'm okay if it gets it wrong
// occasionally") and asked for a visible marker plus an override instead of a
// slower scanner. It marks a row rather than moving it.
// A match at or below this is ART THAT DID NOT REALLY IDENTIFY THE CARD.
//
// Same value the backend resolver uses (scanPrintingResolver WEAK_MATCH_INLIERS)
// so the app has ONE definition of "weak" rather than two that drift. Measured
// on the corpus: right matches run p50 74 / p90 112, and non-basic wrong matches
// top out at 48 -- so 32 sits below almost every genuine identification while
// still catching the noise-level ones.
//
// Basic lands are deliberately NOT flagged. Dozens of Mountain printings score
// 120+ against one photo of a Mountain, so a high score there says nothing about
// WHICH Mountain -- and a low score says nothing either. Flagging them would
// mark most of a land-heavy stack and train him to ignore the colour.
const WEAK_MATCH_INLIERS = 32;

const BASIC_LANDS = new Set([
  'plains', 'island', 'swamp', 'mountain', 'forest', 'wastes',
]);

function isBasicLand(name) {
  return BASIC_LANDS.has(String(name || '').toLowerCase().replace('snow-covered ', '').trim());
}

// Did the ARTWORK actually identify this card, or did the collector number carry
// it? Returns false when there is no score to judge (older rows, manual adds) --
// absence of evidence must not look like evidence of a problem.
export function isWeakMatch(entry) {
  if (!entry || entry.unresolved) return false;          // unresolved has its own treatment
  const n = entry.match_inliers;
  if (!Number.isFinite(n)) return false;
  if (isBasicLand(entry.card_name || entry.name)) return false;
  return n <= WEAK_MATCH_INLIERS;
}

export function sortForReview(entries) {
  // STRICTLY MOST-RECENT-FIRST. NOTHING FLOATS.
  //
  // Zach, twice, and the second time was a correction of what I built:
  //   "Can we order the scanned badge list by most recent scanned first"
  //   "But I always want the order of the cards in the scanned to be most
  //    recent scanned first. Don't pop issues to the top"
  //
  // The first version floated unresolved rows to the top, on my reasoning that
  // rows blocking Add All should be impossible to miss. That reasoning was
  // wrong for how he actually works: he scans a card and immediately looks at
  // the top of the list to confirm it registered against the cardboard in his
  // hand. Reordering breaks that check -- the row he just created is not where
  // he is looking, and a list that rearranges itself while he works cannot be
  // trusted at a glance.
  //
  // Rows needing attention are surfaced by COLOUR (yellow outline) and by the
  // badge count, not by position. Visibility without moving anything.
  return [...entries].sort((a, b) => (b.id || 0) - (a.id || 0));
}


export function createScanStaging({ fetchImpl = fetch, onChange = () => {} } = {}) {
  // A CACHE OF THE LAST SERVER READ, never an authority. Nothing in this file
  // appends to it, splices it, or edits a row in place.
  let entries = [];
  // Counted separately from entries.length so the badge can rise the moment the
  // server says "staged", without paying a full GET (thumbnails and all) per
  // scan on a phone. refresh() reconciles it to the server's own row count.
  let stagedCount = 0;
  let unresolvedCount = 0;
  let loading = false;
  let error = null;

  const state = () => ({ entries, stagedCount, unresolvedCount, loading, error });
  const emit = () => onChange(state());

  async function readJson(res) {
    try { return await res.json(); } catch { return null; }
  }

  async function refresh() {
    loading = true; error = null; emit();
    try {
      const res = await fetchImpl('/api/scan-stage');
      const body = await readJson(res);
      if (!res.ok) throw new Error(body?.error || 'Failed to load staged scans');
      entries = Array.isArray(body?.entries) ? body.entries : [];
      stagedCount = Number.isFinite(body?.total) ? body.total : entries.length;
      unresolvedCount = Number.isFinite(body?.unresolved)
        ? body.unresolved : entries.filter(e => e.unresolved).length;
    } catch (e) {
      error = e.message;
    } finally {
      loading = false; emit();
    }
    return state();
  }

  // Stage one scanned card. Returns { ok, flag } so the scanner can show
  // straight away that a row wants a second look, without re-reading the list.
  //
  // Does NOT refresh: this runs once per scanned card in a stack of hundreds,
  // and pulling every thumbnail back each time would make scanning slower the
  // longer the session got.
  async function stage(payload) {
    try {
      const res = await fetchImpl('/api/scan-stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (!res.ok) return { ok: false, error: body?.error || 'Failed to stage card' };
      stagedCount += 1;
      emit();
      return { ok: true, name: body?.name };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function updateEntry(id, patch) {
    try {
      const res = await fetchImpl(`/api/scan-stage/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await readJson(res);
      if (!res.ok) return { ok: false, error: body?.error || 'Failed to update' };
      await refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function discardEntry(id) {
    try {
      const res = await fetchImpl(`/api/scan-stage/${id}`, { method: 'DELETE' });
      const body = await readJson(res);
      if (!res.ok) return { ok: false, error: body?.error || 'Failed to discard' };
      await refresh();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ADD ALL. The server commits every row inside one transaction, so this either
  // adds the whole session or adds nothing at all.
  //
  // ON FAILURE THE SESSION IS LEFT ALONE, and this MUST report that honestly: a
  // partial commit is the one outcome Zach cannot reconcile against a physical
  // stack he has already put away. So a failed commit refreshes rather than
  // clearing, and the caller shows the error over a session that is still there.
  async function commitAll() {
    loading = true; error = null; emit();
    try {
      const res = await fetchImpl('/api/scan-stage/commit', { method: 'POST' });
      const body = await readJson(res);
      if (!res.ok) {
        const why = body?.error || 'Failed to add staged cards';
        // Re-read FIRST, then set the error. refresh() clears `error` on entry,
        // so setting it before the read would wipe the reason and leave him
        // looking at a full session with no explanation for why nothing was
        // added — the failure mode this whole branch exists to prevent.
        await refresh();
        error = why;
        emit();
        return { ok: false, error: why, committed: 0 };
      }
      const committed = Number.isFinite(body?.committed) ? body.committed : 0;
      await refresh();
      return { ok: true, committed };
    } catch (e) {
      await refresh();
      error = e.message;
      emit();
      return { ok: false, error: e.message, committed: 0 };
    } finally {
      loading = false; emit();
    }
  }

  async function discardAll() {
    loading = true; emit();
    try {
      const res = await fetchImpl('/api/scan-stage', { method: 'DELETE' });
      const body = await readJson(res);
      if (!res.ok) {
        error = body?.error || 'Failed to clear session';
        return { ok: false, error };
      }
      await refresh();
      return { ok: true, discarded: body?.discarded || 0 };
    } catch (e) {
      error = e.message;
      return { ok: false, error: e.message };
    } finally {
      loading = false; emit();
    }
  }

  // Record that the server staged a card, WITHOUT re-reading the session.
  //
  // The scanner used to call refresh() after every scan, which pulled every
  // staged row and its thumbnail back over the network — a second round trip per
  // card that got slower as the stack grew. The badge only needs a COUNT, and
  // the server already told us the row was created in the scan response, so this
  // is bookkeeping on a fact rather than a local guess.
  //
  // refresh() still reconciles against the server whenever the review screen
  // opens, which is the only moment the contents are actually looked at.
  // `unresolved` is whether the row the server just created still needs a
  // printing chosen. Counting it locally keeps the badge honest without paying
  // a full GET (thumbnails and all) after every scan on a phone.
  function noteStaged(unresolved = false) {
    stagedCount += 1;
    if (unresolved) unresolvedCount += 1;
    emit();
  }

  // PICK THE PRINTING for a row the scanner could not resolve. `cardId` may be
  // any card in the catalogue, not only one of the offered candidates -- when
  // the matcher is wrong, restricting him to its guesses would leave the row
  // permanently stuck and blocking Add All.
  async function resolveEntry(id, cardId, patch = {}) {
    try {
      const res = await fetchImpl(`/api/scan-stage/${id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_id: cardId, ...patch }),
      });
      const body = await readJson(res);
      if (!res.ok) return { ok: false, error: body?.error || 'Failed to resolve card' };
      await refresh();
      return { ok: true, card: body?.card || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return {
    getState: state,
    refresh,
    stage,
    resolveEntry,
    noteStaged,
    updateEntry,
    discardEntry,
    commitAll,
    discardAll,
  };
}
