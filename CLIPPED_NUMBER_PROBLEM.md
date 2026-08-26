# The 13% clipped-number problem

**Status: open. Two fixes measured and rejected. Do not retry either without new evidence.**

## The symptom

A scan reads the SET LINE cleanly and produces NO NUMBER at all:

```
'MSH *EN % MINTAUT'      -> set msh, number null   (Evil's Thrall)
'DRC * EN ¥ Wisny |'     -> set drc, number null
```

Both of Zach's queued cards on 2026-08-26 were this shape. It affects
**29 of 218 captures (13%)**.

Looking at the actual OCR crop, the number line is **sliced in half at the top
edge of the window** while the window's lower half sits on desk below the card.
The number itself is perfectly legible in a wider crop — and one of the two
queued cards read its number correctly on a *different capture of the same
physical card* minutes earlier.

So it is not a bad photo. It is the window landing differently on that crop.

## Why it moves

`STRIP` is a fraction of the RECTIFIED IMAGE's height. `rectifyCard` maps the
detector's quad corners onto the output corners, so whatever the quad includes
gets stretched across the output. Frame-to-frame variation in the quad moves the
strip's position within the window.

## What was tried

### 1. Retune the window (rejected)

24 positions swept against 93 labelled captures, scored on exact agreement with
ground truth:

```
  top 0.845 h 0.100  ->  22 correct,  7 wrong
  top 0.855 h 0.100  ->  26 correct,  4 wrong
  top 0.870 h 0.100  ->  32 correct,  4 wrong   <- shipped
  top 0.880 h 0.100  ->  27 correct,  3 wrong
  top 0.890 h 0.100  ->  26 correct,  1 wrong
```

**The shipped value is the peak in both directions.** This constant has now been
swept four times; this is the first time it held. There is no fixed fraction
that works, because the thing it is a fraction OF keeps changing.

### 2. Anchor the window to the card's detected bottom edge (rejected)

Built `cardBottomEdge.js`: scan up from the bottom of the rectified image for the
card's dark border, place the window relative to that.

```
              correct  wrong
  before        65       8
  after         66      10
```

**+1 correct, +2 wrong.** Fails the standing rule that a wrong read (can add the
wrong card to a collection of physical objects) costs far more than a silent one
(costs one tap).

It fired on **69 of 93** captures — far more than the 13% that were broken — so
it was mostly perturbing cases that already worked. Edge detection on a
black-bordered card against a dark mat is not reliable enough to anchor on.

### 3. Tighten the quad to a true card aspect before warping (rejected)

A Magic card is 63x88mm, aspect 0.716. Detected quads run p50 0.745, and 161 of
218 are WIDER than a real card. Corrected the quad about its centre before the
warp.

```
  quad AS-IS      correct 65   WRONG 8    silent 20
  quad TIGHTENED  correct 46   WRONG 20   silent 27
```

**Worse on every axis.**

The reason kills the whole approach, not just this implementation. Measuring the
non-card margin at each edge of the rectified image:

```
  top     p50 0.016
  bottom  p50 0.026
  left    p50 0.018
  right   p50 0.029
```

**All four edges are 2-3% — the slack is symmetric and small.** A centre shrink
therefore pulls the opposite edge INTO real card content and clips the strip
from the other direction, which is what the jump from 8 to 20 wrong reads is.

The quad is already about as tight as the model makes it. An earlier reading of
"failures carry ~7.5% desk" was almost certainly picking up the card's own black
border, not desk.

## What is left

The failures are not a fixable geometric offset. They are the tail of a
distribution: the quad varies a couple of percent frame to frame, and
occasionally that is enough to clip a ~2mm line of text.

**The approach that would work is different in kind — a RETRY, not a tuning
change:** when the strip yields a set line but no number, re-read at a shifted
offset and accept a reading only when the catalogue confirms it.

Properties that make it worth doing:

- costs time **only on failures**, so the 87% that work are untouched
- cannot introduce a wrong read that the catalogue does not already accept
- does not depend on detecting the card's edge, which has now failed twice

Cost: extra OCR passes on ~13% of scans, against a scan that is currently ~2.5s.
That is a real speed/correctness trade and should be built deliberately.

## Standing rule this document exists to protect

Every attempt here looked obviously right before it was measured, and two of the
three made things worse. **Measure against the labelled corpus with a held-out
split before shipping, and reject anything that increases wrong reads regardless
of what it does to correctness.**
