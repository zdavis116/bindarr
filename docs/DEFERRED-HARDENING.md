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

## Deferred: PR 6D

Raised by independent review of PR 6D. None of these is a data-loss or
correctness defect: each is a narrow robustness or explainability gap on a
single-user, tailnet-only deployment. Recorded here rather than fixed in the
merge-blocking pass, per the project's proportionality rule.

- [ ] **`printingChoicesForOracle` floors an empty finishes list to
      `['nonfoil']`.**
      Correct for paper Magic — every paper printing has a nonfoil — and the
      floor exists so a thin cache row cannot make a card unpickable entirely.
      The gap: a thin cache row could therefore OFFER a finish that the real
      printing does not have. The user would pick it, and the requirement would
      name a physical object that does not exist. Bounded by cache quality, not
      by user input. Fix shape: distinguish "this printing has no finish data"
      from "this printing is nonfoil-only", and mark the floored option in the
      picker rather than presenting it as known-good.

- [ ] **`parseJsonColumn` swallows malformed JSON per column.**
      Deliberate and documented: a corrupted cache row should degrade one
      card's display rather than fail the whole deck read, which is the right
      trade. The gap is that it degrades SILENTLY — nothing is surfaced
      anywhere, so a card quietly rendering with no types or no colour identity
      looks like a card that genuinely has none. Commander colour-identity
      validation reads that field. Fix shape: keep the tolerant parse, but
      count the failures and surface them as a deck-level warning so a
      corrupted cache row is visible rather than merely survivable.

- [ ] **`deckSections.js` 'Other' bucket has no UI affordance explaining why a
      card landed there.**
      A card whose `type_line` is missing or unrecognised falls into 'Other'
      with no explanation. Not a correctness problem — the card is present and
      counted — but the user cannot tell whether the app misread the card or
      the card is genuinely unusual. Fix shape: a hint on the section header
      naming the cause (no cached type line).

- [ ] **`deckSections.test.js` and the T17-T30 import tests assert on real DB
      state but lack load-bearing proofs.**
      The tests are the right SHAPE — they read `deck_cards` rows and the
      numbers shown to the user, not HTTP status codes. What they do not do is
      prove each guard is load-bearing: deleting an individual guard should
      turn a specific test red, and that has not been demonstrated per guard.
      Fix shape: mutation-verify the import guards (see the
      `mutation-verified-guards` approach) so each one has a named test that
      fails when it is removed. Note that the PR 6D copy-conservation guard
      added in this pass DOES have that property — T31 and T35 were captured
      RED against the unfixed code before the fix landed.

## Deferred: PR 6F

- [ ] **`swapCommander` add-then-remove can leave a visible second commander if
      the DELETE fails.**
      The order is deliberately correct and stays as it is: adding the new
      commander before removing the old one means the worst case is a deck
      showing two commanders, never a Commander deck showing zero. The failure
      is also visible — the user gets a toast and can see the extra row — so
      this is not a silent state change, which is the class of defect Bindarr
      actually blocks on. Fix shape: make the pair atomic behind a single
      server-side swap route so the client cannot be interrupted between the
      two calls.

- [ ] **The deck grid `+` button enforces only the 4-copy client guard and is
      unaware of singleton.**
      Clicking `+` on a card already in a Commander deck lets the request go to
      the server, which refuses it correctly with a message naming the card and
      the rule. The user therefore gets a truthful error rather than a wrong
      deck; what they do not get is the button being disabled before they click
      it. UX polish, not correctness. Fix shape: reuse the format check the
      create modal already does and disable/annotate the control for
      non-exempt cards already present by name.

- [ ] **Locale keys added to `en.json` only; 22 strings fall back to English in
      other locales.**
      Consistent with existing practice in this repo — every prior PR has added
      English keys and let the other locale files fall back — so this is a
      backlog item for a translation pass rather than something PR 6F
      introduced. Fix shape: one sweep across all locale files when the string
      set has settled.

- [ ] **The override list reuses `/api/audit-logs`, which caps at 100 rows of
      all event types with no pagination or filter.**
      Recorded commander overrides share that endpoint with every other audit
      event, so a busy period of unrelated activity could push older overrides
      out of view. This matters because the override list is meant to be the
      to-do list for improving partner detection — an override that scrolls off
      is a bug report that was collected and then lost. Fine at single-user
      scale: Bindarr is one user on a tailnet, overrides are rare by
      construction (each one is a mechanic the parser did not recognise), and
      100 rows is a long way from that volume. Nothing is corrupted or
      mis-stated in the meantime; the record still exists in `audit_logs`, it
      is only the default view that truncates. Fix shape: add an
      `action_type` filter and paging to the audit-logs endpoint, then point
      the override surface at `action_type=COMMANDER_PAIR_OVERRIDE`.

