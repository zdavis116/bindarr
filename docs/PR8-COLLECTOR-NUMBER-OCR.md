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

---

## CORRECTION (2026-08-20): the set code is a tie-breaker, not a filter

Zach scanned Avatar Aang (`tla` #207) on an iPhone 16. The queue said:

```
Could not read the collector number.
Read: #M0207 · TAA
```

Two separate defects, and only one of them was the one first suspected.

### The real root cause: the RARITY LETTER, not the set

The card prints `0207/0286 M`. The `M` is the **rarity**, not part of the
number, and OCR returned it glued to the front. The parser accepted `M0207` as
a well-formed token (the same shape that exists for real values like `GR1`), so
it looked like a confident read — but **no printing has collector number
`M0207`**, so the catalogue lookup returned zero rows and the card queued as
`unreadable`. That is why the entry said "could not read the number" while
displaying the correct digits underneath.

The set filter was **not** what discarded it. `scanPrintingResolver` already
discarded a set filter that emptied the list. The number never survived long
enough for the set to matter.

**The fix is a second candidate reading, never a correction.** The parser now
also returns `numberAlt` — the rarity-letter-stripped reading — but leaves
`number` exactly as read. The resolver tries `numberAlt` **only** when the
number as read matched nothing at all. This matters: some cards genuinely carry
letter-prefixed collector numbers, so silently "fixing" one of those would turn
a correct read into a different printing of the same card. The catalogue, not
the parser, decides which reading was real. `F8P-TC12`'s rule stands.

### Is the set worth reading at all? YES, but only to disambiguate

Measured on the same corpus: number **12/15**, set **7/15**. The set is by some
way the least reliable thing OCR produces here, so it must never overrule the
two signals that are better than it.

The rule now implemented:

- **Name + collector number is the primary key.**
- The set is consulted **only when the number alone matched more than one
  printing**. When the number already yields exactly one row there is nothing
  to disambiguate, so a misread set has no way to do damage.
- A set filter that empties the list is discarded as a misread.
- A number matching nothing still never adds. The catalogue is still the
  validator.

Dropping the set entirely was considered and rejected: at 7/15 it is right
about half the time, and its *only* remaining job is choosing between printings
that already share a number — precisely the case where nothing else can
decide. Restricting it to that case keeps its upside and removes its downside.

## CORRECTION (2026-08-20): the focus gate is relative, not absolute

The sharpness gate shipped with an absolute threshold of 12, tuned against
synthetic box blur and flagged in the report as the one unvalidated number. On
a real iPhone 16 it rejected essentially every frame — Zach: *"hold steady
showed on like every card"* — so auto-scan stalled for three ticks and then
sent the best frame anyway, adding delay for nothing.

**An absolute constant cannot be right.** The score depends on sensor, optics,
lighting and the card's own art: a dark full-art card legitimately carries less
high-frequency detail than a white-bordered one. Any single number is
simultaneously too high for some legitimate frames and too low for others.

Replaced with a **rolling per-device baseline**: keep the last 8 scores, take
the **median** (unmoved by the blurred frames we are trying to detect, unlike a
mean), and reject only frames below **0.6x** that baseline. Until 4 samples
exist the gate **captures unconditionally** rather than guessing — that is the
key safety property, and it is exactly what the old version got wrong.

The no-stall bound is unchanged and is now a tested property rather than a
hope: `FSHARP-TC5b` drives the gate with adversarial score sequences and
asserts the gap between captures never exceeds `SHARPNESS_MAX_SKIPS`.

Observed scores and baselines are recorded and rendered in the scanner's
**existing** diagnostics panel, so if the gate misbehaves again the next fix is
measured rather than guessed.

**The manual scan button remains completely ungated** (`FGATE-TC4`).

### What only Zach's phone can confirm

Nothing in this repo runs a browser, a canvas or a camera, so every frame in
these tests is synthetic and every frontend assertion is a **source contract**.
The ratio removes the failure mode that a constant had, but only real use can
confirm that auto-scan now captures promptly on his iPhone 16.

---

## REDESIGN (2026-08-21): TEXT-FIRST — the artwork is no longer the primary key

Zach, looking at his own card: *"get name of card and set number and find it,
it should be unique majority of the time."*

He is right, and it reframes everything above. The design so far identified the
CARD by CLIP artwork matching and used OCR only for the collector number, which
made the **artwork a single point of failure**. Measured on his real photos:

```
clean Scryfall image  ->  MATCH Fated Firepower tla#132
his phone photo       ->  noise: Transpose 9 inliers, Outpace Oblivion 8,
                          Furnace Celebration 7
```

The card is **not foil and not sleeved** — he confirmed both. The cause is a
specular reflection from the **phone torch**: a small, intense source inches
from glossy modern card stock produces a blown-out patch where pixels SATURATE
and the information under them is destroyed, not merely brightened. That patch
sits on the artwork, which is exactly what CLIP reads.

In the SAME photo the title `Fated Firepower` and the bottom line
`M 0132 / TLA . EN` are both plainly legible to the eye. **The identifying
information on a Magic card is printed text, and printed text survives a
highlight that destroys artwork matching.**

### Resolution order (implemented)

1. **Title + collector number** is the primary key. Exactly one printing -> ADD.
2. **The set NARROWS ties. It never vetoes.** (measured: number 12/15, set 7/15)
3. **CLIP is the fallback and cross-check**, not the primary identifier. When a
   confident title+number resolves uniquely it is preferred even if CLIP
   disagrees — CLIP is what fails on a glared card.
4. An unreadable title falls back to today's behaviour: CLIP + number.
5. A title matching nothing NEVER adds. Unresolved still queues, owned first.

### Title band — MEASURED, not guessed

Same rectify-from-full-upload geometry as the number crop (`rectifyCard` at
750x1050 from the ORIGINAL buffer — never the matcher's 500x700 downscale).
15 real Scryfall cards, dom(2018)..tla(2025), ground truth from the API.

```
OFFSET sweep (left 0.06, width 0.64, height 0.060)
  0.030-0.034    0-2/15    above the title, in the border
  0.038          9/15
  0.042         14/15
  0.046-0.058   15/15  0 fabricated   <- clean run, centre 0.052
  0.062         13/15
  0.070+         0/15                 below the title, into the art
```

**WIDTH was the real discovery.** At width 0.80 the band scored 13/15 — but the
two failures were not misreads. The title read PERFECTLY and the **mana cost**,
right-aligned in the same band, came with it: `Fated Firepower X ee`,
`(a) Avatar Aang eP`. Mana symbols OCR as garbage letters, and that garbage is
edit distance the fuzzy matcher then has to pay for.

```
WIDTH sweep     0.58-0.70  ->  15/15  0 fabricated   <- clean run, centre 0.64
                0.74       ->  14/15
                0.78       ->  12/15
HEIGHT          flat 0.048-0.068 (all 15/15); centre 0.060
```

Final: `{ left: 0.06, top: 0.052, width: 0.64, height: 0.060 }`. Same lesson as
the number crop's 0.42 window dragging in the artist credit: **crop to the text
you want, not the region it sits in.**

**Zero fabrications at EVERY offset**, including those scoring 0/15 — when the
band misses, OCR returns border noise and the fuzzy matcher REFUSES it. The
number crop could not claim that; it had a cliff at 0.940 where digits merged
into confident wrong numbers.

Cost: **+125ms median** per scan (title read only, worker warm).

### Fuzzy tolerance — why 2 and not 3

```
real OCR reads resolved:  d=1 -> 14/15   d=2 -> 15/15   d=3+ -> 15/15
closest pairs of REAL Scryfall names:
  'Avatar of Woe'  <-> 'Avatar of Hope'   d=2
  'Sol Ring'       <-> 'The Ring'         d=3
  'Counterspell'   <-> 'Countersquall'    d=3
```

2 already buys full accuracy; 3 buys nothing measurable and lands in the range
where **distinct, simultaneously-legal cards collide**. `MIN_MARGIN = 2` over
the runner-up is the gate that does the real work — the hazard is not "bad read"
but "good read, two cards named almost the same".

### The truncation guard — found by the harness, not by reasoning

Under heavy glare `Sandstalker Moloch` read as `Sandstalker A`. That is 2 edits
from the real card **Sandstalker** and 5 from the true name, so plain distance
confidently picked the WRONG card with no runner-up close enough for the margin
gate. It was the single false add in 270 trials.

Edit distance **cannot** see this: a truncated read is genuinely nearer the
shorter name. The signal is structural — the winner being a strict prefix of
another candidate means the read is equally consistent with "the short card" and
"the long card with its tail destroyed". Those are different cards, so it
refuses. Exact reads are exempt, or short cards would be unscannable.

### Glare comparison — the evidence

Real cards, real OCR, real geometry; the glare and the CLIP degradation are
modelled (the 1.2GB global index lives only on the dev box). CLIP is modelled as
failing once >35% of the art region saturates, calibrated to the one real data
point: Zach's photo.

```
position     core   blown%   CLIP-only   text-first   text WRONG   rescued
centre-art   0        0.0%   15/15       15/15         0            0
centre-art   0.38    29.0%   15/15       14/15         0            0
centre-art   0.50    49.2%    0/15        6/15         0            6
centre-art   0.62    69.3%    0/15        3/15         0            3
upper        0.22     6.9%   15/15        1/15         0            0
upper        0.50    29.5%   15/15        0/15         0            0
lower        0.38     0.0%   15/15       15/15         0            0
lower        0.50     0.0%   15/15        2/15         0            0
TOTAL                        195/270     118/270       0            9
```

**Read the aggregate with care — it is the wrong question.** The two routes read
DIFFERENT PARTS of the card, so they fail under different geometry: glare on the
art destroys CLIP and leaves the title intact; glare on the nameplate does the
reverse. Summing across positions measures the mix of positions chosen, not a
property of the system.

The decision-relevant number is **RESCUED: 9** — cards CLIP alone loses that
text-first recovers, with **0 false adds**. Text-first is a FALLBACK CHAIN, not
a replacement, so it can only add identification routes: an unreadable title
still falls back to CLIP, which is why "text-first scores lower overall" is not
a regression.

**The first run of this harness was invalid** and it is recorded because the
shape recurs: the intensity range stopped below the threshold where the CLIP
model degrades at all, so CLIP scored a flawless 225/225 and the harness printed
"TEXT-FIRST DOES NOT BEAT CLIP". It had compared a damaged route against an
undamaged one. A comparison that never stresses the baseline ranks nothing.

### The gate that was the real single point of failure

The backend could not rescue a request it never received. `CameraScanner` gated
submission on `autoScan && confident && top?.name`, where `confident` is a
threshold on the ARTWORK match — so a glared card whose CLIP match collapsed
into noise was **never sent at all**, no matter how legible its text. Now the
condition is "we have something to identify with": a confident CLIP name OR an
OCR'd title.

### The torch

**The premise that the scanner turns the torch on was wrong.** `isTorchOn`
already initialised to `false` and no code path ever enabled it automatically
(now pinned by FTORCH-TC1/TC2). The actionable gap was different: nothing told
the user that enabling it **causes** the failure. "It's dark, turn on the light"
is the obvious move and the wrong one, so enabling it now warns once.

iOS Safari does not report `torch` in `getCapabilities()`, so it degrades to a
plain message rather than a dead button — **unverified here; no browser runs in
this repo.**

### What only Zach's phone can confirm

Nothing in this repo runs a browser, a camera or a MediaStreamTrack. Every
frontend assertion is a **source contract**, and the glare is synthetic. Only
real use on the iPhone 16 can confirm: that the title actually reads off his
camera at 1280px upload; that text-first recovers his Fated Firepower; that the
torch toggle behaves; and that the scanner screen still fits, given its iOS
Safari crash history.

### What the earlier UI PR required — and what still needs Zach's eyes

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
