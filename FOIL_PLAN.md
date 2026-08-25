# FOILS — WHY THEY FAIL AND WHAT TO DO

**Status: root cause identified and measured. Step 1 implemented. Steps 2-3
proposed, not built.**

## The evidence

Zach's 33-scan session, ORB inliers for the top candidate:

```
correct identifications   47 61 63 65 68 73 84 96 98 100 105 116 126 141
wrong / foil guesses       4  7  8  8  8  9  9 10 10  10  11  12  19  23
```

Two clean populations. Foils sit in the noise band.

The clearest single case: **four photos of the same foil Evil's Thrall**
produced **four different wrong names** — Fall of the Titans, Oust, Trinisphere,
Burst of Speed — at 8-10 inliers each. On the same four photos OCR read the
card's printed address, `msh #128`, **correctly every time**.

That is the whole finding: on foils, edge matching degrades to guessing while
the printed text survives intact.

## Why

ORB matches corners and edges. Foil is a diffraction layer: it scatters light
into thousands of high-contrast specular features that move with the camera.
Those features are not on the card in any stable sense, but they look exactly
like the features ORB is built to find, so they crowd out the real ones.

rgbArt does not rescue it — measured on the same session, foil scans sat at
distance 98-114 with margins of 0-8, against 32-58 with margins of 40-64 on
clean identifications. The glare changes the colours it hashes. **Both image
methods fail on the same cards for the same physical reason.**

The collector number survives because it is small, high-contrast, matte black
on a white strip, and printed OUTSIDE the foiled art area on most frames.

## What ManaBox does differently

Zach's control: ManaBox handles these cards on his exact setup. Two independent
open-source scanners (cardboard-scanner, and the hybrid OCR+art scanner writeup)
describe the same architecture, and it is the inverse of Bindarr's:

> **OCR the text first; use perceptual hashing as the FALLBACK for worn cards,
> glare, foils, and non-English printings.**

Bindarr matches art first and consults text only when art finds nothing. That
ordering is correct for clean cards and exactly backwards for foils.

## Step 1 — SHIPPED: a weak art match cannot outrank the printed number

The bug was not that the art match was weak. It is that **nothing downstream
knew it was weak**. `resolveScannedPrinting` received a card name with no
indication of whether it came from a 141-inlier identification or an 8-inlier
guess, so it treated both as "the art decided it". The strip's answer was
demoted to a tiebreak, and the OCR-address fallback — which only runs when the
name resolves to nothing — was unreachable.

Now: when inliers are at or below `WEAK_MATCH_INLIERS` (25, chosen at the top of
the measured noise band) **and** the strip resolves to exactly one real
printing, the printed address wins.

Deliberate limits, each pinned by a test:

- a STRONG match is never overridden (`FWEAK-TC2`)
- unknown match strength behaves exactly as before (`FWEAK-TC3`)
- a number matching nothing real never adds a card (`FWEAK-TC4`)

The threshold is set at the top of the noise band on purpose. Calling a real
match "weak" only costs a redundant catalogue lookup that agrees. Calling noise
"strong" puts a card Zach does not own into his collection silently — the
failure this project must not have.

## Step 2 — PROPOSED: read the title, not just the number

The card's NAME is printed in large high-contrast text at the top, and the
scanner already OCRs it (`cardTitleOcr`, ~435ms). On a foil the title is the
single most legible thing on the card.

Today the title is consulted first in `resolveScannedPrinting`, which is right —
but it is only as good as the OCR, and the title read is not currently measured
on foils at all. Before building anything: **measure title-OCR accuracy on the
foil scans specifically.** If it reads reliably, foils are a solved problem and
no new machinery is needed.

This is a measurement, not a feature, and it should be done before Step 3.

## Step 3 — PROPOSED, and only if Step 2 is insufficient: glare suppression

Options, cheapest first:

1. **Polarisation by capture** — ask for a second frame at a slightly different
   angle and keep the one with less specular area. Zero model work; costs a
   frame. Measurable: specular pixel fraction is easy to compute.
2. **Specular masking before matching** — detect blown-out regions (high value,
   low saturation) and exclude those keypoints from ORB. Classical, cheap, and
   it attacks the exact mechanism.
3. **Train on foils** — the synthetic dataset has no foil augmentation. Adding
   simulated specular streaks would help the DETECTOR, but detection is not what
   is failing here; matching is. Low priority.

## What NOT to do

- **Do not lower the match threshold to "accept" foils.** That converts silent
  wrong answers into more silent wrong answers.
- **Do not tune rgbArt for foils.** Measured: it fails on the same cards for the
  same physical reason. It is not a fallback for this.
- **Do not treat "it queued" as the bug.** On the foil scans, queueing was the
  CORRECT behaviour — the scanner genuinely could not tell. The real bug is the
  three cards that got through with confident wrong names, and Step 1 addresses
  exactly those.
