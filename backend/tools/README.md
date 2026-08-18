# PR 6B mutation testing

## Why this exists

Three consecutive review rounds failed on the same root cause: guards that no
test exercised were the ones that turned out to be broken. The suite was green
every time. The reviewer's summary of the problem:

> Coverage measures which lines executed; mutation testing measures which lines
> mattered.

A guard is **load-bearing** only if deleting it turns a NAMED test red. A green
suite is not evidence of that; it is evidence that the code ran.

## Running it

    node tools/mutate.js            # every mutant
    node tools/mutate.js M22 M25    # selected mutants

Exit code 0 means every mutant was either killed or is a documented
equivalent/unreachable mutant. Non-zero means a real gap.

The harness:

1. Verifies the pristine tree is green (otherwise every result below is noise).
2. For each mutant: applies a source edit that deletes/neuters ONE guard, runs
   the invariants suite, records which named tests went red, restores the file.
3. Re-verifies the tree is green afterwards, so a later mutant can never have
   run against a tree an earlier one dirtied.

Anchors must be unique. The harness refuses an ambiguous anchor rather than
silently mutating the wrong call site.

## Mutant numbering

IDs are stable and are never reused or renumbered. If you retire a mutant,
leave a commented stub explaining why the number is absent rather than closing
the gap — an unexplained hole in the sequence is indistinguishable from a
silently dropped mutant, and a catalogue you cannot trust is worse than none.

Round 4 failed partly on exactly this: M5-M7 and M17 were missing with no
explanation. They were the `POST /api/collection` guards, and that route turned
out to be the one with no mutation coverage at all. They are restored in place
rather than renumbered away, so the sequence now runs M1-M84 with no gaps.

## Writing a good mutant

A mutant must change **behavior**, not just syntax. Deleting a line no request
can reach produces a mutant nothing can kill, and that is a defect in the
mutant, not evidence about the suite.

## Writing a test that actually kills one

The recurring trap in this PR: a test can **exercise** a guard without
**depending** on it, because some other mechanism happens to produce the same
outcome. Three real examples from this round:

- **M22 (resort capacity).** Resort plans from `loadCompartments`, which counts
  only the caller's rows. With ordinary data the projection matches the
  database, so the planner never proposes an over-capacity slot and the
  reservation never fires. The guard only becomes load-bearing where the
  projection and the database disagree — e.g. a compartment physically holding
  another user's row. See T25.

- **M12 (bulk destination ownership).** Deleting the check still yields a 400,
  because the planner finds no slot in a location it cannot see. Same status,
  different reason. Killing it required asserting the *error* ("Invalid location
  ID") against a foreign location with plenty of free space, so "full" is not a
  defensible answer. See T32.

- **M40 (`excludeEntryId`).** Every other capacity test asserts a refusal, so a
  guard that over-refuses passes them all. Catching over-refusal needs a case
  where a legal write must SUCCEED. Note the `place` route skips the reservation
  entirely when the card is already in the target compartment, so the test has
  to go through `PUT /collection/:id`. See T36.

Assert on **database state**, not HTTP status alone. A status says what the
server replied; only the stored rows say what it wrote.

## Documented survivors

A survivor is **not** automatically a gap, but the distinction is easy to abuse:
`equivalent: true` and `unreachable: true` are also the mechanism by which a
real gap gets silently excused, and honest and dishonest use look identical in
the code. Every flag below therefore carries its evidence, and each one should
be re-verified by an independent reviewer rather than taken on trust. A growing
exemption list is a smell.

Two categories are expected to survive and are flagged in `mutants.js` so the
harness does not report them as failures:

- `equivalent: true` — behaviorally identical to the original, so no test can
  distinguish them.
  - **M33**: the old `SELECT MAX(idx), capacity ... ORDER BY idx DESC LIMIT 1`
    is actually correct on SQLite, which takes bare columns from the row
    producing a lone `MAX()`, and `UNIQUE(location_id, idx)` rules out ties. The
    rewrite is a readability/portability fix, not a behavior fix.
  - **M82**: the `AND user_id = ?` on the location-DELETE unfile statement is
    shadowed by the schema's `ON DELETE SET NULL` foreign keys, which null both
    columns for every affected row regardless of owner. Verified by reproduction
    against a live database, not by reading the schema.

- `unreachable: true` — defence in depth that no current HTTP request can
  defeat. **M25/M28**: every compartment `recommendSlot` can return is derived
  from `location.user_id`, so the planner cannot name a foreign compartment. The
  re-check stays because it CONTAINS a future planner bug, but killing it would
  require stubbing `recommendSlot`, which tests the mock rather than the system.

## Proven vs merely present

This distinction is the reviewer's, and the harness now reports it directly:

- **PROVEN (killed).** A named test fails when the guard is deleted. The guard
  is load-bearing and the suite defends it.
- **PRESENT but not proven (documented survivor).** The guard exists and is
  retained, but nothing observable depends on it today — either because it is
  behaviorally equivalent to its absence, or because another mechanism (a
  foreign key, a call-site sanitiser, the planner's own scoping) already
  produces the same outcome.

A documented survivor is legitimate defence in depth. It is **not** a tested
guard, and it must not be described as one in review notes or PR descriptions.
The redundant survivors the round-4 reviewer identified — call sites that
pre-sanitize, and planner-shadowed re-checks — are correctly harmless, and are
listed above as PRESENT, not PROVEN.

The rule of thumb: if you would cite a guard as evidence that an attack is
blocked, it must be in the killed column. If it is only in the survivor column,
the thing actually blocking the attack is something else, and you should be able
to name that something else.
