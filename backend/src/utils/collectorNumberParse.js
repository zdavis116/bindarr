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

// LANGUAGE CODES THAT GLUE THEMSELVES TO THE SET CODE.
//
// The set line reads "<SET> <sep> <LANG> <sep> <ARTIST>", where the separator
// is a tiny glyph OCR renders as *, A, «, ®, or drops entirely. When it drops,
// the set and language fuse: 'MSH*EN' becomes 'mshen', which matches no set.
//
// Only two-letter codes, and only as a SUFFIX. A stem is offered as an extra
// candidate alongside the glued token, never as a replacement, so the
// catalogue still decides which is real.
const LANG_SUFFIXES = ['en', 'de', 'fr', 'it', 'es', 'pt', 'ja', 'ko', 'ru', 'zh'];

// HOW TO RECOGNISE THE SET LINE.
//
// The line carrying the set code has a distinctive shape: a 3-5 character code
// followed by a two-letter language code, separated by a glyph OCR mangles
// ('MSH*EN', 'MSH « EN', 'MSHAEN').
//
// THE SEPARATOR IS REQUIRED, and that requirement is load-bearing. A permissive
// version matched the ARTIST line 'Nemes 5 BE' -- because 'Nemes' is itself
// <3-5 chars><language code 'es'> with nothing between them. That made the
// artist line look like the set line, which is exactly the confusion this
// pattern exists to prevent.
//
// So: either an explicit separator character between the code and the language,
// or whitespace. Two letters merely ending a word do not qualify.
const SET_LINE_HINT = new RegExp(
  `\\b[a-z0-9]{3,5}\\s*[^a-z0-9\\s]\\s*(${LANG_SUFFIXES.join('|')})\\b`
  + `|\\b[a-z0-9]{3,5}\\s+(${LANG_SUFFIXES.join('|')})\\b`, 'i');

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
  // The subset of those found ON THE SET LINE itself. The set code is printed
  // there; an artist name is not. Lets the resolver prefer real set codes over
  // stems accidentally derived from surrounding words -- see the Evil's Thrall
  // case, where the artist 'Nemes' produced 'nem', a real set whose #128 is a
  // real card, manufacturing ambiguity for a card already identified.
  const setLineCandidates = [];
  // Every number-shaped token seen, with the line it came from. See the
  // selection below: the FIRST one is not necessarily the card's own.
  const numberTokens = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const tokens = line.split(/[\s,]+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].replace(/[^A-Za-z0-9/\-]/g, '');
      if (!tok) continue;

      // Number first: the printed "263/281" form, or a bare token.
      {
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
          if (!copyrightish) numberTokens.push({ head, line, li });
        }
      }
    }
  }

  // CHOOSE THE CARD'S OWN NUMBER, NOT THE FIRST DIGITS ON THE STRIP.
  //
  // Zach: "one scan was bad marked super solider serum as kid Loki". THE WORST
  // FAILURE THIS APP HAS -- a confident wrong card in his collection, which he
  // cannot reconcile against the physical stack without recounting it.
  //
  // The capture is unambiguous: 'R 0038 / MSH*EN / Rafater'. OCR read it fine:
  //
  //     "| iil 63\nrR 0038\nMSH *EN be RAFAT\nNET Ue SRT\nEr\n"
  //          ^^                ^^^^
  //       bleed-through      the real number
  //
  // The first line is blurred text from the card BEHIND/ABOVE this one in the
  // stack, caught because the OCR strip window was made taller to stop missing
  // the number. Taking the first number-shaped token in reading order took the
  // noise, and 63 is a real Marvel card (Kid Loki) -- so it resolved cleanly to
  // the wrong card. Nothing about the result looked wrong.
  //
  // THE STRUCTURAL FIX: prefer the number printed IMMEDIATELY ABOVE the set
  // line. Real cards print
  //
  //     <RARITY> <NUMBER>
  //     <SET>*<LANG> <ARTIST>
  //
  // so the card's own number sits directly above its set line. Bleed-through
  // from another card does not. This uses the strip's own layout rather than
  // hoping the noise sorts itself out.
  //
  // ONLY THE LINE ABOVE, NEVER THE SET LINE ITSELF. Set codes may contain
  // digits -- 'C21' is a real set (Commander 2021) and matches the number
  // shape. Accepting a token from the set line would read the SET as the
  // NUMBER, which F8P-TC1/TC14/TC18 caught immediately.
  //
  // Falls back to the first token when no set line is found, which is exactly
  // the previous behaviour -- so a strip with no legible set code is no worse
  // off than before.
  if (numberTokens.length) {
    const setLine = lines.findIndex(l => SET_LINE_HINT.test(l));
    if (setLine >= 0) {
      // WHEN A SET LINE EXISTS, THE NUMBER IS THE ONE ABOVE IT -- OR NOTHING.
      //
      // Zach: "one had the wrong set number turtle duck". The strip read:
      //
      //     line 0  'Ww WE V WV'            noise
      //     line 1  'TLA * EN % SYLVAIN'    the real set line
      //     line 2  '"MSH XEN 8 RAFATE'     a SECOND set line, bleeding
      //                                     through from the card below
      //
      // The Turtle-Duck's own number was not legible at all. The old code found
      // nothing above the set line and fell back to "the first number-shaped
      // token anywhere" -- which was the '8' sitting in the NEIGHBOURING card's
      // set line. tla #8 is a real card, so it resolved confidently to the
      // wrong printing.
      //
      // That fallback made sense before the strip window was widened; now the
      // window routinely contains a second card's text, so "anywhere on the
      // strip" is no longer a safe place to look.
      //
      // If the number above the set line is not readable, we did not read this
      // card's number. Report nothing and let it queue. A queue entry costs a
      // tap; a confidently wrong printing costs a recount against physical
      // cardboard.
      // SOME PRINTINGS PUT THE NUMBER AND SET ON ONE LINE.
      //
      // '1508 SLD * EN ANDREA RADECK' is a real strip (Secret Lair). So the
      // card's own number is the one ABOVE the set line, or one ON it -- but
      // ONLY a token that appears BEFORE the set code, which is how the layout
      // reads. The '8' in the Turtle-Duck's neighbouring line came AFTER its
      // set code ('MSH XEN 8 RAFATE'), so this stays excluded.
      const above = numberTokens.find(t => t.li === setLine - 1);
      let onLine = null;
      if (!above) {
        const m = SET_LINE_HINT.exec(lines[setLine]);
        const setAt = m ? m.index : -1;
        onLine = numberTokens.find(t => t.li === setLine
          && setAt > 0
          && lines[setLine].indexOf(t.head) >= 0
          && lines[setLine].indexOf(t.head) < setAt);
      }
      number = (above || onLine) ? (above || onLine).head : null;
    } else {
      // NO SET LINE AT ALL: keep the original behaviour exactly. A strip with
      // no legible set code is no worse off than before this rule existed.
      number = numberTokens[0].head;
    }
  }

  // Set code resolution is done as a second pass over the LAST lines, because
  // the set code sits on the second line and a first-pass scan would happily
  // take a 3-digit collector number as a "set code".
  for (const line of lines) {
    const tokens = line.split(/[\s,]+/).map(t => t.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean);
    for (const tok of tokens) {
      const low = tok.toLowerCase();
      // ACCEPT UP TO 7 CHARACTERS HERE, NOT 5.
      //
      // SET_CODE is 3-5 because that is what a real set code is. But a GLUED
      // token is set + separator + language: 'MSHAEN' is six characters and was
      // being discarded before the stem logic below could ever see it -- which
      // is why Zach's fourth queue had no 'msh' candidate at all.
      //
      // This does not loosen what counts as a set: only STEMS derived below are
      // added as candidates, and a 6-7 character token that yields no stem
      // still contributes nothing. The catalogue remains the judge.
      const isGluedCandidate = /^[a-z0-9]{6,7}$/i.test(tok)
        && LANG_SUFFIXES.some(l => low.endsWith(l));
      if (!SET_CODE.test(tok) && !isGluedCandidate) continue;
      if (NOT_A_SET.has(low)) continue;
      if (RARITY.has(low) && tok.length === 1) continue;
      if (/^\d+$/.test(tok)) continue;          // all digits = a number, not a set
      if (!/[a-z]/i.test(tok)) continue;        // a set code has letters
      if (number != null && tok === number) continue;
      if (!set) set = low;
      // SPLIT THE LANGUAGE SUFFIX OFF A GLUED TOKEN.
      //
      // Zach: "I count queues as failures... I would expect maybe 1 not 4."
      // All four queues in that session read the NUMBER correctly and then
      // failed on the set:
      //
      //   'MSH*EN % RYTIS SA'  -> ['mshen', 'rytis']   the separator vanished
      //   'MSHAEN ¥% DAVID'    -> ['david']            '*' read as 'A'
      //
      // The set line is "<SET> <separator> <LANG> <sep> <ARTIST>", and the
      // separator is a tiny glyph OCR reads as *, A, «, ®, or nothing at all.
      // When it vanishes the set and the language fuse into one token, and
      // 'mshen' matches no set in the catalogue.
      //
      // So a token ending in a known language code also contributes its stem.
      // This ADDS candidates, never replaces them: 'mshen' still gets tried in
      // case some set really is called that, and the catalogue remains the
      // judge of which candidate is real. A stem that matches nothing simply
      // loses, exactly like any other wrong candidate.
      const stems = [low];
      for (const lang of LANG_SUFFIXES) {
        if (low.length > lang.length + 1 && low.endsWith(lang)) {
          stems.push(low.slice(0, -lang.length));
          // THE SEPARATOR MAY HAVE BEEN READ AS A LETTER, NOT DROPPED.
          //
          // 'MSH*EN' came back as 'MSHAEN': the '*' was recognised as an 'A',
          // so stripping 'en' leaves 'msha' rather than 'msh'. One more
          // character has to come off, but ONLY when what remains is still a
          // plausible 3-4 character set code -- otherwise this would start
          // inventing stems from ordinary words.
          const stem = low.slice(0, -lang.length);
          if (stem.length >= 4) stems.push(stem.slice(0, -1));
        }
      }
      const onSetLine = SET_LINE_HINT.test(line);
      for (const st of stems) {
        if (!setCandidates.includes(st)) setCandidates.push(st);
        if (onSetLine && !setLineCandidates.includes(st)) setLineCandidates.push(st);
      }
      continue;
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
  //
  // A SPURIOUS DIGIT INSIDE THE ZERO PADDING IS ALSO A CANDIDATE READING.
  //
  // Zach's queue: 'L 02906' where the card is #296. Collector numbers print
  // zero-padded to four digits ('0296'), and OCR inserted a fifth. Five digits
  // is not a real collector number -- the largest sets are in the hundreds --
  // so a 5-digit token starting with 0 is almost certainly a 4-digit one with
  // an extra character.
  //
  // Offered as an ALTERNATIVE, never a rewrite: the catalogue decides. If both
  // readings resolve to real printings that is genuine ambiguity and the
  // resolver queues it, exactly as it does for the rarity-letter case.
  const paddedAlt = (() => {
    const s = String(number || '');
    // The parser normalises away the leading zero, so '02906' arrives as
    // '2906'. Match on the RAW text to confirm the zero-padded shape, then
    // drop the surplus digit from the normalised value.
    if (!/^\d{4}$/.test(s)) return null;
    if (!new RegExp(`0${s}(?![0-9])`).test(String(raw || ''))) return null;
    return String(Number(s.slice(0, 2) + s.slice(3)));
  })();
  return {
    number,
    numberAlt: rarityStrippedAlternative(number) || paddedAlt,
    set,
    // EVERY set-shaped token, for the resolver to validate against the
    // catalogue. `set` stays as the first one so existing callers are
    // unchanged; setCandidates is what lets a caller do better.
    setCandidates,
    setLineCandidates,
    confident,
    raw: String(raw || ''),
  };
}

module.exports = { parseCollectorStrip, beforeSlash, NUMBER_TOKEN, rarityStrippedAlternative };
