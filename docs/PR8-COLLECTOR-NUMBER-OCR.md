# Collector-number OCR: resolve the exact printing from a scan

Zach, 2026-08-20: *"I want collector-number OCR so it gets the exact printing."*

And for cards that carry no number at all: *"Show printings and let me pick for
the pre-1996 cards."*

Right call for this app specifically. Deck identity is exact-only, so a wrong
printing propagates into availability, buylists and deck matching — and he
chooses printings on price.

---

## What the measurements changed about the design

Measured on the dev box, unscoped, against the newly built global index:

```
card identity   12/12  (100%)
exact printing   7/12  (58%)
```

The five misses were all the same shape — right card, wrong printing, because the
artwork is shared:

```
Sol Ring (c21)           -> v10
Counterspell (mh2)       -> ema
Birds of Paradise (m12)  -> rav
Swords to Plowshares     -> ddf
Wrath of God (10e)       -> 2xm
```

**The critical detail: `printing rank` was `-1`, not 3 or 5.** The correct
printing was not in the candidate list AT ALL.

The index is built from Scryfall's `unique_artwork` bulk: one entry per distinct
illustration. A C21 Sol Ring and a CMM Sol Ring collapse to a single entry, so
the other printings are not candidates that ranked badly — they were never there.

### Consequence: OCR cannot be a re-ranker

The obvious design — read the number, reorder the candidates — **cannot work**,
because the right answer is absent from the list.

Instead:

1. Image match identifies the **card** (100% reliable in testing).
2. OCR reads the **collector number** and **set code** from the photo.
3. Look the printing up in `card_cache` by **name + number**, narrowed by set
   code when it is legible.

OCR is a *catalogue lookup key*, not a scoring signal. This is the single most
important thing the measurement taught us, and it was not obvious beforehand.

---

## Where the number is, and when it is not

**CORRECTED BY MEASUREMENT (PR 8 implementation).** This section originally said
pre-1996 cards carry no number. The real boundary is much later and much bigger:
**only the 2015 frame redesign prints a collector number.** Cropping and
inspecting every frame family in a 21-card corpus:

```
frame 1993 (LEA, LEB, ARN)      -> artist credit + copyright only, NO number
frame 2003 (8ED, 10E, M12)      -> artist credit + copyright only, NO number
frame 2015 (C21, MH2, ZNR, ...) -> "263/281 U" / "C21 * EN <artist>"
```

So a 2007 10th Edition card is exactly as unreadable as an Alpha one. This
matters for expectations: OCR resolves printings for the MODERN catalogue, and
everything printed before ~2015 goes to the review queue by physical necessity,
not because the OCR is weak. That is a much larger share of a mixed shoebox than
"pre-1996" implied.

- Modern (2015+) frames: bottom-left, small white text, `123/456` or `123`, with
  the set code and rarity beside it. Measured: that strip is **~28px tall** in
  the pipeline's existing 500x700 rectified image (`scanMatch.js:47`). It proved
  marginal, so the OCR crop is rectified at **750x1050** — measured to raise
  exact reads 10/15 -> 12/15 and cut fabricated reads 5/21 -> 1/21. The size used
  for MATCHING is unchanged.
- Older frames: **no collector number is printed at all.** The information is
  physically absent — this is not a gap to engineer around.
- Non-numeric and suffixed values exist: `123a`, `★`, `A-12`, `GR1`. Scryfall
  stores `collector_number` as a STRING. Any parse assuming an integer will
  silently mangle these.

## Batch the ambiguous ones — do not interrupt scanning (Zach, 2026-08-20)

> *"maybe when scanning hold the unknown cards till I'm done scanning and then
> let me go through all the unknown cards and update them correctly that way it
> doesn't slow scanning down"*

This supersedes any design that prompts mid-scan. **Scanning runs continuously.**
Cards that resolve to exactly one printing are added immediately. Cards that do
not go to a REVIEW QUEUE, and he works through the queue when the stack is done.

Why this is better than prompting inline:

- **Scanning keeps its rhythm.** He is holding a physical stack. A modal every
  fourth card means putting the stack down, and the physical workflow is the
  thing that decides whether a collection actually gets catalogued.
