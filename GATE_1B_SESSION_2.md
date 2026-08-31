# GATE 1b — SESSION 2 (~10 cards): WHY AGREEMENT COLLAPSED

**Verdict: rgbArt is NOT the thing that broke. Detection is. And the real
finding is that the scanner's speed problem and its accuracy problem are the
same problem.**

```
                      session 1 (Marvel/msh)   session 2 (mixed, sleeved)
agreement with ORB           80.5%                    25.9%
rgbArt distance p50            82                      112
margin < 10 bits              34%                      52%
```

Same code, same index, same server. Something about the CARDS changed.

---

## Ruling out the innocent explanations

For every scan where ORB was confident (inliers ≥ 40, so its answer is the best
proxy for truth we have), I asked whether the correct card was even *reachable*:

```
correct card ranked first             : 7
correct card in index but OUTRANKED   : 7   <- ranking failure
correct card NOT IN INDEX             : 0   <- coverage failure
```

**Coverage is not the problem** — Gate 1a's 99.99% holds. It is a ranking
failure. But the deeper clue is that the correct card was *far away in absolute
terms*: a Forest scan sat **134 bits from its nearest of 372 Forest artworks**.

A query that is far from *everything* is not a ranking problem. It means the
picture being hashed does not look much like a card image at all.

## So I looked at the pictures

Numbers had gone as far as they could, so I rendered the rectified scan beside
the catalogue image. **The cause is visible immediately:**

1. **The card is in a toploader / plastic case, and detection grabbed the CASE,
   not the card.** The rectified "card" includes white tray background, case
   edges, and the card floating small inside it. Everything downstream — the
   hash, the art-box crop, OCR's strip position — is then measuring the wrong
   rectangle. This is the dominant failure.

2. **Foil cards produce rainbow glare** across the whole face (Raft Security
   Officer). The artwork's colour, which is exactly what rgbArt's RGB hash keys
   on, is overwritten by the reflection.

3. **Basic lands are a trap for my own diagnostic**: "Forest" has 372 printings
   with completely different artwork. ORB saying "Forest" and rgbArt saying
   "Forest" can still be two different pictures — and my by-name reference
   comparison was itself comparing against the wrong Forest. Noted so the
   diagnostic is not misread.

**Session 1 was mostly loose Marvel cards — clean crops, distances 32–58.
Session 2 was sleeved/cased cards — bad crops, distances 78–138.** That is the
whole difference.

---

## Why this matters more than it looks

**Detection is upstream of everything.** When it grabs the wrong rectangle:

- rgbArt hashes the wrong picture → wrong card
- OCR reads the collector strip from the wrong position → no number
- ORB still copes, because feature matching tolerates a loose crop far better
  than a global hash does

So the fair statement is: **rgbArt is more sensitive to a bad crop than ORB is.**
That is a real disadvantage, and it is not fixed by tuning the hash. It is fixed
by giving it a correct crop.

This is exactly what Zach described when he said ManaBox "draws a line around the
card and auto detects" — a proper oriented-box detector, which is Phase 4 of the
plan (YOLO OBB). **The plan already contains the fix; it is just in the wrong
order.**

---

## The speed picture from the same session (29 scans)

```
TOTAL  p50 2.95s   p95 3.32s        (bar: ManaBox ~1s)

orb-verify            987ms  33%
detect+preprocess     396ms  13%
ocr-rectify-warp      355ms  12%
ocr-collector-strip   287ms  10%
ocr-card-title        253ms   9%
db-hydrate            236ms   8%
clip-recall           133ms   5%
UNACCOUNTED             1ms   0%     <- instrumentation is complete
upload                757KB          <- before the server clock even starts
```

`UNACCOUNTED` is **1ms**. There is no mystery time; the earlier "missing 2.5s"
was OCR and detection nobody had timed separately.

**Removing the three biggest stages still leaves 1.21s** — over the bar, before
counting the phone's upload of 757KB. Trimming stages cannot reach 1 card/sec.
The round trip itself has to go, which is Phase 3.

---

## Recommendation — reorder the plan

The evidence now points the same way for speed AND accuracy:

1. **Phase 4 (YOLO OBB detection) FIRST, not last.** It is the root cause of the
   accuracy collapse, it replaces the 396ms classical detector, and it makes the
   OCR warp unnecessary at its current cost. Every other measurement is polluted
   until the crop is right.
2. **Then re-run Gate 1b.** rgbArt's numbers on sleeved cards are meaningless
   until it is fed a correct crop. Judging it now would retire it for someone
   else's bug.
3. **Then Phase 3 (identification on the phone).** That is the only route to
   ~1 card/sec, because it deletes the upload and the round trip together.
4. **Do NOT promote rgbArt yet** (Phase 2). It has still not beaten ORB, and on
   this evidence it is the more crop-sensitive of the two.

The one thing I would NOT do is keep tuning the hash. The hash is not what is
wrong.
