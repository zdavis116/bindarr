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
