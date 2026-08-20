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

- Modern frames: bottom-left, small white text, `123/456` or `123`, with the set
  code and rarity beside it. Measured: that strip is **~28px tall** in the
  pipeline's existing 500x700 rectified image (`scanMatch.js:47`), which is above
  the usual 20px OCR threshold. If it proves marginal, rectify **only the OCR
  crop** at 750x1050 (~42px) — do not change the size used for matching, which is
  tuned and working.
- Older frames: **no collector number is printed at all.** Cards before roughly
  1996 cannot be disambiguated this way. The information is physically absent —
  this is not a gap to engineer around.
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

- `onnxruntime-node` is **already a dependency** (CLIP uses it), so an ONNX text
  recogniser adds no new native dependency.
- `tesseract.js` is pure JS/WASM, heavier and slower, but simpler to wire up.
- The box is 2 cores / 2GB RAM.
- **Hard constraint:** a scan is ~1.1s after PR 22 lowered `RECALL_K` 250 -> 50.
  OCR on a small crop must not undo that win. Budget tens of milliseconds, and
  MEASURE it rather than assuming.

## Sequencing

1. ~~Global index builds~~ — done, 1.2GB, first ever on any box.
2. ~~Measure unscoped matching~~ — done: card 100%, printing 58%.
3. ~~Cut latency~~ — done: ~5s -> ~1.1s.
4. **OCR the collector number and set code from the rectified crop.**
5. Look up `card_cache` by name + number (+ set), and ask when ambiguous.
