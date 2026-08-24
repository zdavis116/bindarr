# Bindarr Scanner — Architecture & Rebuild Plan

**Date:** 2026-08-24
**Status:** Research complete. Not yet implemented.
**Bar:** ManaBox — ~1 card/sec, no set pre-selected, ~5 wrong per 1000 (0.5%),
scanner idles when no card is present, works on Zach's existing setup.

---

## PART 1 — WHY THE CURRENT SCANNER CANNOT REACH THE BAR

### 1.1 Measured per-card cost (iPhone 16 → dev over Tailscale)

```
capture + JPEG encode on phone     ~700ms
upload ~800KB                      ~700ms
server: CLIP recall                 170ms
server: ORB verify (24 cands)      ~850ms   floor — does not improve below K=12
server: rectify + OCR               630ms
response handling                   150ms
                                  ~3.2s
```

**~1.5s is pure transport.** With an instantaneous server the architecture still
lands at ~1.6s/card. ManaBox is ~1.0s **because identification never crosses the
network.** This is a shape problem, not a tuning problem.

### 1.2 Three structural faults, each observed in production traces

| Fault | Evidence from `SCAN_TRACE` |
|---|---|
| **Capture is on a timer, not gated on a card** | 3 of 14 scans in one session: `detection:false`, ~270KB upload vs ~800KB normal. Blind captures burning ~4s each. This is "it took 5 tries". |
| **Contour detection is unreliable** | Quad aspect measured 0.611–0.732 against a card's true 0.716. Bad quads correlate 1:1 with *both* OCR failure *and* low inliers — one root cause, two symptoms. |
| **ORB used as a search engine, not a verifier** | Global search over 57,583 cards. Fails on low-texture art: basic lands score 9–15 inliers vs 52–94 when it works. |

### 1.3 Faults already fixed (shipped 2026-08-23/24)

- CLIP recall had **never run in production** — model unreachable, silent fallback to ORB alone. PR #47.
- `match_inliers` never sent from client → `low_confidence` flag was dead code since written. PR #49.
- OCR set code discarded the matcher's known set. PRs #48/#49.
- Container was 2GB; CLIP+ORB peak 926MB RSS — thrashed. Raised to 4GB.

---

## PART 2 — WHAT THE FIELD ACTUALLY DOES

Sources reviewed: tmikonen *Magic Card Detector* (2020), thoughtseize.io C++/OpenCV,
**1vcian/Pokemon-TCGP-Card-Scanner** (production, in-browser), **reeshof/MTG-card-scanner**
(deep learning, 98.8% on 58k cards), TCGplayer *Roca Vision*, Lotus Scan, Delver Lens.

### 2.1 The Pokémon scanner's documented dead ends are our current design

1. *"OpenCV template matching / feature detection — inaccurate and inefficient
   due to the ever-growing number of cards"* ← **our ORB**
2. *"Contour + polygon extraction — extraction quality still inconsistent,
   frequent misdetections or missed cards"* ← **our `detectCard`**
3. **YOLO11-nano OBB** → Box precision **99.5%**, mAP50 98.5%. Trained on
   **synthetic data**: real card images composited onto random backgrounds with
   random transforms. No manual labelling.
4. **RGB perceptual hash**, precomputed, IndexedDB, Hamming lookup. Explicitly:
   RGB *"allowed the system to differentiate between cards with similar layouts
   but distinct color schemes."*

### 2.2 tmikonen's confidence test

Recognition confidence should be **statistical**, not a fixed threshold: is the
best distance more than 4 standard deviations below the mean of all distances.
This is what decides auto-add vs ask.

### 2.3 reeshof: deep embedding, 98.8% across all 58,000 cards

FaceNet-style triplet-loss embedding + CenterNet detection. Proves a learned
embedding handles the full catalogue where hashing alone struggles.

---

## PART 3 — EXPERIMENTS RUN (real data, not theory)

### 3.1 Does pHash discriminate Magic cards?
1199 real Scryfall images (msh/tla/khm), 50 basic lands.

```
63-bit  pHash: collisions between DIFFERENT cards: 0   same card (variants): 17
255-bit pHash: collisions between DIFFERENT cards: 0   same card (variants):  6
```

**Never confuses two different cards** on clean art. Collisions are art variants,
which the collector number settles.

### 3.2 Method shootout on Zach's REAL photos (full 1199-card index)

