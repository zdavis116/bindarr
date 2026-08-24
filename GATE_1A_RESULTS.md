# GATE 1a — RESULTS

Phase 1a built the rgbArt index. This file records whether it cleared the two
gates the plan set, and what the numbers actually mean.

**Verdict: PASS on both checks.**

Artefact: `hash-index/rgbart-index.json` — 51,424 distinct artworks, 378-bit
rgbArt hash each, 0 build failures, 51,417/51,424 hashes unique.

---

## Check 1 — coverage of `card_cache` (bar: ≥99%)

```
43,569 / 43,569 card_cache rows covered   =  100.00%   PASS
  0 rows Scryfall did not recognise
  0 rows excluded as digital-only
```

**The trap this check had to avoid.** The index is deduplicated by
`illustration_id`, so it stores ONE printing per artwork. Most `card_cache` rows
therefore do NOT appear in the index by `(set, number)` — but their *artwork* is
covered, which is all recall needs. Matching naively on `(set, number)` reports
~70% and fails a gate that actually passes. The check resolves each row through
the Scryfall bulk file to its `illustration_id` first.

**Why the 100% is trusted.** A result of 100.00% with empty miss buckets is
equally consistent with "perfect index" and "check that cannot fail". Those are
indistinguishable from the outside, so the PASS was not accepted on sight —
`gate1a-coverage-control.py` re-runs the identical matching logic against an
index with 5% of artwork keys deliberately deleted:

```
coverage vs 5%-damaged index:  95.04%   <- check detects missing artwork
```

The check has teeth. The PASS is a measurement, not an artefact.

---

## Check 2 — separation at full scale (§3.3, previously proven only at ~1.2k)

Full 51,424 × 51,424 nearest-neighbour Hamming distance, every artwork against
every other.

```
p0      0        p25     88
p0.1    6        p50     94
p1     30        p75    102
p5     76        p100   146          mean 95.2
```

Reference: Zach's real photos land **26–64 bits** from the correct card. The
median distance to a *different* card is **94**. The distributions are cleanly
separated for the bulk of the index.

The tail is what matters, so it was classified rather than eyeballed:

```
142 cards have a neighbour within 8 bits (0.28%)
 ├─  15  BENIGN  — same card name, different printing (foil/token/reprint).
 │                 Recall returning either is CORRECT; the collector number
 │                 picks the printing. This is the design working as intended.
 └─ 127  distinct-name pairs — candidate real confusions

  of those 127, reachable from card_cache:  0
```

**Zero.** Every distinct-name collision lives in a set the app's catalogue does
not contain:

```
125  unk    "Unknown Event"     set_type: funny  (playtest/novelty cards)
  1  plst   "The List"
  1  tgk1   "GRN Guild Kit Tokens"
```

**Cards at real risk of a wrong identification: 0 of 43,569 (0.0000%).**

This confirms §3.3 at full scale. The earlier 12-bit minimum that made hashing
look unsafe was an artefact of comparing physical cards against cards that
cannot be physically scanned — first Arena rebalanced cards, now novelty sets.

**Consequence: recall-only is sufficient.** The verify stage (④) stays a safety
net rather than a mandatory hop, as §3.3 hoped but could not yet prove.

---

## Honest caveats — what this does NOT prove

1. **Coverage is measured against today's `card_cache`.** It is a snapshot, not
   an invariant. If new sets are imported, coverage must be re-measured; the
   index needs a rebuild cadence tied to set releases. Not a Phase 1 blocker.
2. **`unk` cards are paper and physically real** — they simply are not in the
   catalogue. If the catalogue ever ingests novelty sets, ~125 collisions become
   reachable and the collector-number tie-break stops being optional for them.
3. **This measures the index against itself, not against photographs.** It
   proves the index is *separable*. Whether a phone photo lands nearer the right
   card than the wrong one is Gate 1b (shadow mode), not this gate.

---

## Blocker found for Phase 1b

**The dev database is empty** — `/opt/bindarr-dev/backend/database/bindarr.db` is
4 KB with zero tables. Dev cannot currently serve a scan, so shadow mode has
nowhere to run. It must be seeded before 1b. (Prod's catalogue, read-only, is at
`/var/lib/bindarr/bindarr.db`, 43,569 rows.)

Operational note: SSH to both hosts works as `root` only — tailnet policy
refuses user `hermes`.

---

## Reproducing

```bash
python3 backend/scripts/gate1a-coverage.py          # check 1
python3 backend/scripts/gate1a-coverage-control.py  # check 1 negative control
python3 backend/scripts/gate1a-nn.py                # check 2 (slow, O(n²))
python3 backend/scripts/gate1a-nn-analyse.py        # check 2 classification
```
