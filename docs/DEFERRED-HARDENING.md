# Bindarr — Deferred Hardening Backlog

Findings deliberately deferred to a single hardening sweep after all features
are implemented. Nothing here is a live data-loss or correctness bug affecting
Zach's own collection — those get fixed immediately, not listed here.

**Context:** Bindarr is single-user, self-hosted, tailnet-only. Cross-tenant
findings assume an attacker account that does not currently exist.

---

## Deferred: cross-tenant isolation (PR 6B, rounds 3–4)

Guards that work correctly today but have no test proving they're load-bearing.
A future refactor could remove one silently.

- [ ] Five cross-tenant guards on DELETE/mutate endpoints in `collection.js` /
      `storage.js` can be deleted with the suite green. A reviewer reproduced a
      working attack for each — but each requires a second user account.
- [ ] Mutation coverage never reached `POST /api/collection`. Same class of gap
      likely present there.
- [ ] `assertParentChild` / `requireOwnedCompartmentInLocation` is a convention,
      not structurally enforced. A future two-ID route can forget it.
      Durable fix: make the pair check impossible to bypass at the type/helper
      boundary.

## Deferred: consistency and hygiene (PR 6B, round 4)

- [ ] `collectionHelpers.js:82` uses `COUNT()` where the rest of the PR
      standardised on `SUM(quantity)`. Not exploitable today (the planner
      deflects it) but contradicts the PR's own capacity discipline.
- [ ] `collectionHelpers.js:76, 88, 107` read through the module-level `db`
      instead of the passed `dbClient`, so those reads escape the caller's
      transaction. Correct today via ambient ALS; reads as a bug.
- [ ] `resolveCompartmentAndPosition` — same ambient-db pattern, wider blast
      radius. Larger refactor than any single PR should absorb.
- [ ] `tools/mutants.js` has unexplained numbering gaps (M5–M7, M17).
      A catalogue with holes can't be trusted. Restore or document.
- [ ] Harness should distinguish guards *proven* by a killing test from guards
      merely *present*. Redundant defense-in-depth survivors (R04, R12, R15,
      R41–R43, R91/R97) are harmless but should not be described as tested.

## Deferred: coverage gaps (PR 6B, round 3)

Routes believed correct but not exercised by any invariant test:

- [ ] `DELETE /locations/:id`
- [ ] `POST /collection/:id/place` — behavior was changed during 6B; coverage
      is thinner than its risk warrants.
- [ ] `POST /locations/:id/compartments` — inherits capacity with no explicit
      validation. Single statement, so not a partial-write risk.

## Deferred: latent risks found during PR 6B (not fixed — out of scope)

- [ ] `loadCompartments(db, locationId, userId)` accepts `userId` and never uses
      it — the query filters on `location_id` alone. Nothing is broken today
      because every caller passes a pre-authorized location, but the planner's
      tenant safety rests on caller discipline rather than on the query itself.
      Recorded in the M6 mutant comment.
- [ ] The mutation harness exemption list grew from 3 to 10 entries in one
      round. Each entry carries a reproduction, but the growth is itself the
      smell: exemptions are the mechanism by which a real gap gets excused.
      Re-verify every exemption independently during the hardening sweep.

## Deferred: dependency audit

- [ ] Backend: 6 high-severity advisories
- [ ] Frontend: 10 high + 1 critical

---

## Behavior changes shipped in PR 6B (not bugs — document, don't fix)

- Reducing a compartment's capacity below its current occupancy now returns
  **400 instead of silently over-committing**. Cards are never auto-evicted;
  the user moves them out first.
- `POST /locations/:id/resort` now **refuses** when the container is over
  capacity, where it previously over-filled silently. Same "refuse, never
  evict" semantic.

## Test scope notes

- `T25` / `T33` seed cross-user contamination directly via SQL rather than
  through the API. Legitimate — that's the state the pre-PR substitution bug
  produced — but worth revisiting if these guards are ever reworked.
- Concurrency tests sample interleavings; they cannot *prove* serialization.
  The real guarantee comes from PR 6A's `BEGIN IMMEDIATE`. They guard against
  regression, not against an unseen scheduler.

---

## Deferred from PR 6C (exact-only deck identity)

Bindarr is single-user, self-hosted and tailnet-only, so these are correctness
and polish items rather than exploitable findings. Batched for the hardening
sweep after all features land.

- [ ] `collection.finish` was added with a `'nonfoil'` default so exact matching
      has a comparable field on the physical row. The legacy `collection.printing`
      column still exists alongside it. Two finish-ish columns is one too many:
      PR 9 (MTG finish model) should make `finish` authoritative and drop
      `printing`, or the two will drift.
- [ ] Scanner, manual add, CSV import and the bulk-add path do not yet let the
      user CHOOSE a finish; every row they create is `nonfoil` by default. Exact
      matching is therefore only as good as that default until PR 9 adds finish
      selection at capture time. A user with foils will see false "missing"
      counts until they correct the rows.
- [ ] `frontend/src/components/DeckBuilder.jsx` (2023 lines) is no longer routed
      and is dead code. It is retained only because PR 7 will cannibalise its
      catalog search, draw simulator and import/export UI. Delete it once PR 7
      lands rather than letting it rot as a second, wrong deck implementation.
      It is excluded from the shipped bundle (verified: no DeckBuilder chunk in
      `dist/assets`), so it costs nothing at runtime today.
- [ ] Deck routes have no per-request bound on the NUMBER of requirements a deck
      may hold; only per-requirement `quantity` is bounded (max 1000). A deck
      with 50k requirements would make `availabilityForDeck` slow, since it
      issues per-requirement queries. Single-user, so this is a self-inflicted
      performance issue rather than an availability attack, but the N+1 shape is
      worth flattening into one grouped query during the sweep.
