// Turn raw OCR text from a card's bottom-left strip into a collector number and
// set code — or into NOTHING, which is a legitimate and frequently correct
// outcome.
//
// WHY THIS FILE IS CONSERVATIVE BY DESIGN
//
// A misread number does not produce an error the user can see. It produces a
// card in the collection that Zach does not own, and that flows straight into
// availability, buylists and deck matching — the places he trusts to tell him
// what he has. There is no later reconciliation against the physical shoebox.
// So every rule here prefers returning null over returning a plausible guess.
//
// THE STRIP LOOKS LIKE THIS on a modern frame (two lines, bottom-left):
//
//     263/281 U            <- collector number / set size, rarity letter
//     C21 * EN  Mike Bierek <- set code, language, artist credit
//
// PRE-1996 CARDS CARRY NO NUMBER AT ALL. They still carry an artist credit in
// roughly the same place ("Illus. (c) Christopher Rush"), so OCR returns TEXT
// for them. Treating any text as a read is exactly how such a card would get a
// fabricated number, so the shapes below are matched narrowly and the artist
// line is not a number-bearing shape.
//
// COLLECTOR NUMBERS ARE STRINGS, NEVER INTEGERS. Scryfall stores values like
// `123a`, `star`, `A-12`, `GR1`, `1508`. parseInt would silently turn "123a"
// into 123 and match the wrong printing, so no numeric coercion happens here.

// Set codes are 3-5 alphanumerics. Matched case-insensitively, returned lower
// case to match card_cache.set_id.
const SET_CODE = /^[a-z0-9]{3,5}$/i;

// Words that appear in this strip and are NOT set codes. Without this the
// artist line's tokens and the language tag are perfectly good 3-5 char
// alphanumerics and would be handed back as a set.
const NOT_A_SET = new Set([
  'en', 'de', 'fr', 'it', 'es', 'pt', 'ja', 'ko', 'ru', 'zhs', 'zht', 'ph',
  'illus', 'illust', 'the', 'and', 'wizards', 'coast', 'inc', 'ltd', 'tm',
  'nm', 'mt', 'usa', 'all', 'right', 'rights', 'reserved', 'wotc', 'www',
]);

// Rarity letters that sit beside the number. Not part of it.
const RARITY = new Set(['c', 'u', 'r', 'm', 's', 't', 'l', 'p']);

// A collector number token. Deliberately narrow:
//   123        digits
//   0263       zero-padded (printed form)
//   123a       digits + a single letter suffix
//   A-12       letter-dash-digits (Alchemy etc.)
//   GR1        a couple of letters then digits
// It must contain at least one DIGIT. That single requirement is what keeps
// artist names and "Illus." out.
const NUMBER_TOKEN = /^(?:[A-Z]{1,3}-)?\d{1,5}[a-z]?$|^[A-Z]{1,3}\d{1,4}$/;

// THE RARITY LETTER IS PRINTED RIGHT NEXT TO THE NUMBER, and on a real photo
// the gap between them frequently does not survive OCR.
//
// OBSERVED, Zach's iPhone 16, Avatar Aang (tla #207). The review queue read:
//
//     Could not read the collector number.
//     Read: #M0207 · TAA
//
// The card prints "0207/0286 M" — the M is the RARITY (mythic), not part of
// the number. Tesseract returned it glued to the front, so the parser handed
// back number='M0207'. That is a shape NUMBER_TOKEN accepts (the `GR1` arm,
// which exists for real values like 'GR1'), so it looked like a perfectly
// confident read. No printing has collector number 'M0207', so the catalogue
// lookup returned zero rows and a CORRECTLY READ number was discarded.
//
// THIS IS OFFERED AS AN ALTERNATIVE, NEVER AS A CORRECTION, and the
// distinction is the whole safety argument.
//
// F8P-TC12 forbids silently rewriting 'M1508' into '1508', and it is right to:
// some cards really do carry a letter-prefixed collector number, so a parser
// that "fixed" them would turn a CORRECT read into a different printing of the
// same card — a silent wrong printing, the exact failure this file exists to
// prevent, and one Zach could never reconcile against the physical card.
//
// So `number` is left exactly as read. `numberAlt` carries the
// rarity-letter-stripped reading as a SECOND candidate, and the resolver may
// only use it when the number as read matched NOTHING in the catalogue and the
// alternative matches exactly one row. The catalogue, not this parser, decides
// which reading was real.
//
// The conditions are all load-bearing:
//   1. Exactly ONE leading letter. 'GR1' is untouched — 'R1' is not a
//      rarity-plus-number reading of it.
//   2. That letter must be an actual RARITY letter (c/u/r/m/s/t/l/p).
//   3. What remains must be ALL DIGITS and non-empty.
const RARITY_PREFIXED_NUMBER = /^([cumrstlp])(\d{1,5})$/i;