- [ ] **Import cannot override a refused commander pairing — by design, not by
      omission.**
      The override is an explicit, per-pairing confirmation with a typed
      reason, and a bulk paste is the wrong place to collect one: the user is
      not looking at the pair when they press Import, so any justification
      gathered there would be a reflexive click rather than the considered
      report the reason field exists to capture. A refused import therefore
      rolls back whole and states why, and the user sets the commander from the
      picker where the confirmation actually lives. This is recorded here as a
      deliberate constraint so a future reader does not "fix" it by threading
      an override through the import body. Fix shape: none wanted. If it ever
      becomes a real friction point, the answer is to surface the refused pair
      in the import compare screen and route the user to the picker — not to
      accept a reason typed blind.


## Deferred: PR 6G

Found during the PR 6G colour-identity review. None of these can corrupt data or
put a deck into a state the app calls healthy while it is not, which is the bar
for blocking a merge. The blocker that WAS found in the same review — a deck
left holding off-identity cards after a commander delete — is fixed in this PR.

- [ ] **`X-Total-Count` is not adjusted when the commander filter trims a page.**
      Commander-only search filters results after the page is fetched, so the
      total header can report more results than the client will ever be shown,
      and the last page can come back short. The consequence is a paginator that
      may offer a page with nothing on it. Nothing is mis-stated about any CARD
      and nothing is written; it is a count in a header being optimistic. Fix
      shape: filter before counting, or push the commander predicate into the
      query so the count and the rows are produced by the same pass.

- [ ] **The available-count colour uses a literal `#f87171` rather than a token
      (`DeckBuilder.jsx:2295`).**
      A hard-coded hex in a codebase that otherwise themes through CSS custom
      properties. It renders correctly today and is invisible to the user; the
      cost is that a future theme change will miss this one value. Fix shape:
      replace with the existing danger/warning token used by the sibling
      badges in the same list.

- [ ] **No proving test for the batch identity gate on the IMPORT path
      specifically.**
      The import path's colour pre-flight is covered indirectly (F15-TC42
      exercises the unverified-line case, and the choke point inside
      `writeDeckCard` is a backstop every import write passes through), but
      there is no test that would fail if the import-specific gate were deleted
      while the choke point stayed. So the gate's behaviour is asserted, but its
      EXISTENCE at that layer is not pinned — a refactor could remove it and the
      suite would stay green because the backstop absorbs it. Not a correctness
      gap today: the backstop genuinely refuses, so no off-identity card gets
      in either way. Fix shape: a case that pastes an off-identity line and
      asserts the refusal appears in the PREVIEW response, before any write is
      attempted, which is the thing only the import-layer gate can do.

## PR 7B — the combined buylist updates live

### User-visible behaviour changes (not regressions)

- **"Build buylist" and "Clear" are gone from the multi-deck buylist panel.**
  The list now follows the ticked decks directly: ticking a deck adds its
  missing cards, unticking removes that deck's contribution, and unticking
  every deck empties the list. Zach: *"the build buylist/cancel seem redundant
  when I click build a buylist and check off decks it should just automatically
  update and when I uncheck decks it should clear those cards from the list and
  if I uncheck all decks it should clear the list."* A confirm button asked him
  a question already answered by the checkboxes — the same defect class as the
  printing picker removed in PR 6F. "Clear" became redundant the moment
  unticking worked, so it went with it.

- **One exit, not three.** The toolbar button he entered from ("Build a
  buylist" → "Cancel buylist") is now the only way out of the mode.

- The empty-selection refusal on `POST /api/decks/buylist` is UNCHANGED and
  still correct. The UI simply never makes that call now: nothing was asked, so
  there is no question to refuse. Do not "simplify" the server to return an
  empty list — an empty shopping list reads as the good news that he needs
  nothing.

### Deferred

- [ ] **No cancellation of the actual HTTP request when the selection changes.**
      A superseded request is discarded on arrival by the generation guard in
      `frontend/src/components/buylistSync.js`, so it can never repaint the
      screen — the correctness property holds. What is not done is aborting the
      request in flight, so a fast run of ticks can leave one or two useless
      responses in transit. On a single-user self-hosted app reading a small
      aggregate this costs nothing measurable. Fix shape: give each request an
      `AbortController`, abort the previous one in `select()`, and keep the
      generation guard as the backstop — the guard is what makes the behaviour
      correct and must NOT be removed just because aborting exists.

- [ ] **The debounce window (300ms) is untested against a real phone.**
      `BUYLIST_DEBOUNCE_MS` is asserted to sit in the 250-400ms band, which
      pins the intent but says nothing about how it feels on an iPhone 16 over
      Tailscale. Needs Zach's hands, not a test.
