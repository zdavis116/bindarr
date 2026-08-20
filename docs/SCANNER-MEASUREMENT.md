# Scanner measurement (plan Task H2)

## Requirement: exact printing from the scan (Zach, 2026-08-20)

Zach wants **collector-number OCR so the scan resolves the exact printing**, not
just the artwork.

That is the right call for this app specifically. Deck identity is exact-only, so
a wrong printing propagates into availability, buylists and deck matching — and
he chooses printings on price, so "probably the C21 one" is not good enough.

### Why OCR is genuinely needed, not a nice-to-have

The index is built from Scryfall's `unique_artwork` bulk: one entry per distinct
illustration, 57,583 scannable images (54,142 cards; double-faced cards
contribute both faces).

`default_cards` has roughly twice as many entries — every printing, ~104k, which
matches Bindarr's own catalogue. **Indexing all of them would not help.** The
extra entries are printings whose images are identical to one already indexed:
same illustration, same frame, same picture. It would double index size and build
time, and make ranking WORSE by putting tens of thousands of near-duplicate
embeddings in competition.

The limit is physical, not a tuning parameter: **image matching identifies the
artwork; it cannot identify the printing when printings share artwork.** The only
visual difference is the collector number and set symbol — small text the current
pipeline does not read. ManaBox has the same constraint, which is why it asks the
user to confirm sets.

### Sequencing — this cannot be built first

OCR is a DISAMBIGUATION step that runs after image matching narrows to candidate
printings. With no working index there is nothing to disambiguate between, and
reading "263" off a card that was misidentified as the wrong card entirely gets
nowhere.

So:

1. **Global index builds** — was impossible until the Scryfall bulk API fix;
   never run on any box.
2. **Measure whether unscoped matching works at all** across 57k images. This is
   the real unknown and it decides everything downstream.
3. **Then collector-number OCR** to resolve printing within the matched artwork.

If step 2 shows matching is unreliable, OCR will not rescue it.

### Notes for the OCR work, when it comes

- The collector number sits bottom-left on modern frames; **older frames do not
  carry one at all**, so pre-1996ish cards need a different path (set symbol, or
  the user picking).
- Scryfall's `collector_number` is a string, not an integer — values like `123a`,
  `★`, `A-12` exist.
- Reading the number narrows to a printing only when combined with the set. The
  number alone is not unique across sets.
- A misread number is worse than no read: it would silently record a printing he
  does not own. Standing rule applies — refuse or ask rather than guess.

---

## The actual goal (Zach, 2026-08-19)

> "I do want to enhance the scanner. I would like to just scan cards like
> ManaBox and not have to pick sets ahead of time."

That is the requirement. Measurement exists to find out what stands between the
scanner and that experience — it is not an end in itself.

**Point the camera at any card, from any set, and have it identified.** Picking
a set first is acceptable for a sealed box and useless for a shoebox of mixed
cards, which is the case that decides whether a collection ever gets catalogued
at all.

So the question is not "is the scanner good". It is:

**Is UNSCOPED scanning good enough to catalogue with, and if not, what exactly
is failing?**

Everything below serves that question.

### What is already known

- Bindarr supports both scoped and unscoped scanning. Set-scoped uses a small
  per-set ORB index; unscoped uses a whole-game index.
- The global index rebuild is heavy: per the admin hint, "tens of thousands of
  images, the CLIP model on CPU, ~1GB on disk, and can run for hours".
- `POST /api/scan-match` already returns 8 ranked candidates, each hydrated to a
  specific printing, and it is READ-ONLY — matching is separate from adding.
- The pipeline is two-stage: CLIP proposes `RECALL_K = 250` candidates
  (`scanMatch.js:19`), then geometric verification re-ranks and filters them
  (`scanMatch.js:49`).

That two-stage shape matters for diagnosis. When a scan is wrong, there are two
very different causes:

- **The right card was never in the 250** — a recall failure. Fixed by a better
  index, better capture, or a larger K.
- **It was in the 250 and got re-ranked away** — a verification failure. Fixed
  by the geometry step, not by a better model.

The measurement must distinguish these, because they lead to completely
different work.

---

The original plan is explicit that this is a MEASUREMENT exercise, not a build:
"Measure scanner throughput before redesign... Only then prioritize review
queues, asynchronous capture, or model changes."

That discipline is right. "The scanner feels bad" is not actionable. "Top-1
exact-printing accuracy is 95% on modern frames and 55% on old borders" tells us
exactly what to fix — or that nothing needs fixing.

---

## What counts as correct (Zach, 2026-08-19)

**Two accuracy figures, tracked separately.** Not one blended number.

1. **Card identity** — is it the right card name?
2. **Exact printing** — is it the right printing AND finish?

They are different failures with different causes and different fixes:

- **Wrong card name** = recognition failed. The image match did not work. Causes:
  glare, sleeve, lighting, an art the model does not know. Fixed by better
  capture or a better model.
- **Right card, wrong printing** = recognition worked, disambiguation failed.
  Many printings share identical artwork, so the image alone cannot separate
  them. Fixed by set scoping or reading the collector number — NOT by a better
  model.

Collapsing these into one number hides which problem exists, and they lead down
completely different roads.

Note this matters more for Bindarr than for a generic scanner, because deck
identity is exact-only: a wrong printing puts a card in the collection that Zach
does not own, and availability, buylists and deck matching all inherit the
error.

## Metrics to record

Per the plan:

- Top-1 card-identity accuracy
- Top-1 exact-printing accuracy
- Top-3 accuracy (both senses)
- Median recognition latency
- False auto-add rate — how often it silently added the wrong thing
- Duplicate-capture rate — how often one physical card became two rows

## Sample to cover

Per the plan, at least:

- Modern frame
- Old border
- Borderless / showcase
- Double-faced
- Foil and nonfoil (foil glare is the obvious risk)
- Multiple printings with shared artwork — the disambiguation case
- Sleeved cards
- Several lighting conditions

## Approach

A harness that logs every scan attempt: the top candidates returned, what the
card actually was, and how long it took. Zach scans a stack of real cards and
records ground truth; the harness produces the numbers.

Requirements:

- **It must not pollute the collection.** Measurement runs must be clearly
  separable from real adds, or better, not write to the collection at all.
- **Record the full candidate list, not just the winner.** Top-3 accuracy cannot
  be computed after the fact from top-1 alone, and "it was second" is a very
  different problem from "it was not in the list".
- **Record latency honestly** — the time Zach waits, not the model's internal
  time.
- **Ground truth has to be cheap to enter**, or the sample will be too small to
  mean anything. Scanning fifty cards should not require fifty forms.

## Known cost, from PR 6H

`prepare-set` / `setIndex.buildSet()` downloads card images and computes
scanner fingerprints. The PR 6H catalogue removed the need for its card-row
caching side effect but NONE of the image work, which is the real cost. So
per-set index building remains genuinely slow, and that is a constraint for any
scanner design, not something the catalogue solved.

## After measurement

Only then decide between: review queues, asynchronous capture, set scoping,
collector-number OCR, or model changes. The numbers pick the target.
