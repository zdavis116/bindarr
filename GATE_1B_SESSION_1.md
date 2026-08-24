# GATE 1b — FIRST REAL SESSION (~20 cards)

**Verdict: INCONCLUSIVE, and rgbArt is NOT ready to promote. Two real problems
found, one of them mine.**

```
47 scans logged   41 both answered   6 skipped (no detection)
AGREEMENT with ORB: 33/41 (80.5%)
DISAGREEMENTS: 8  -> ORB right 2, rgbArt right 0, UNDECIDED 6
rgbArt time: p50 112ms   p95 142ms
```

---

## Problem 1 — distances are far worse than Gate 1a predicted

Gate 1a said real photos land **26–64 bits** from the correct card. This session:

```
distance to top hit:  p50 82   p95 122
margin over runner-up: p50 18   p5 0
scans with margin < 10 bits: 14 of 41 (34%)
```

Verified against the 8 scans where ORB, rgbArt and OCR all agreed — so the
correct answer is not in doubt. Distance to the **correct** card:

```
32, 36, 40, 52, 58, 84, 90, 98
```

Wrong answers in the same session sat at **112–126**. Those ranges nearly touch.
Gate 1a's claim of clean separation was measured **index-against-index**; against
real photographs the margin is much thinner. **This is exactly what Gate 1b was
for** — Gate 1a explicitly could not answer it, and it turned out to matter.

### A hypothesis I had, tested, and killed

The index is built from Scryfall images that include the card's black border;
`rectifyCard` warps to the detected card edge, giving a borderless query. Since
a 3% crop moves a hash ~46 bits, framing mismatch looked like a clean
explanation for a systematic offset.

**Measured, it is wrong.** Re-hashing the same scans at insets from 0% to 6%:

```
inset  0%  median 58   <- current behaviour, BEST
inset  2%  median 80
inset  4%  median 98
inset  6%  median 108
```

Every correction makes it worse. Current framing is already optimal, and the
high distances are genuine photo-vs-print difference — lighting, sleeve gloss,
camera colour — not a framing bug. Recorded because the hypothesis was
plausible and someone will have it again.

---

## Problem 2 — the real one: THE SCANNER IS TOO SLOW TO USE

Zach stopped at ~20 cards because scanning is too slow to continue. Measured
server time this session: **2.1–4.9 s per scan**. ManaBox does ~1 card/second.

**rgbArt is not the bottleneck — it is the cure.** It costs **112ms** against
ORB's ~1.6s of matching, and it got the same answer 80.5% of the time while
carrying a 1.1GB index that rgbArt replaces with 9MB.

This reframes the phase order. Chasing rgbArt's accuracy to parity with ORB
before promoting it optimises the wrong thing: the product is unusable at 3s a
card no matter which matcher is more accurate.

---

## Honest accounting of the disagreements

Of 8 disagreements, **ORB won 2 and rgbArt won 0** on OCR evidence; 6 had no
independent evidence and are recorded UNDECIDED rather than assigned.

But note **where** rgbArt lost — every loss had a terrible confidence signal:

```
ORB Whisper of the Dross (inl 9)   | rgb Hunted Bonebrute  d=122 m=0
ORB Timely Interference  (inl 12)  | rgb Blade-Blizzard    d=126 m=2
ORB Namor, Scourge...    (inl 8)   | rgb Construct         d=116 m=4
ORB Forest               (inl 66)  | rgb Overgrown Farmland d=112 m=6
```

Distance >112 with margin <7, against correct answers at 32–98 with margins of
18–64. **The σ-test (§2.2) rejects every one of these.** rgbArt's failures are
loudly self-identifying, which is the property that matters: a matcher that
knows when it doesn't know can defer to the scan stack instead of recording a
card Zach doesn't own.

Also worth noting ORB's inlier counts on those rows (8–12) — **both** methods
were unconfident on the same photos. Those are probably bad photos, not bad
matchers.

---

## What this means for the plan

1. **Do NOT promote rgbArt in Phase 2 on this evidence.** It has not beaten ORB.
2. **Speed is the priority, not matcher accuracy.** A 3s scan fails the stated
   bar (ManaBox ~1/sec) regardless of which matcher wins.
3. **Confidence-by-separation is validated** and should gate any promotion:
   distance <100 AND margin >15 cleanly separates every correct answer from
   every wrong one in this session. Small sample — needs re-checking.
4. **The 6 no-detection scans deserve attention.** The card was never located,
   so no matcher got a turn. That is a detector problem and Phase 4 (YOLO OBB)
   is the plan's answer.

---

## Tooling defect found and fixed

`SCAN_DUMP_DIR` caps at 40 files, and the directory was **already full** — so
none of this session's photos were saved. My first offline analysis silently
compared *unrelated* photos and produced 188-bit distances that made no sense
against the live logs.

Two lessons, both now in the scripts:
- **The dump cap silently stops dumping.** Clear the directory before a session
  meant for offline analysis.
- **Look cards up by exact printing, never by name.** "HULK SMASH!" and "Forest"
  have many printings with different artwork; a by-name lookup compares against
  the wrong picture. `diagnose-inset.js` now keys on `name|set|number`.

The corrected harness reproduces the live distances exactly (40, 36, 58, 84, 32,
98, 52, 90), which is what makes the numbers above trustworthy.
