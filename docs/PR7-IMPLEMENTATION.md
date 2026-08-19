# PR 7 — Buylist / export: implementation notes

Companion to `docs/PR7-BUYLIST.md` (the spec, which governs). This records what
was built, and the findings for the three verification items the spec asked for.

---

## The buylist

`GET /api/decks/:id/buylist`, backed by `deckIdentity.buylistForDeck()`.

The rule, stated once and only once: a buylist line is an EXACT
(printing, finish) shortfall, computed AFTER every other saved deck's
reservations. It reuses `availabilityForDeck()` — the PR 6G cross-deck
arithmetic — rather than reimplementing it, so the number on the buylist and
the red "Missing" badge on the same screen cannot disagree.

Aggregation is keyed on `(desired_card_id, desired_finish)`. Owning a different
printing of the same card does not reduce a line, and two printings never merge.
**This is deliberately the opposite of the text-import rule** and both are
right, because they answer different questions:

| | question | printing |
|---|---|---|
| Import | which of my physical cards fills this slot? | any owned one will do |
| Buylist | which card am I buying? | the printing IS the decision — a price decision |

The asymmetry is documented at both call sites so a future reader does not
"fix" it into an inconsistency.

Considering entries are excluded from the buylist and returned separately, at
the quantity he would need if he committed to them. Consistent with the settled
rule that considering never reserves and is not part of the deck.

Export is unchanged and still lists every planned card including missing ones.
The two outputs are separate on purpose: an export says what the deck IS, a
buylist says what the gap is.

### The copied text names the printing

The buylist text was previously bare names (`3 Sol Ring`). Pasted into a shop's
mass-entry box, that lets the shop choose the printing — silently spending money
on an object he did not pick. Lines are now
`3 Sol Ring (CMM) 410 *F*`, which is the form the import parser already
round-trips, so a buylist pasted back into Bindarr reproduces the exact
requirements it came from.

---

## Findings

### H1 — owned rows survive an upstream disappearance: CONFIRMED BY DESIGN

Proven by `F6I-TC8` in `backend/test/catalogue-refresh-honesty.test.js`: a real
refresh whose bulk data omits a card that is both owned and in a deck. The row
survives with its identifying data intact, quantities unchanged, and nothing is
orphaned.

It is by DESIGN, not luck. `applyStaged()` is `INSERT OR REPLACE` per row with
no delete pass, and `collection.card_id` / `deck_cards.desired_card_id` are
enforced foreign keys into `card_cache`. Verified by mutation: adding a
`DELETE FROM card_cache WHERE id NOT IN (staging)` to the apply step does not
quietly lose data — it fails hard with a FOREIGN KEY constraint error. The
schema makes the data loss unreachable rather than merely unperformed.

### G1 — finish picker: WAS BROKEN, NOW FIXED

`getPrintings()` returned all three finishes unconditionally, so every
collection-add surface (search, scanner, card inspector) offered Foil and
Etched for cards that were never printed that way. Recording a card that does
not exist is bad on its own; since this PR it would flow straight onto a buylist
as an instruction to buy an object no shop can sell.

`getPrintings(finishes)` now filters to the printing's own Scryfall `finishes`
array, and the three call sites pass it. `GET /api/collection` did not select
`cc.finishes`, so it is now included.

Fallback is permissive on purpose: an absent or empty list means "no finish data
for this card", not "this card has no finishes". A thin cache row must not make
a card unaddable — turning a data gap into a dead end is worse than the
over-offering being fixed. `CardEntryFields` also resets its selection when the
current value is not among the offered ones, so the dropdown and the value about
to be submitted cannot disagree.

### Price freshness — NOT the defect it looked like; NO fix applied

The PR 6H reviewer's observation is factually right: `applyStaged()` stamps
`last_updated = CURRENT_TIMESTAMP` on every row, which permanently satisfies the
3-day check at `scryfallApi.js:477`. But that check does not gate the price
sweep. Tracing both paths:

* `scryfallApi.js:477` gates only an **opportunistic background top-up** of rows
  returned by a local search. Suppressing it is harmless and arguably correct —
  a nightly catalogue refresh writes prices from the same Scryfall bulk data, so
  the rows genuinely are fresh when it is skipped.
* The **real price sweep** is `updateCollectionPrices()`, gated by
  `shouldSweepPrices()`, which reads `app_settings.<game>_prices_swept_at` — a
  column the catalogue refresh never touches. It runs daily via `setInterval`
  with `force = true`, plus a catch-up 30s after startup.

So prices do not stop refreshing. The catalogue refresh and the price sweep are
independent, and the sweep's own bookkeeping is unaffected. **No change made** —
there is no defect here, and inventing churn against a correct mechanism is its
own risk.

Worth Zach's eye: the two mechanisms both write prices into `card_cache`, from
different Scryfall endpoints on different schedules. That is not currently wrong,
but it is the kind of overlap worth knowing about before per-printing price
display (the flagged follow-up) is built on top of it.

---

## Also in this PR

* **Deck Health moved above Add Cards / Browse Collection.** Placement only —
  same markup, same styling, same content. On a phone the panel saying what is
  wrong now comes before the tool for fixing it.
* **`MissingCardsPanel` extracted** as its own component, with its display rules
  in `missingCards.js` as pure, directly testable functions. Built there rather
  than grown inside `DeckBuilder.jsx`, per the plan's standing advice. The
  surrounding deck screen is untouched.
* **E2E case-count regex hardened** to `/PASS: F[A-Z0-9]+-TC[A-Za-z0-9]+/`.
  The old pattern silently failed to count any id containing a letter, so eleven
  PR 6I tests ran and passed while reporting as zero. Exit codes were always
  correct; only the tally people quote was wrong.

## Not built, deliberately

Per-printing price display in the printing picker. Flagged in the spec as a
likely follow-up and explicitly not this PR without asking. It is a real
question — if he is choosing printings on price, the moment he picks is the
moment he needs to see cost — but it needs its own decision about which price
and how fresh.