- [ ] `deck_card_allocations` has no CHECK that the sum of allocations for a
      requirement equals the requirement's quantity. Checkout writes them
      correctly and transactionally, but the invariant is enforced by code
      rather than by the schema. A DB-level guard would make it unbreakable.

## Behavior changes shipped in PR 6C (not bugs — document, don't fix)

- Deck ownership rules changed from **blocking** to **advisory**. Adding an
  unowned card to a deck now succeeds and returns a warning, where it
  previously returned 400. Physical availability is enforced only at checkout.
- `POST /api/decks` **no longer accepts `decklist_text`**. The old importer
  resolved lines by name and took whichever printing SQLite returned first,
  which silently chose a printing and finish on the user's behalf — precisely
  what exact-only identity forbids. Name-only import returns in PR 7 behind an
  explicit review step.
- `DELETE /api/decks/:id/cards/:card_id` is now
  `DELETE /api/decks/:id/cards/:deck_card_id`. Card ID is no longer unique
  within a deck (same printing can appear on mainboard and sideboard, nonfoil
  and foil), so requirements are addressed by their own ID.
- `checkedOutAllocation` changed from **derived** to **stored**. The storage
  view's "in a deck" badge previously re-ran a greedy allocation on every page
  load and could move between identical copies; it now reads the same recorded
  rows the checkout wizard does, so the two cannot disagree.
- Marking a **checked-out** deck as `considering` is **allowed**. An earlier
  revision refused this with a 400 on the theory that parking a deck would
  release reservations for cards physically sleeved in a deck box. That theory
  was wrong: a checked-out deck's physical claim lives in
  `deck_card_allocations`, which a status edit does not touch, and checkout
  already excludes copies held by any checked-out deck. Parking is therefore a
  pure metadata change — the deck stops competing for inventory while the
  sleeves stay exactly where they are.
- `considering` **entries never reserve, at any level.** A considering entry is
  a note that the user is thinking about a card which is not physically in the
  deck, so the board alone decides it and the deck's status is irrelevant.
  Considering entries do report **live availability** (`available`,
  `quantity_available`), derived on every read from current reservation state
  and never stored. When another deck takes the last matching copy the entry is
  left untouched and simply displays as unavailable.

## Deferred: PR 6C

Found by independent review of PR 6C (exact deck identity). None of these are
data-loss or correctness defects; each is recorded here rather than fixed so the
feature layers stay reviewable. Written to be actionable cold — assume the
reader has not seen the PR.

- [ ] **N+1 query pattern in `availabilityForDeck`.**
      `backend/src/utils/deckIdentity.js:255-259` loops over every deck entry
      and calls `availabilityForRequirement` once per entry, so a 100-card deck
      issues at least 100 round trips. It is worse than that: each of those
      calls invokes `reservedByHigherPriority`, which re-runs
      `requirementsForVariant` — a two-table join across all of the user's
      decks — from scratch for that one entry. So the real cost is roughly
      2 queries per entry plus a full join per entry, not the single extra
      query the existing performance note in this document describes.
      Fix shape: fetch owned quantities and the full reservation queue for all
      variants in the deck in two set-based queries, then compute each entry's
      position in memory. Bindarr is single-user with a local SQLite file, so
      today this is cosmetic — it becomes real only if deck sizes or deck
      counts grow by an order of magnitude, or if the database ever moves off
      the same host.

- [ ] **`GET /api/decks/:id/locations` on a checked-out deck cannot tell
      "returned" from "deleted".**
      `backend/src/routes/decks.js:328-336` reads the stored rows in
      `deck_card_allocations` joined to `collection`, and reports `found` as the
      sum of what that join returns. It never consults the collection row's
      current state. The FK
      `deck_card_allocations.collection_entry_id -> collection(id)` is
      `ON DELETE CASCADE`, so deleting a card from the collection silently
      deletes the allocation row that recorded a deck was holding it. The deck
      then quietly reports fewer copies found, with no message explaining that
      the copy was removed from the collection rather than mislaid. The user
      sees a deck that used to be complete now showing a gap, and nothing on
      screen says why.
      Fix shape: either make the FK `RESTRICT` and force the user to return or
      reassign the deck first, or keep the cascade and surface the discrepancy
      explicitly — compare `found` against the requirement's quantity for a
      checked-out deck and emit a distinct warning ("1 copy was removed from
      your collection while this deck was checked out") rather than letting the
      number drift down silently.

- [ ] **`selectPhysicalCopies` ordering flipped from `added_at DESC` to
      `added_at ASC`.**
      `backend/src/utils/deckIdentity.js:285` orders candidate copies
      oldest-added first; the pre-6C storage helper that drew the "in a deck"
      badge used newest-added first. This is deliberate and is now consistent
      across both readers (the checkout wizard and the storage view), which is
      the property that actually matters — before 6C the two disagreed. The
      only consequence is that on a database with existing history, the badge
      may land on a different physical copy than it did before 6C. Harmless on
      a fresh database, which is the agreed cutover path. Recorded as an
      intentional change, not a defect; no action expected.

- [ ] **`413` without a `code` field is inconsistent with the other validation
      errors.**
      An absurd deck requirement quantity (over `MAX_REQUIREMENT_QUANTITY`)
      returns HTTP 413 with an `error` string and no `code`, while every other
      validation failure on the deck routes returns 400 with both `error` and a
      machine-readable `code`. Nothing is written to the database in either
      case, so this is purely a client-consistency nit: a frontend that
      branches on `code` has to special-case this one response. Fix shape:
      give the bound violation a `code` (and decide deliberately whether 413 or
      400 is the intended status for a too-large scalar field, rather than
      inheriting it).
