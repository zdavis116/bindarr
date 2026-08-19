// KEEPING THE COMBINED BUYLIST HONEST WHILE IT UPDATES LIVE (PR 7B).
//
// Ticking a deck IS the instruction. There is no "Build buylist" button any
// more, so the selection itself drives the request. That turns one deliberate
// click into a stream of overlapping asynchronous reads, and streams of
// asynchronous reads have exactly two ways to lie to him:
//
//   1. THE LIST OUTLIVES ITS SELECTION. He unticks a deck, the request for the
//      smaller selection is still in flight, and the old list — including the
//      unticked deck's cards — stays on screen looking finished. He buys cards
//      for a deck he removed.
//
//   2. AN OLD ANSWER LANDS AFTER A NEW ONE. He ticks A, then B a moment later.
//      The response for [A] is slow and arrives AFTER the response for [A, B].
//      Last-write-wins on the raw fetch means the screen ends up showing A's
//      cards while both A and B are ticked. Nothing errors; the list is simply
//      a shopping list for the wrong decks.
//
// Both are the same class of defect as a wrong count: the app states something
// false about what he needs to buy, plausibly, with no visible failure. So the
// rules below are absolute rather than best-effort:
//
//   * The moment the selection changes, the previous result is DROPPED. A list
//     is only ever shown alongside the exact selection it was built from.
//   * Every request carries a generation number. A response whose generation is
//     no longer current is DISCARDED, success or failure. Late answers can
//     never repaint the screen.
//   * An EMPTY selection never reaches the network. The server refuses zero
//     decks on purpose (see routes/decks.js: "buy nothing" and "you selected
//     nothing" are different facts) and that refusal is correct for a
//     deliberate API call — but here nobody asked a question, so there is no
//     question to refuse. Unticking everything is cleared locally, quietly.
//   * Rapid ticking is DEBOUNCED, so working through a list of decks costs one
//     request at the end rather than one per checkbox.
//
// This lives outside DeckBuilder.jsx because it is the part that can be wrong
// in a way markup tests cannot see. A pure controller with an injected clock
// and an injected fetch can be driven through the exact out-of-order sequence
// above and asserted on. See buylistSync.test.js.
//
// It does NOT compute anything. The arithmetic stays on the server
// (deckIdentity.buylistForDecks); this only decides which answer is allowed to
// reach the screen.

export const BUYLIST_DEBOUNCE_MS = 300;

// A stable, order-independent identity for a selection, so re-ordered ids are
// not mistaken for a different selection.
function selectionKey(deckIds) {
  return [...(deckIds || [])].map(String).sort().join(',');
}

// fetchBuylist(deckIds) -> Promise<payload>, rejecting on failure.
// onState({ loading, buylist, error }) is called on every visible change.
//
// `error` is a one-shot signal for the caller to surface a toast; it is never a
// state the panel renders, because a failed read must leave the list absent
// (null), never empty. An empty list is the positive claim "you need nothing",
// and we cannot make that claim when we did not get an answer.
export function createBuylistSync({
  fetchBuylist,
  onState,
  delay = BUYLIST_DEBOUNCE_MS,
  // Bound to `window` deliberately. Packing bare `setTimeout`/`clearTimeout`
  // into an object means calling them as `scheduler.setTimeout(...)`, which
  // invokes them with `this === scheduler` rather than the Window. Chrome
  // tolerates that; iOS Safari enforces the spec and throws
  // "Can only call Window.setTimeout on instances of Window", which crashed
  // the whole panel the moment a deck checkbox was tapped on a phone.
  //
  // The arrow wrappers keep the injectable seam for tests while making the
  // receiver correct in a real browser. Do not "simplify" this back to
  // `{ setTimeout, clearTimeout }`.
  scheduler = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id)
  }
}) {
  // Bumped on EVERY selection change, not just on every request. A response is
  // only allowed to paint if the world has not moved on since it was asked for.
  let generation = 0;
  let timer = null;
  let lastKey = null;
  let disposed = false;

  const cancelTimer = () => {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  };

  const send = (deckIds, mine) => {
    // The request is issued SYNCHRONOUSLY when the debounce fires. Deferring it
    // by even a microtask buys nothing and widens the window in which the
    // selection can move on between "we decided to ask" and "we asked".
    let request;
    try {
      request = Promise.resolve(fetchBuylist(deckIds));
    } catch (err) {
      request = Promise.reject(err);
    }
    request
      .then(payload => {
        // STALE. Discard silently: the selection this answers no longer exists,
        // so painting it would show cards for decks that are not ticked.
        if (disposed || mine !== generation) return;
        onState({ loading: false, buylist: payload, error: null });
      })
      .catch(err => {
        if (disposed || mine !== generation) return;
        // Null, not empty — see the note on `error` above.
        onState({ loading: false, buylist: null, error: err || new Error('buylist failed') });
      });
  };

  return {
    // Call with the current selection whenever it changes. Repeated calls with
    // an unchanged selection are ignored, so an unrelated re-render cannot
    // trigger a refetch or flash the spinner.
    select(deckIds) {
      if (disposed) return;
      const key = selectionKey(deckIds);
      if (key === lastKey) return;
      lastKey = key;

      // The old result stops being true the instant the selection changes.
      generation += 1;
      cancelTimer();

      if (key === '') {
        // Nothing ticked: cleared locally, no request. Not an error, not an
        // empty result — simply nothing asked.
        onState({ loading: false, buylist: null, error: null });
        return;
      }

      // Honest loading state: the previous list is gone and the panel is
      // visibly working, so nothing on screen looks settled while it is not.
      onState({ loading: true, buylist: null, error: null });

      const mine = generation;
      timer = scheduler.setTimeout(() => {
        timer = null;
        if (disposed || mine !== generation) return;
        send([...deckIds], mine);
      }, delay);
    },

    // Leaving buylist mode. Drops the pending request and any in-flight answer.
    reset() {
      if (disposed) return;
      generation += 1;
      cancelTimer();
      lastKey = null;
      onState({ loading: false, buylist: null, error: null });
    },

    dispose() {
      disposed = true;
      cancelTimer();
    }
  };
}