// Returns the alternative reading, or null when there is no plausible one.
// Leading zeros are stripped for the same reason beforeSlash does it: the card
// prints '0207' and card_cache stores '207'.
function rarityStrippedAlternative(number) {
  if (number == null) return null;
  const m = RARITY_PREFIXED_NUMBER.exec(String(number));
  if (!m) return null;
  const digits = m[2].replace(/^0+/, '') || '0';
  return digits === String(number) ? null : digits;
}

function normalise(raw) {
  return String(raw || '')
    // OCR routinely reads the bullet between set code and language as junk.
    .replace(/[•·▪|]/g, ' ')
    .replace(/[\u2018\u2019\u201c\u201d]/g, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}

// "0263/0290" -> "263"; "263/281" -> "263". The part BEFORE the slash is the
// collector number; the part after is the set size and is not wanted.
// Leading zeros are stripped because card_cache stores the unpadded form —
// but only when what remains is purely digits, so "A-12" is left alone.
function beforeSlash(token) {
  const head = token.split('/')[0];
  if (/^\d+$/.test(head)) {
    const stripped = head.replace(/^0+/, '');
    return stripped === '' ? '0' : stripped;
  }
  return head;
}

// Extract { number, set, confident } from raw OCR text.
//
// `confident` is NOT a model score — it is whether the read is structurally
// trustworthy enough to add a card without asking. Anything less routes to the
// review queue, where Zach decides. When in doubt this returns nulls.
function parseCollectorStrip(raw) {
  const lines = normalise(raw);
  if (!lines.length) return { number: null, set: null, confident: false, raw: String(raw || '') };

  let number = null;
  let set = null;
  // Every set-shaped token seen, in reading order. See the collection loop.
  const setCandidates = [];

  for (const line of lines) {
    const tokens = line.split(/[\s,]+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].replace(/[^A-Za-z0-9/\-]/g, '');
      if (!tok) continue;

      // Number first: the printed "263/281" form, or a bare token.
      if (number == null) {
        const head = beforeSlash(tok);
        // Must contain a digit and match one of the accepted shapes. The digit
        // requirement is what excludes the artist credit.
        if (/\d/.test(head) && NUMBER_TOKEN.test(head)) {
          // A lone rarity letter glued to nothing, or a 4-digit year from a
          // copyright line, are the two realistic false positives. Years are
          // rejected by requiring the token NOT to look like 19xx/20xx unless
          // the strip also showed a slash (real numbers do go above 1000, e.g.
          // sld/1508, but those are printed without a 19/20 prefix pattern
          // alongside a copyright word).
          const looksLikeYear = /^(19|20)\d{2}$/.test(head) && !tok.includes('/');
          const copyrightish = /(c|©|\(c\)|copyright|wizards|illus)/i.test(line) && looksLikeYear;
          if (!copyrightish) number = head;
        }
      }
    }
  }

  // Set code resolution is done as a second pass over the LAST lines, because
  // the set code sits on the second line and a first-pass scan would happily
  // take a 3-digit collector number as a "set code".
  for (const line of lines) {
    const tokens = line.split(/[\s,]+/).map(t => t.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean);
    for (const tok of tokens) {
      const low = tok.toLowerCase();
      if (!SET_CODE.test(tok)) continue;
      if (NOT_A_SET.has(low)) continue;
      if (RARITY.has(low) && tok.length === 1) continue;
      if (/^\d+$/.test(tok)) continue;          // all digits = a number, not a set
      if (!/[a-z]/i.test(tok)) continue;        // a set code has letters
      if (number != null && tok === number) continue;
      if (!set) set = low;
      // COLLECT EVERY PLAUSIBLE SET CODE, not just the first one.
      //
      // Zach: "You should use all information possible."
      //
      // Measured on 20 real scans, the first set-shaped token is WRONG on 5 of
      // them: 'wml' and 'turn' were lifted off the artist line, 'mma' out of
      // noise, 'msi' is 'MSH' misread and 'mshen' is 'MSH*EN' glued together.
      // Returning only the first means those five are indistinguishable from a
      // correct read — and 'mma' is a REAL set, so the OCR fallback would add a
      // genuine card that is not the one in his hand.
      //
      // The parser cannot tell which token is the set: it has no catalogue. So
      // it stops guessing and hands back everything it saw, in reading order.
      // The RESOLVER picks, because it is the layer that can ask whether
      // set+number actually resolves to a card. This is the same division of
      // labour the rest of the file already uses — parse here, validate there.
      if (!setCandidates.includes(low)) setCandidates.push(low);
    }
  }

  // Confidence: a number was found in a recognised shape. The set code is a
  // bonus that NARROWS the lookup; its absence does not by itself make the
  // read untrustworthy, because name+number is often already unique.
  //
  // ...BUT A TRUNCATED READ IS NOT CONFIDENT.
  //
  // Caught by FOCR-TC0 when the strip window was made taller: a distant Sol Ring
  // (#263) read as "26} \" and reported number=26, confident=true. The taller
  // window catches the strip on more cards, and the cost is that it sometimes
  // catches it PARTIALLY — clipping the last digit and misreading the sliced
  // glyph as punctuation.
  //
  // "26" is a real collector number, so nothing downstream can tell it is wrong,
  // and a confident wrong number is the one failure this pipeline must not
  // produce: the review queue exists for "we don't know", it cannot catch "we're
  // sure and wrong".
  //
  // THE TELL is that the digits came glued to junk. A clean read is "0288" or
  // "L 0295"; a clipped one is "26}" or "26} \". So when the token the number
  // came from carried non-alphanumeric debris directly against the digits, the
  // number is still REPORTED — it is real information and the resolver may still
  // find it useful — but it is not marked confident, so nothing adds on it
  // alone.
  const digitsGluedToJunk = number != null
    && new RegExp(`${number}[^0-9a-zA-Z\\s/]`).test(String(raw || ''));
  // ...AND A NUMBER THAT IS NOT A NUMBER IS NOT CONFIDENT EITHER.
  //
  // Measured on Zach's real scans: 'D294' and 'M0069' were both reported with
  // confident=true. Neither is a collector number — the rarity letter came back
  // glued to the digits with no space, which OCR does routinely.
  //
  // 'M0069' is recoverable: M is a real rarity (mythic), so numberAlt offers 69
  // and the resolver tries both. 'D294' is NOT: D is not a rarity at all, it is
  // a misread of the L on a Marvel land, so there is no alternative reading and
  // the literal 'D294' will never match a catalogue row.
  //
  // Rather than special-case D — the next scan will invent a different letter —
  // the rule is structural: if the token still carries a non-digit head after
  // the rarity strip has had its chance, we did not actually read a number.
  // Report it, because the raw text is still evidence, but do not let anything
  // act on it alone.
  const numberIsClean = number == null
    || /^\d+[a-z]?$/i.test(String(number))
    || rarityStrippedAlternative(number) != null;
  const confident = number != null && !digitsGluedToJunk && numberIsClean;
  // `numberAlt` is a SECOND CANDIDATE READING, not a correction (see
  // RARITY_PREFIXED_NUMBER above). `number` is always exactly what was read.
  return {
    number,
    numberAlt: rarityStrippedAlternative(number),
    set,
    // EVERY set-shaped token, for the resolver to validate against the
    // catalogue. `set` stays as the first one so existing callers are
    // unchanged; setCandidates is what lets a caller do better.
    setCandidates,
    confident,
    raw: String(raw || ''),
  };
}

module.exports = { parseCollectorStrip, beforeSlash, NUMBER_TOKEN, rarityStrippedAlternative };
