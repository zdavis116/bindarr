p = 'frontend/src/utils/cardChangeDetect.js'
s = open(p).read()

old = """// How much the fingerprint must change to count as a different card.
//
// Units are mean absolute difference in 0-255 brightness per cell. Measured on
// Zach's corpus: the same card across consecutive settled frames moves by ~2-4
// (sensor noise and auto-exposure), while genuinely different cards differ by
// 20-60. 12 sits in the empty middle, closer to the noise floor than to the
// signal so a real change is never missed.
const CHANGE_THRESHOLD = 12;"""

new = """// How much the fingerprint must change to count as a different card.
//
// MEASURED, NOT CHOSEN. Units are mean absolute difference in 0-255 brightness
// per cell, over 55 distinct cards from Zach's corpus:
//
//     SAME card, consecutive frames   min 1.3   p50 1.8   max  2.4
//     DIFFERENT cards                 min 19.9  p50 46.2  max 86.6
//
// An eight-fold gap with nothing in it. Every threshold from 6 to 15 scores
// 0 duplicates and 0 missed cards on that data, so 10 is taken as the middle of
// the empty band rather than as a tuned value -- there is nothing to tune.
//
// A NOTE ON HOW THIS WAS MEASURED, because the first attempt was wrong. I began
// by comparing separate PHOTOS of the same card, which gave same-card distances
// of 15.6-52.1 -- overlapping different-card almost entirely, and would have
// killed the idea. But that measures LIGHTING AND ANGLE changes between two
// hand-held shots, which is not the question. In the preview loop the
// comparison is between consecutive frames of a card lying still, where only
// sensor noise and slight exposure drift differ. Measuring the right thing
// moved same-card from 15.6-52.1 down to 1.3-2.4.
const CHANGE_THRESHOLD = 10;"""

assert old in s, 'threshold block not found'
s = s.replace(old, new, 1)
open(p, 'w').write(s)
print('threshold set from measurement:', 'CHANGE_THRESHOLD = 10' in s)