- **Bulk review is faster than scattered review.** Twenty printing decisions in a
  row are quicker than twenty spread across an hour, because the mental context
  is already loaded — and patterns become visible ("these all came from the same
  box, they're all C21") that are invisible one card at a time.
- **It relaxes the OCR latency budget.** If an uncertain card defers to a queue
  rather than blocking, OCR being occasionally slow matters much less.

The original plan anticipated this. Task H2: *"Only then prioritize review
queues, asynchronous capture, or model changes."* The measurements now justify
the review queue.

### Queue requirements

- A queued card is **not yet in the collection**. It must not count toward
  availability, appear in deck matching, or affect a buylist until resolved.
  A pending decision is not a card he owns.
- The queue must **survive a page reload and a session end**. Scanning 500 cards
  and losing the queue to a dropped connection would be worse than prompting
  inline.
- Each entry keeps what the scan knew: the matched card, the OCR read (if any)
  and its confidence, and the candidate printings — sorted with owned printings
  first, per PR 6I's banding.
- Resolving an entry is **one tap** in the common case. Bulk actions are worth
  considering ("apply this set to all remaining Sol Rings") but are NOT part of
  the first build; measure the real queue first.
- The queue must state plainly **why** each card is there: number unreadable, no
  number printed, or several printings matched. Different reasons need different
  decisions from him.

### What still goes straight in

Only a confident OCR read matching exactly one catalogue printing. Everything
else queues. That keeps the ask-never-guess rule intact while removing its cost
from the scanning loop.

---

## What must happen when OCR is uncertain

**Ask. Never guess.**

A misread or assumed printing would silently record a card Zach does not own, and
that flows into availability, buylists and deck matching.

Rules:

- Confident read matching exactly one catalogue printing -> use it.
- Confident read matching several, or none -> show those printings, let him choose.
- Low-confidence read, or no number printed on the card -> show the printings of
  that card and let him pick. **Do not default to "most likely" and let him
  correct it.**

**Sort the picker by what he ALREADY OWNS first**, same banding as PR 6I's
catalogue search. When cataloguing he works through stacks from one source, so
the printing he owns most of is usually the one in hand — that keeps
"always ask" cheap by making the common case a single tap.

An "I could not read it" outcome is a success, not a failure, as long as it says
so plainly.

### Why not the ManaBox default-and-correct model

ManaBox picks a version and expects correction. Their own FAQ documents the
consequence: *"the scanner detects cards using the art, so when a card has been
printed with the same art multiple times, it's possible the detected version is
not the one you are scanning."* Users cataloguing at volume report *"it rarely
gets the set correct and am spending painstaking time having to change it"* and,
for special treatments, *"surge foils were coming up as the normal foils... I
ended up just adding all my FF cards manually."*

Defaulting is only cheaper when it is right. When it is wrong it is silent, and a
silently wrong printing in a collection tracking physical objects cannot be
reconciled against reality later.

### Finish is never inferred

The surge-foil complaint is the clearest case: special treatments frequently
share artwork with the standard printing, so no image-based matcher can separate
them. Finish stays an explicit choice, exactly as plan task G2 already required
("must not infer etched or foil solely from a still image").

## Engine choice

**DECIDED BY MEASUREMENT.** Both engines were benchmarked on the same 21-card
corpus (real Scryfall images, identical crops, ground truth from Scryfall's own
API). 18 cards carry a printed number; 3 do not. Graded per frame, so a correct
"I cannot read this" on a numberless card scores as a SUCCESS.

```
engine / config                          number   set     no-num  fabricated  median
tesseract.js @ 500x700 (matcher size)    10/15    11/15   4/6     5/21        114ms
tesseract.js @ 750x1050 (OCR crop only)  12/15     7/15   6/6     1/21        186ms
tesseract.js @ 750x1050 + 2x upscale     12/15     9/15   5/6     3/21        241ms
onnx trocr-small-printed @ 500x700        0/15     0/15   6/6     1/21        558ms
onnx trocr-small-printed @ 750x1050       0/15     0/15   6/6     4/21        608ms
```

**tesseract.js @ 750x1050 wins and is what shipped.** TrOCR scored ZERO. It is
trained on single-line document/receipt text, so this crop is far out of its
distribution — and it does not misread the strip, it IGNORES it and emits fluent
receipt boilerplate ("SEE BACK OF RECEIPT FOR AN OFFER", "TOTAL EXCHANGE AND
RECEIPT"). That failure shape is worse than a low score: confident, well-formed
text with no relationship to the card. It is also 3x slower.

The `onnxruntime-node` argument was that it adds no new dependency. It is also
worth noting it is only a TRANSITIVE dep (via `@huggingface/transformers`), not a
direct one. Either way an engine that is 0/15 is not a cheaper option, it is a
non-option, so tesseract.js was added as a direct dependency (~1.7MB package plus
a ~5MB English traineddata downloaded once and cached under `backend/data/ocr`).

The `fabricated` column is the one that matters most: how often an engine
returned a number that was wrong or invented. Rectifying the OCR crop at
750x1050 cut that from 5/21 to 1/21. The 2x upscale made it worse and was
dropped.

**Measured added latency: +193ms median** (min 110, p90 249, max 314) on the
2-core box, warm. A scan goes ~1100ms -> ~1293ms. Worker startup (~740ms) is paid
once at first use, not per card. OCR is opt-in per request (`ocr: true`), so any
path that does not ask for it pays nothing.

- The box is 2 cores / 2GB RAM.
- **Hard constraint:** a scan is ~1.1s after PR 22 lowered `RECALL_K` 250 -> 50.
  OCR on a small crop must not undo that win. Budget tens of milliseconds, and
  MEASURE it rather than assuming.

## Sequencing

1. ~~Global index builds~~ — done, 1.2GB, first ever on any box.
2. ~~Measure unscoped matching~~ — done: card 100%, printing 58%.
3. ~~Cut latency~~ — done: ~5s -> ~1.1s.
4. ~~OCR the collector number and set code from the rectified crop.~~ — done.
5. ~~Look up `card_cache` by name + number (+ set), and ask when ambiguous.~~ — done.
6. **UI for the review queue** — not built. See below.

---

## What shipped (backend only)

| file | role |
|---|---|
| `src/utils/collectorNumberOcr.js` | tesseract.js worker + the 750x1050 crop |
| `src/utils/collectorNumberParse.js` | raw OCR text -> `{number, set, confident}`, refuses junk |
| `src/utils/scanPrintingResolver.js` | catalogue lookup; decides add vs queue |
| `src/routes/collection.js` | `/scan-resolve`, `/scan-queue`, resolve, discard |
| `src/db.js` | `scan_review_queue` table + index |

### The safety property, stated plainly

**The catalogue is the validator.** OCR is only a lookup key. A misread like
`M1508` (observed in the benchmark) does not become a wrong card — no printing
has that number, so the lookup returns nothing and the card queues. The only
reads that can auto-add are ones that matched a real catalogue row exactly.

**A queued card is not owned, by construction.** The queue is a SEPARATE TABLE,
not a flag on `collection`. 52 queries across 15 files read `FROM collection`; a
flag would make correctness depend on all 52 (and every future query) remembering
to filter. A separate table means they cannot see queued cards even by mistake.

### API for the follow-up UI PR

```
POST /api/scan-match      { image, ocr: true }   -> adds `ocr: {number,set,confident,ms}`
POST /api/scan-resolve    { name, ocr_text, crop, finish?, quantity? }
                          -> { action: 'added', card }            (exactly one printing)
                          -> { action: 'queued', reason, candidates, queue_id }
GET  /api/scan-queue      -> { entries: [{ id, matched_name, reason, ocr, candidates, crop }] }
POST /api/scan-queue/:id/resolve  { card_id, finish, quantity }
DELETE /api/scan-queue/:id
```

`reason` is one of `unreadable`, `no_number`, `ambiguous`. `candidates` are
pre-sorted owned-first (PR 6I banding), so the common case is the first row.

**Finish is never inferred.** `/scan-resolve` passes the client's explicit finish
through; nothing reads pixels to decide it.

### What the UI PR must do — and what needs Zach's eyes

Nothing in this repo runs a browser, so none of the above proves any frontend
behaviour. An iOS Safari crash shipped through green tests this week. The UI PR
needs:

- A review screen reached AFTER scanning, never mid-scan. Adapt the existing
  scanner screen in place; do not replace it.
- Each entry: the scan thumbnail, the matched name, WHY it is queued (the three
  reasons need different wording — "this card prints no number" is not a
  failure), and the candidate printings owned-first.
- A visible pending count during scanning, so the queue is not a surprise.
- **Zach's phone is the real gate.** Test on iPhone 16 Safari: a 40-entry queue
  with thumbnails is the layout risk.
- Bulk actions ("apply this set to all remaining Sol Rings") are deliberately NOT
  built. Measure a real queue first.
