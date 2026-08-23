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

// What each flag means, in Zach's terms rather than the schema's. These need
// different wording because they need different reactions: a duplicate might be
// a genuine second copy he wants, whereas a low-confidence match questions
// whether the app even identified the right card.
const FLAG_TEXT = {
  duplicate_in_session: 'Scanned twice in this session — keep both only if you have two.',
  already_owned: 'Already in your collection — this will add another copy.',
  low_confidence: 'Weak match — check this is the right card before adding.',
};

// Ordered by how much they deserve attention. low_confidence first because it
// questions the CARD; the others only say "you have one already", which is
// perfectly normal for a collection.
const FLAG_PRIORITY = { low_confidence: 0, duplicate_in_session: 1, already_owned: 2 };

export function describeFlag(flag) {
  return FLAG_TEXT[flag] || null;
}

// Flagged rows first, then scan order. THE POINT OF THE FLAGS IS THAT HE DOES
// NOT HAVE TO FIND THEM: a sixty-row list gets skimmed, so anything needing a
// second look has to be at the top rather than buried at row 47.
export function sortForReview(entries) {
  return [...entries].sort((a, b) => {
    const pa = a.flag ? FLAG_PRIORITY[a.flag] ?? 3 : 99;
    const pb = b.flag ? FLAG_PRIORITY[b.flag] ?? 3 : 99;
    if (pa !== pb) return pa - pb;
    return (a.id || 0) - (b.id || 0);   // otherwise the order he scanned in
  });
}

export function createScanStaging({ fetchImpl = fetch, onChange = () => {} } = {}) {
  // A CACHE OF THE LAST SERVER READ, never an authority. Nothing in this file
  // appends to it, splices it, or edits a row in place.
  let entries = [];
  // Counted separately from entries.length so the badge can rise the moment the
  // server says "staged", without paying a full GET (thumbnails and all) per
  // scan on a phone. refresh() reconciles it to the server's own row count.
  let stagedCount = 0;
  let flaggedCount = 0;
  let loading = false;
  let error = null;

  const state = () => ({ entries, stagedCount, flaggedCount, loading, error });
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
      flaggedCount = Number.isFinite(body?.flagged)
        ? body.flagged : entries.filter(e => e.flag).length;
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
      if (body?.flag) flaggedCount += 1;
      emit();
      return { ok: true, flag: body?.flag || null, name: body?.name };
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
  function noteStaged(flag) {
    stagedCount += 1;
    if (flag) flaggedCount += 1;
    emit();
  }

  return {
    getState: state,
    refresh,
    stage,
    noteStaged,
    updateEntry,
    discardEntry,
    commitAll,
    discardAll,
  };
}
