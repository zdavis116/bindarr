# SCANNER CAPTURE REDESIGN — what the industry actually does

**Status: researched, not built. This is a proposal for Zach to approve or
redirect.**

Zach: *"this scanner is not working it's just not getting any better.
Recommending researching the internet for the best way to scan cards by
detecting one is in the camera view."*

He is right that patching was not converging. I made three attempts at the
same problem in the wrong layer. This is what the field actually does.

## What I built, and why it kept failing

Auto-scan fires on a **retry timer** (350-2500ms). Sharpness is checked at
capture time. Then I tried to suppress duplicates by guessing, from a preview
frame, whether the card was "new":

1. coarse luma fingerprint of the detected region → **skipped real cards**
2. detector geometry: had the box moved? → **skipped real cards**
3. required a trusted match before suppressing → **still wrong cards scanned**

The premise was broken. Zach stacks each card in the **same position**, so
nothing moves, and two cards under identical lighting have near-identical
coarse luma. There is no reliable "different card" signal in a preview frame,
and a card that never gets scanned is the worst failure this app has.

## What every mature scanner does instead: STABILITY GATING

Not one of them captures on a timer. They all capture on a **detection that has
held still across consecutive frames**. Independently arrived at by:

**Dynamsoft** (Capture Vision SDK — same pattern in their Web, Android, iOS and
Flutter guides). A `QuadStabilizer` compares consecutive detections:

```
iouThreshold: 0.85          // overlap between this quad and the last
areaDeltaThreshold: 0.15    // how much the area may change
stableFrameCount: 3         // consecutive stable frames before capture
```
> *"When the boundary stays stable for a configurable number of frames, it
> triggers auto-capture."*

Movement resets the counter and the UI says *"Movement detected, hold steady."*

**docuSnap** (open-source JS document scanner):
> *"Stay-still countdown — After 10 consecutive passing frames, the library
> enters a brief hold-still phase to confirm stability. Best-frame selection —
> a rolling buffer retains the last 10 full-resolution camera frames along with
> their quality metrics."*

**CamScanner** ("Turn Page to Auto Capture"):
> *"The app must not snap a picture immediately; instead it needs to consider
> the stability of the book, whether fingers are obscuring the text, and changes
> in clarity."*

**Scanbot**: `autoCaptureSensitivity` plus a delay after detection
*"to prevent too many documents being captured in a row."*

### And for duplicates: REMOVE AND RE-PRESENT

Barcode scanners solved this decades ago. Zebra, Honeywell and Elo all ship the
same rule under the name **"Timeout Between Decodes, Same Symbol"**:

> *"The barcode must be out of the field of view for the timeout period before
> the scanner reads the same barcode again."* — Zebra
>
> *"This forces a 'remove and re-present' behavior and eliminates duplicates."*
> — Elo

The key detail: the item must **leave the field of view**. Not "look different"
— *leave*. That is an unambiguous physical event, and it is exactly what my
fingerprinting was trying and failing to infer.

## The redesign

**1. Capture on stability, not on a timer.**
The live detector already runs ~7×/second and produces a quad. Feed each
detection to a stabilizer:

- compute IoU against the previous detection
- if IoU ≥ threshold and area change ≤ threshold, increment a counter
- otherwise reset the counter and show *"Hold steady"*
- capture when the counter reaches N consecutive stable frames

This directly answers Zach's ask — *"detecting one is in the camera view"* —
because a stable quad IS a card sitting in view, observed rather than assumed.

**2. Duplicates: require the card to LEAVE the frame.**
After a successful scan, arm a latch. Do not capture again until the detector
reports **no card** for a few consecutive frames (the card was lifted away).
Then re-arm.

This is the barcode industry's remove-and-re-present rule, and it is robust
precisely because "no card detected" is unambiguous — unlike "is this a
different card", which is not answerable from a preview frame.

**Important consequence, and Zach should weigh in:** with a stack, the card
below is revealed when the top card is lifted. If he places a new card without
ever clearing the frame, the latch will not re-arm on its own. Two options:

- **(a)** stability gating alone re-triggers on a genuinely new placement,
  since laying a card down disturbs the quad enough to reset the counter and
  produce a fresh stable period. Simple, and no "leave the frame" requirement.
- **(b)** strict remove-and-re-present, which guarantees no duplicate but
  requires clearing the frame between cards.

Recommendation: **(a)**, with the identity check that already exists as the
backstop for true duplicates. (a) errs toward scanning, which is the correct
direction — a duplicate is visible and one tap to remove, a skipped card is
only findable by recounting cardboard.

**3. Best-frame selection (optional, later).**
docuSnap keeps a rolling buffer and captures the *sharpest* frame of the stable
period rather than whichever frame the timer landed on. Worth doing once the
above works, as it should reduce blur-driven misreads.

## Why this should actually converge

The current design asks a question that cannot be answered:
*"is the thing in front of the camera a different card?"*

The industry design asks a question that can:
*"has the detection held still long enough to be a deliberate presentation?"*

Every failure so far came from the first question. Nothing in my last three
attempts was a coding mistake — the question itself was wrong.

## Cost and risk

- Touches `CameraScanner.jsx` only: the stabilizer replaces the retry-timer
  trigger. No server change, no model change.
- The detector, the outline, and the sharpness gate all stay as they are.
- Reversible: it is one gate swapped for another.
- Thresholds must be tuned on **real scans**, not synthetic ones. That mistake
  has already cost two broken sessions this project.
