# GATE 1a — RESULTS

Phase 1a built the rgbArt index. This file records whether it cleared the two
gates the plan set, and what the numbers actually mean.

**Verdict: PASS on both checks**, with one bounded risk documented below.

Artefact: `hash-index/rgbart-index.json` — 51,424 distinct artworks, 378-bit
rgbArt hash each, 0 build failures, 51,417/51,424 hashes unique.

> ### Correction — read this first
>
> The first version of this file measured against `/var/lib/bindarr/bindarr.db`
> on **prod** (43,569 rows) and concluded **zero** cards were at risk. That was
> the wrong catalogue.
>
> The dev app reads `/var/lib/bindarr-dev/bindarr.db` — **104,535 rows, 2.4x
> larger**, and it *does* carry the novelty sets prod lacks. There is also an
> empty 4 KB decoy at `/opt/bindarr-dev/backend/database/bindarr.db` (created in
> the service's WorkingDirectory) which is what made dev first appear unseeded.
> The stated "Phase 1b blocker: dev database is empty" was false — dev has been
> scanning fine all along.
>
> Every number below is re-measured against the real dev catalogue. The
> conclusion still holds, but "0 cards at risk" became "125 pairs at risk,
> all confined to one novelty set" — a materially different claim.

---

## Check 1 — coverage of `card_cache` (bar: ≥99%)

Against the real dev catalogue (104,535 rows):

```
103,393 covered            98.91% of all rows
  1,130 digital-only       correctly excluded, cannot be physically scanned
     12 not in Scryfall    pz2 promos, collector numbers Scryfall doesn't carry

coverage of SCANNABLE cards:  99.99%  (103,393 / 103,405)   PASS
```

**The trap this check had to avoid.** The index is deduplicated by
`illustration_id`, so it stores ONE printing per artwork. Most `card_cache` rows
therefore do NOT appear in the index by `(set, number)` — but their *artwork* is
covered, which is all recall needs. Matching naively on `(set, number)` reports
~70% and fails a gate that actually passes. The check resolves each row through
the Scryfall bulk file to its `illustration_id` first.

**Why this is trusted.** `gate1a-coverage-control.py` re-runs the identical
matching logic against an index with 5% of artwork keys deliberately deleted:

```
coverage vs 5%-damaged index:  95.04%   <- the check detects missing artwork
```

A check that cannot fail is indistinguishable from a passing one, so the PASS
was not accepted until the control demonstrated it has teeth.

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
median distance to a *different* card is **94**. For the bulk of the index the
distributions are cleanly separated — the right answer wins by a wide margin.

The tail is what matters, so it was classified rather than eyeballed.
Reachability is tested **exactly** — a card counts as reachable only if the
catalogue holds a row matching `(name, set)` together, not the looser "this set
exists somewhere AND this name exists somewhere".

```
≤8 bits:   142 cards
  15  BENIGN — same card name, different printing (foil/token/reprint).
      Returning either is CORRECT; the collector number picks the printing.
 127  distinct-name pairs, of which 125 reachable in the dev catalogue
      → ALL 125 are in set `unk` ("Unknown Event", set_type: funny)

≤16 bits:  368 cards → 314 distinct-name, 314 reachable
      → 314 in `unk`, plus exactly 2 non-`unk`: Soldier [plst] <-> Soldier [tgk1]

≤24 bits:  462 cards → 379 distinct-name, 373 reachable
      → 6 non-`unk` pairs, all token/token near-duplicates:
        Soldier/Soldier, Vampire/Vampire, Snake/Snake
```

**The collisions are overwhelmingly one novelty set.** `unk` is "Unknown Event"
— playtest/joke cards. They are `games: ["paper"]` so the §3.3 `game:paper`
filter does not remove them, and they are physically real, but they are not
tournament cards and are vanishingly unlikely to appear in a scanning session.

**Every non-`unk` collision within 24 bits is a token↔token pair** — two
printings of Soldier, Vampire, Snake. Misidentifying one Soldier token as
another Soldier token is a near-harmless error.

**No pair shares both set AND collector number**, so the collector-number
tie-break can separate every one of them. Zach's rule — art identifies the card,
the collector number picks the printing — remains sufficient.

Only past 24 bits do real cards appear (`fic`/`afic`, `ltc`/`altc`,
`msh`/`amsh`), and those are the *same card* in its alchemy/borderless variant —
benign by the same logic as the 15 above.

**Conclusion: recall-only is sufficient for the cards Zach actually scans.** The
verify stage (④) stays a safety net rather than a mandatory hop, as §3.3 hoped
but could not prove at scale.

---

## The one real risk, stated plainly

If a scanning session includes **Unknown Event novelty cards**, ~125 artwork
pairs sit within photo-noise distance and recall alone can return the wrong one.
The collector number resolves every such pair, so this is an argument for
keeping the tie-break wired up — not for a mandatory verify stage.

Cheap mitigation if it ever bites: drop `set_type: funny` from the index the
same way `game:paper` drops digital-only. Deliberately NOT done now — it would
silently make those cards unscannable, and silent state changes are exactly what
Bindarr must not do.

---

## Honest caveats — what this does NOT prove

1. **Coverage is a snapshot, not an invariant.** Measured against today's
   catalogue. New set imports require a re-measure; the index needs a rebuild
   cadence tied to set releases.
2. **This measures the index against itself, not against photographs.** It
   proves the index is *separable*. Whether a phone photo lands nearer the right
   card than the wrong one is **Gate 1b** (shadow mode), not this gate.
3. **The 26–64 bit photo figure comes from a 12-photo sample.** It is the
   weakest number here and the one Gate 1b must replace with real data.

---

## Operational notes

- Dev app database: `/var/lib/bindarr-dev/bindarr.db` (322 MB, 174 MB WAL).
  The file at `/opt/bindarr-dev/backend/database/bindarr.db` is an empty decoy —
  ignore it. Worth deleting so it cannot mislead again.
- Prod database: `/var/lib/bindarr/bindarr.db`. Only ever read read-only here.
- SSH to both hosts works as `root` only; tailnet policy refuses user `hermes`.
- Never file-copy a live SQLite DB (prod had 4.7 MB of un-checkpointed WAL) —
  use `VACUUM INTO` for a consistent snapshot.

---

## Reproducing

```bash
python3 backend/scripts/gate1a-coverage.py           # check 1 (prod catalogue)
python3 backend/scripts/gate1a-coverage-control.py   # check 1 negative control
python3 backend/scripts/gate1a-nn.py                 # check 2 (slow, O(n²))
python3 backend/scripts/gate1a-nn-analyse-dev.py     # check 2, real dev catalogue
```
