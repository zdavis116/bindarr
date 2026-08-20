# Collector-number OCR: resolve the exact printing from a scan

Zach, 2026-08-20: *"I want collector-number OCR so it gets the exact printing."*

Right call. Deck identity is exact-only, so a wrong printing propagates into
availability, buylists and deck matching — and he chooses printings on price.

---

## What the measurements changed about the design

Measured on the dev box, unscoped, against the new global index:

```
card identity   12/12  (100%)
exact printing   7/12  (58%)
```

The five misses were all the same shape — right card, wrong printing, because
the artwork is shared:

```
Sol Ring (c21)           -> v10
Counterspell (mh2)       -> ema
Birds of Paradise (m12)  -> rav
Swords to Plowshares     -> ddf
Wrath of God (10e)       -> 2xm
```

**The critical detail: `printing rank` was `-1`, not 3 or 5.** The correct
printing was not in the candidate list AT ALL.

That is because the index is built from Scryfall's `unique_artwork` bulk: one
entry per distinct illustration. A C21 Sol Ring and a CMM Sol Ring collapse to a
single entry, so the other printings are not candidates that ranked badly —
they were never there.

### Consequence: OCR cannot be a re-ranker

The obvious design — read the number, reorder the candidates — **cannot work**,
because the right answer is absent from the list.

Instead:

1. Image match identifies the **card** (100% reliable in testing).
2. OCR reads the **collector number** from the photo.
3. Look the printing up in `card_cache` by **name + number**, optionally
   narrowed by a set symbol or the number's format.

So OCR is a *catalogue lookup key*, not a scoring signal. This is the single
most important thing the measurement taught us, and it was not obvious before.

---

## Where the number is, and when it is not

- Modern frames (post-2015 especially): bottom-left, small white text, of the
  form `123/456` or just `123`, usually with the set code and rarity beside it.
- Older frames: **no collector number is printed at all.** Cards before roughly
  1996 cannot be disambiguated this way. This is not a gap to engineer around —
  the information is physically absent.
- Some printings use non-numeric or suffixed values: `123a`, `★`, `A-12`,
  `GR1`. Scryfall stores `collector_number` as a STRING for this reason. Any
  parse that assumes an integer will silently mangle these.

## What must happen when OCR is uncertain

**Ask. Never guess.**

A misread number is worse than no read: it would silently record a printing Zach
does not own, which is the exact failure class this project blocks merges over,
and it would then flow into availability and buylists.

The rule already established across the app applies unchanged:

- Confident read that matches exactly one catalogue printing -> use it.
- Confident read matching several (or none) -> show the options, let him choose.
- Low-confidence read, or no number on the card -> show the printings of that
  card and let him pick. Do not default to "most likely".

An "I could not read it" outcome is a success, not a failure, as long as it says
so.

## Open questions to settle before building

- **Which OCR engine?** The box already runs ONNX for CLIP, so an ONNX-based
  text recogniser avoids a new native dependency. Tesseract is the obvious
  alternative but adds a system package.
- **Crop before OCR.** The pipeline already rectifies the card to a known
  geometry (`WARP_W`/`WARP_H` in `scanMatch.js`), so the collector number sits in
  a predictable region. OCR on a small crop of a rectified card is a far easier
  problem than OCR on a whole photo, and much faster.
- **Latency budget.** A scan is now ~1.1s after the RECALL_K change. OCR on a
  small crop should be tens of milliseconds; it must not undo that win.
- **Does it need the set too?** A collector number alone is not unique across
  sets. Name + number narrows a long way, but `123` exists in many sets. Reading
  the set code (three or four capital letters, adjacent to the number on modern
  frames) may be necessary — and it is the same crop.

## Sequencing

1. ~~Global index builds~~ — done, 1.2GB.
2. ~~Measure unscoped matching~~ — done: card identity 100%, printing 58%.
3. ~~Cut latency~~ — done: RECALL_K 250 -> 50, ~5s -> ~1.1s.
4. **OCR the collector number and set code from the rectified crop.**
5. Look up `card_cache` by name + number (+ set), and ask when ambiguous.