σ = standard deviations below mean (tmikonen's confidence measure).

| method | top-1 | σ correct (avg/min) | σ wrong (max) | separable? |
|---|---|---|---|---|
| grey64 | 7/12 | 3.31 / 2.49 | 3.04 | no |
| rgb189 | 10/12 | 3.52 / 2.76 | 3.06 | no |
| **rgbArt** | **12/12** | **5.13 / 3.44** | — | — |
| dhash | 11/12 | 4.11 / 3.22 | 2.67 | **yes** |
| ensemble | 12/12 | 4.27 / 3.35 | — | — |

**`rgbArt` = RGB hash of the whole card ‖ RGB hash of the art box (378 bits).**

Why it wins: the whole-card hash carries frame/colour/layout; the art-box hash
carries only the artwork — the region that actually differs between two cards of
the same colour and frame. Same principle as the collector-number work: **use all
the signal.**

Greyscale → RGB fixed every basic land (three went from `Giant Growth`/`Suki` to
correct `Plains`). Forest/Plains/Mountain differ chiefly by **colour**; greyscale
deletes the only discriminating signal.

### 3.3 The scale test — and what it actually revealed

```
378-bit rgbArt, 849 DISTINCT cards. Distance to nearest different card:
   min 12   p1 26   p5 82   median 108

Zach's real photos land 26-64 bits from the CORRECT card.
```

At first reading these overlap and hashing looks unsafe at scale. **Then I
printed the actual colliding pairs**:

```
d=12  A-Elven Bow                <-> Elven Bow
d=22  A-Return Upon the Tide     <-> Return Upon the Tide
d=24  A-Vega, the Watcher        <-> Vega, the Watcher
...   17 pairs, ALL of this form
```

**Every single collision is an Arena rebalanced card** (`A-` prefix) — a
digital-only variant that reuses the paper card's artwork with tweaked rules
text. **They do not exist as physical cardboard.** Zach can never scan one.

> **With `game:paper` applied, ZERO pairs collide within photo-noise range in an
> 849-card index.** My earlier conclusion — "hashing collides at scale, verify is
> mandatory" — came from comparing physical cards against digital-only cards that
> cannot be scanned.

**Consequences for the design:**
1. **The index filter is load-bearing, not housekeeping.** `game:paper`, exclude
   digital-only. One filter removed 100% of observed collisions.
2. The **verify stage (④) drops from mandatory to a safety net** for genuine
   same-art reprints — which Zach's own rule already resolves via the collector
   number.
3. Recall-only may be sufficient. **Still to be proven at ~35k scale in Phase 1**,
   but the outlook is far better than the raw 12-bit figure implied.

### 3.4 Production scale is 3x smaller than assumed

Measured from the dev database and Scryfall:

```
card_cache rows (printings)     : 104,535
DISTINCT card names             :  34,524    <- recall's real target
msh: 453 printings              ->  403 unique artworks (11% dedupe)
observed sample: 1199 printings ->  849 distinct (29% dedupe)
```

Zach's rule — art identifies the **card**, the collector number picks the
**printing** — means recall only has to separate ~35k distinct cards, not 105k
printings. Printings of one card share artwork, so the duplicates are harmless
by construction.

### 3.5 Index size

```
 64-bit  x 35,000 cards = 0.3 MB
378-bit  x 35,000 cards = 1.7 MB
378-bit  x 105,000 prints = 5.0 MB
```
vs the current **1.1GB ORB index + 336MB CLIP model**.

---

## PART 4 — TARGET ARCHITECTURE

```
┌─ PHONE (browser / PWA) ─────────────────────────────────────────────┐
│                                                                      │
│  video stream                                                        │
│      │  requestVideoFrameCallback (~60fps)                           │
│      ▼                                                               │
│  ① DETECT — YOLO11-nano OBB via onnxruntime-web                      │
│      runs every ~3rd frame (~15-30ms)                                │
│      outputs: oriented box + confidence                              │
│      NO CARD  -> idle. no capture, no upload, no work.               │
│      CARD     -> draw the outline where it was actually found        │
│      │                                                               │
│      ▼  stable for N frames                                          │
│  ② WARP — perspective transform to 488x680 (canvas/WebGL)            │
│      │                                                               │
│      ▼                                                               │
│  ③ RECALL — rgbArt 378-bit hash, Hamming vs IndexedDB (~5MB)         │
│      ~1ms. Returns top-K candidates + sigma confidence.              │
│      │                                                               │
│      ▼                                                               │
│  ④ VERIFY — only when sigma is marginal or top-2 are close           │
│      (a) collector-number OCR on the warped crop, OR                 │
│      (b) small embedding model over the top-K                        │
│      │                                                               │
│      ▼                                                               │
│  ⑤ DECIDE                                                            │
│      confident  -> add to stack locally, keep scanning                │
│      ambiguous  -> stack row with a top-3 picker                      │
│      unknown    -> stack row flagged, crop retained                   │
│                                                                      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ (not in the hot path)
                               ▼
┌─ SERVER ─────────────────────────────────────────────────────────────┐
│  /api/scan/index.bin   versioned hash index, gzipped, cached         │
│  /api/collection/add   the write. batched, not per-card.             │
│  /api/cards/:id        prices, metadata, catalogue for unknowns      │
│  fallback identify     when the client cannot decide at all          │
└──────────────────────────────────────────────────────────────────────┘
```

**Target: ~300–500ms per card, no network round trip for identification.**

### 4.1 Why each stage exists

| Stage | Why | Replaces |
|---|---|---|
| ① YOLO OBB | Contours measurably fail (0.611–0.732 aspect). Gates capture on a card being present — kills blind scans. | `detectCard` + timer loop |
| ② Client warp | Removes the upload from the hot path. | server `rectifyCard` |
| ③ rgbArt recall | 12/12 on real photos, 5MB, ~1ms, no model. | CLIP recall + ORB search |
| ④ Verify | Hashing alone collides at 110k scale (§3.3). | ORB verify (kept in spirit) |
| ⑤ Local decide | No round trip; stack is the single surface. | review queue |

---

## PART 5 — STEP-BY-STEP PLAN

Every phase is independently shippable, independently testable, and gated on a
measurement. Production is untouched throughout.

### Phase 0 — Ground truth (½ day) — **BLOCKING**
Cannot claim improvement without a labelled set.
- Label the ~40 dump scans with true card IDs.
- `npm run scan:bench` → accuracy, p50/p95 latency, detection rate.
- **Gate:** current pipeline produces a baseline number. Everything is compared
  to it from here on.

### Phase 1 — rgbArt hashing, server-side, SHADOW MODE (1.5 days)
Lowest risk. No client change, no behaviour change.

**1a. Build the index — there is NO local image cache.** (corrected: the plan
previously assumed one; the dev box has none *and* cannot reach the Scryfall CDN.)
- Pull Scryfall bulk `default_cards`, filter **`game:paper`** and drop
  digital-only printings. This filter is load-bearing — see §3.3, it eliminated
  100% of observed hash collisions.
- Deduplicate by `illustration_id`: printings sharing artwork share a hash.
- Download images on a host that CAN reach Scryfall, rate-limited (~10/s,
  ~1 hour unattended), hash them, and ship the finished **~2MB index** to dev.
  Card images are never stored on the app host.
- **Gate 1a:** index covers ≥99% of `card_cache` rows; measure the real
  nearest-neighbour distribution at full scale and confirm §3.3 holds at 35k.

**1b. Shadow mode.**
- Compute the query hash on every scan; **log** its answer alongside ORB's.
  Change nothing the user sees.
- **Gate 1b:** rgbArt ≥ ORB on the Phase-0 set over a real scanning session.

### Phase 2 — rgbArt primary, ORB retired (1 day)
- Promote rgbArt to the identifier. Retire the 1.1GB ORB index and 336MB CLIP.
- Confidence = σ test (§2.2), not a magic threshold.
- Collector number becomes the **printing** tie-break only.
- **Gate:** accuracy ≥ Phase 1; server time ~1.6s → ~200ms.

### Phase 3 — Ship the index to the browser (2 days)
- `/api/scan/index.bin` — versioned, gzipped, ~2MB.
- Client caches in IndexedDB; service worker for images.
- **Request `navigator.storage.persist()`.** iOS evicts an origin's storage
  wholesale after ~7 days without interaction, and Zach scans in bursts — so the
  cache CANNOT be assumed durable. The scanner must fall back to the server path
  transparently while the index re-downloads.
- Identification moves to the phone. Server sees only the collection write.
- **Gate:** accuracy identical to Phase 2; ~1.4s round trip disappears; a cold
  start with an evicted cache still scans (via fallback) rather than blocking.

### Phase 4 — YOLO OBB detection (3–4 days) — **the risky one**
Fixes "5 tries" and "wrong part of the card".

**4a. SPIKE FIRST — half a day, before any training work.**
onnxruntime-web has confirmed open iOS bugs (WebGPU unsupported on iOS at all;
CPU/memory blowups in WebKit 26; large WASM files crashing the tab). Ship a
throwaway page that loads a stock YOLO11-nano ONNX on **Zach's actual iPhone 16**
and reports per-frame latency and stability.
- **Gate 4a:** ≥15fps sustained, no tab crash over 5 minutes. **If this fails,
  Phase 4 is abandoned** and detection stays server-side — Phases 1–3 still stand.

**4b. Train and integrate.**
- Synthetic training data: composite real card images onto random backgrounds
  with random rotation/scale/perspective/blur/lighting. No manual labelling.
- Train YOLO11-nano OBB → ONNX → onnxruntime-web.
- **Gate 4b:** detection ≥99% on the labelled set (currently ~85%); quad aspect
  distribution tightens around 0.716.

### Phase 5 — Presence-gated continuous scanning (1 day)
- `requestVideoFrameCallback`; detector every ~3rd frame.
- No card → idle. Card appears and stabilises → identify. Same card still there
  → do not re-scan. New card → scan.
- **Gate:** zero blind captures; a 20-card stack needs no taps.

### Phase 6 — Queue folded into the stack (1 day)
- No separate review queue. Everything lands in the stack; low-confidence rows
  carry a top-3 picker from the ranked candidates.
- **Gate:** queue table unused; every scan visible in one place.

---

## PART 6 — RISKS, STATED PLAINLY

| Risk | Severity | Mitigation |
|---|---|---|
| **Hashing collides at scale** | ~~HIGH~~ **LOW** | §3.3: every observed collision was an Arena digital-only card. `game:paper` removed 100% of them. Still gated on a real 35k-scale measurement in Phase 1. |
| **iOS evicts the cached index** | MED | WebKit evicts *per origin, as a whole*, after ~7 days without interaction. Zach scans in bursts. Mitigations: call `navigator.storage.persist()` (usually granted to home-screen PWAs, **not guaranteed**); check `navigator.storage.estimate()`; **the scanner must work via server fallback while the index re-downloads**. "Cached once" was wrong — the correct framing is *cached opportunistically with a working fallback*. |
| **onnxruntime-web is unreliable on iOS** | **HIGH** | Confirmed open bugs: WebGPU unsupported on iOS regardless of browser (#22776); severe CPU/memory issues in Safari/WebKit 26 with JSEP (#26827); large WASM files crash the tab (WebKit #314551). **Phase 4 must begin with a spike on Zach's actual iPhone before any training work.** Fallback: keep detection server-side, identification client-side. |
| **No local image cache exists** | MED | §Phase 1 corrected: the plan previously assumed one. Build the index on a machine that can reach Scryfall, ship the finished ~2MB index. Images are never stored on the app host. |
| YOLO training may not converge | MED | Phases 1–3 deliver most of the speed **without** it. Phase 4 can slip without blocking. |
| Foils / glare | MED | Art-box hash is less exposed than whole-card; collector number as tie-break; ambiguous → picker, never a silent guess. |

---

## PART 7 — WHAT IS EXPLICITLY *NOT* CHANGING

- Not a new app, not a framework change, not a rewrite of the collection code.
- The scan **path** is replaced. Staging, collection, prices, the UI shell all stay.
- Production is untouched. Everything lands on dev via the existing deploy flow.
- One phase at a time, each behind a measurement gate. No big-bang cutover.

---

## PART 8 — OPEN QUESTIONS (to answer with measurement, not argument)

1. Does rgbArt hold at 110,000 printings? §3.3 says it will need the verify
   stage. **Phase 1 answers this on real data before anything is promoted.**
2. What is onnxruntime-web's real latency on Zach's iPhone 16? Unmeasured.
   **Must be benchmarked before Phase 4 is committed.**
3. Can the collector-number OCR reach ~100% once detection is fixed? Currently
   ~50% on lands, and §1.2 shows bad quads cause it. Phase 4 may fix it for free.
4. Is a trained embedding needed as the verify stage, or is OCR enough? Decide
   after Phase 2 with real numbers.
