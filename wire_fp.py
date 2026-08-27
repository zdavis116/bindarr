p = 'frontend/src/components/CameraScanner.jsx'
s = open(p).read()

# 1. Import.
anchor = "import { detectCardOnDevice"
i = s.index(anchor)
line_end = s.index('\n', i)
s = s[:line_end + 1] + "import { artFingerprint, isDifferentCard } from '../utils/cardChangeDetect';\n" + s[line_end + 1:]

# 2. Ref holding the fingerprint of whatever we last captured.
old_ref = "  const stablePeriodConsumedRef = useRef(false);"
new_ref = """  const stablePeriodConsumedRef = useRef(false);
  // Fingerprint of the card that was last CAPTURED, so a different card landing
  // in the same position still re-arms. See cardChangeDetect.js.
  const capturedPrintRef = useRef(null);"""
assert old_ref in s
s = s.replace(old_ref, new_ref, 1)

# 3. In the tick: compute the fingerprint and re-arm on a genuinely new card.
old_arm = """          disturbedRunRef.current += 1;
          if (disturbedRunRef.current >= DISTURBED_FRAMES_TO_REARM) {
            stablePeriodConsumedRef.current = false;
          }
        }
        prevDetRef.current = mapped;"""

new_arm = """          disturbedRunRef.current += 1;
          if (disturbedRunRef.current >= DISTURBED_FRAMES_TO_REARM) {
            stablePeriodConsumedRef.current = false;
          }
        }
        prevDetRef.current = mapped;

        // RE-ARM WHEN THE CARD ITSELF CHANGES, NOT ONLY WHEN THE BOX MOVES.
        //
        // Zach: "I put down 3 forest in a row and it only scanned the 1st
        // because it thought the next 2 were the same card."
        //
        // Re-arming used to depend entirely on the detected box disagreeing for
        // DISTURBED_FRAMES_TO_REARM consecutive frames. That works when the new
        // card lands askew and fails completely when it does not: a Forest
        // dropped squarely onto a stack of Forests produces an IDENTICAL box, so
        // nothing ever re-armed.
        //
        // It is also why he kept seeing "waiting for steady frame" -- the latch
        // clears only on box movement, so a card that settles cleanly leaves it
        // stuck and tapping was the only way through. Both complaints are this
        // one bug.
        //
        // Geometry cannot answer "is this a different card"; two cards in the
        // same position have the same quad. Only what is PRINTED on them
        // differs, so compare a cheap fingerprint of the artwork.
        //
        // Measured on 55 cards from his corpus: same card between consecutive
        // frames 1.3-2.4, different cards 19.9-86.6. An eight-fold gap.
        try {
          const print = artFingerprint(p.data, DW, DH, {
            x: mapped.x, y: mapped.y, w: mapped.w, h: mapped.h,
          });
          if (print) {
            if (isDifferentCard(print, capturedPrintRef.current)) {
              // A genuinely different card is present. Re-arm immediately --
              // no disturbance run needed, because the evidence is stronger
              // than box movement rather than weaker.
              stablePeriodConsumedRef.current = false;
            }
            livePrintRef.current = print;
          }
        } catch {
          // The fingerprint is an ENHANCEMENT. If it fails, behaviour falls back
          // to exactly today's box-movement rule and Zach can still tap.
        }"""

assert old_arm in s, 're-arm block not found'
s = s.replace(old_arm, new_arm, 1)

# 4. The live fingerprint ref.
s = s.replace(
    "  const capturedPrintRef = useRef(null);",
    "  const capturedPrintRef = useRef(null);\n  // Fingerprint of the CURRENT frame, promoted to capturedPrintRef on capture.\n  const livePrintRef = useRef(null);",
    1)
open(p, 'w').write(s)
print('import:', "cardChangeDetect" in s)
print('re-arm on new card:', 'isDifferentCard(print, capturedPrintRef.current)' in s)
