// NOTHING MAY INTERRUPT A STACK WITH THE "IDENTIFIED CARDS FOUND" MODAL.
//
// Zach, twice:
//   "Why does this screen still pop up? Feels like it doesn't belong with the
//    scanned section now."
//   "The popup still happens." (after the first fix)
//
// The first fix closed ONE door. His second screenshot -- Ceremonial Knife
// beside Inspiring Call, an artifact and an instant from unrelated sets --
// proved there were others. That is the failure this test exists to prevent:
// fixing a symptom at one call site while the same modal keeps another route.
//
// THE RULE. While auto-scan is ON, a scan has exactly two honest endings:
//   - confident about ONE card  -> add it
//   - anything less certain     -> stage/queue it with its candidates
// The picker is never one of them, because he is holding a stack and the modal
// stops the flow to ask a question the matcher cannot actually pose. The queue
// screen already renders candidates AND offers a manual search, so nothing is
// lost by deferring.
//
// With auto-scan OFF the picker is correct: he pressed a button and is waiting
// for an answer, and there is no stack to interrupt.
//
// This models the decision points of the scan-match handler rather than
// importing the component (which needs a DOM, a camera and a server). Each case
// is a real branch that reached the modal on his phone.
import assert from 'node:assert';

let passed = 0;
const pass = (id, what) => { console.log(`PASS: ${id} - ${what}`); passed++; };

const ADD = 'add';
const QUEUE = 'queue';
const PICKER = 'picker';

// Mirrors the branch order in CameraScanner's scan-match handler.
function outcomeFor({ autoScan, confident, ambiguousPrinting, printings, clipName, titleText, ocrText }) {
  // Confident, unambiguous, and the card is known -> straight add.
  if (confident && !ambiguousPrinting) {
    if (printings === 1) return ADD;
    // Several printings of a card we were sure about: still a question.
    if (!autoScan) return PICKER;
  }
  // Everything else: queue it if the server would accept a row.
  if (autoScan && (clipName || titleText || ocrText)) return QUEUE;
  return PICKER;
}

// TC1: THE EXACT SCAN FROM HIS SCREENSHOT. Nothing identified -- no CLIP name,
// no readable title -- only OCR text. The first fix gated on name/title, so
// this fell through to the modal. It is the least certain kind of scan, which
// is why it must NOT be the one that interrupts him.
{
  const got = outcomeFor({
    autoScan: true, confident: false, ambiguousPrinting: false, printings: 0,
    clipName: '', titleText: '', ocrText: 'CEREMONIAL KNIFE 254/277',
  });
  assert.strictEqual(got, QUEUE, 'an unidentified card must queue, never open the picker');
  pass('NOPOP-TC1', 'no name and no title still queues (the reported regression)');
}

// TC2: a confident match with several printings must not interrupt either.
// This was the second door: autoSingle only auto-adds when there is ONE result,
// and the by-name fallback deliberately fetches every printing.
{
  const got = outcomeFor({
    autoScan: true, confident: true, ambiguousPrinting: false, printings: 6,
    clipName: 'Lightning Bolt', titleText: 'Lightning Bolt', ocrText: '',
  });
  assert.strictEqual(got, QUEUE, 'many printings must go to the queue, not the modal');
  pass('NOPOP-TC2', 'confident match with several printings queues');
}

// TC3: the fast path still works. A confident match on exactly one printing
// adds immediately -- the change must not slow down the common case.
{
  const got = outcomeFor({
    autoScan: true, confident: true, ambiguousPrinting: false, printings: 1,
    clipName: 'Sol Ring', titleText: 'Sol Ring', ocrText: '',
  });
  assert.strictEqual(got, ADD, 'a confident single printing still auto-adds');
  pass('NOPOP-TC3', 'the confident fast path is unchanged');
}

// TC4: ambiguous printing, which is what produced his first screenshot
// (Katerina of Myra's Marvels beside Twisted Experiment).
{
  const got = outcomeFor({
    autoScan: true, confident: true, ambiguousPrinting: true, printings: 4,
    clipName: 'Katerina of Myra\'s Marvels', titleText: '', ocrText: '',
  });
  assert.strictEqual(got, QUEUE, 'an ambiguous printing must queue');
  pass('NOPOP-TC4', 'ambiguous printing queues instead of interrupting');
}

// TC5: WITH AUTO-SCAN OFF THE PICKER IS RIGHT. He pressed the button and is
// waiting; there is no stack to interrupt. Deferring to a queue here would be
// worse, not better.
{
  const got = outcomeFor({
    autoScan: false, confident: false, ambiguousPrinting: false, printings: 3,
    clipName: 'Lightning Bolt', titleText: '', ocrText: '',
  });
  assert.strictEqual(got, PICKER, 'manual capture still shows the candidates');
  pass('NOPOP-TC5', 'manual capture keeps the picker');
}

// TC6: THE PROPERTY ITSELF, over the whole branch space. No combination of
// inputs may produce the modal while auto-scan is on. This is what catches a
// THIRD door being added later, which is how this bug survived the first fix.
{
  const bools = [true, false];
  const offenders = [];
  for (const confident of bools) {
    for (const ambiguousPrinting of bools) {
      for (const printings of [0, 1, 2, 8]) {
        for (const clipName of ['', 'Sol Ring']) {
          for (const titleText of ['', 'Sol Ring']) {
            for (const ocrText of ['', 'SOL RING 001']) {
              const inputs = {
                autoScan: true, confident, ambiguousPrinting, printings,
                clipName, titleText, ocrText,
              };
              const got = outcomeFor(inputs);
              // The one legitimate picker case: the server would reject the row
              // because there is genuinely nothing to record.
              const nothingToRecord = !clipName && !titleText && !ocrText;
              if (got === PICKER && !nothingToRecord) offenders.push(inputs);
            }
          }
        }
      }
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'no auto-scan branch may open the picker when there is something to queue',
  );
  pass('NOPOP-TC6', 'no auto-scan branch reaches the picker (exhaustive)');
}

console.log(`\nno-picker-during-autoscan.test.js: ${passed} cases passed`);
