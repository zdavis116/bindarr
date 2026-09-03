// MTG decklist text <-> card list. Export supports MTG Arena, a plain list,
// and a buylist containing only ownership shortfalls.
function cardLine(card, format, bracketStyle = 'parentheses') {
  const set = String(card.set_id || card.set_code || '').replace(/^mtg-/, '').toUpperCase();
  const number = card.number || '';
  if (format === 'mtga') {
    // MTG Arena's own spec is parentheses, so the mtga format never varies.
    // Only the buylist offers a choice, because only the buylist has two
    // legitimate destinations. See BRACKET_STYLES below.
    const [open, close] = bracketStyle === 'brackets' ? ['[', ']'] : ['(', ')'];
    return `${card.quantity} ${card.name}${set ? ` ${open}${set}${close}` : ''}${number ? ` ${number}` : ''}`;
  }
  return `${card.quantity} ${card.name}`;
}

// THE TWO SHAPES OF A BUYLIST LINE, and why this is a choice rather than a bug.
//
// Zach (2026-08-19): "the set code needs to be in brackets not parenthesis" —
// he pastes the buylist into shops, and brackets ("3 Sol Ring [CMM] 410") are
// the MTG community convention that TCGplayer Mass Entry and most shop
// mass-entry boxes parse. Parentheses are what MTG Arena's format uses, and
// what the older buylist emitted.
//
// NEITHER IS "CORRECT" — each is correct for a different destination, so the
// user picks. Zach: "I think you should be able to choose brackets or
// paranthesis before copy. Maybe default to brackets."
//
// The default is BRACKETS because shopping is the common case; pasting a
// buylist back into Bindarr is the rare one.
//
// Verified 2026-08-19, not assumed: parseDeckLine below accepts BOTH forms —
// its SET_TOKEN is /[([]([A-Za-z0-9]{1,5})[)\]]/ and the name-strip is
// /\s*[([][^)\]]*[)\]]/g. So the round-trip back into Bindarr survives either
// choice, and this toggle costs no round-trip fidelity at all.
export const BRACKET_STYLES = ['brackets', 'parentheses'];
export const DEFAULT_BRACKET_STYLE = 'brackets';

export function buildDeckExport(cards, format = 'plain', options = {}) {
  if (!cards?.length) return '';
  // An unknown or absent style is the default, never a crash and never a
  // silently different output shape.
  const bracketStyle = BRACKET_STYLES.includes(options.bracketStyle)
    ? options.bracketStyle
    : DEFAULT_BRACKET_STYLE;

  if (format === 'buylist') {
    // THE SHORTFALL IS THE SERVER'S NUMBER (quantity_missing), never one
    // derived here. The server computes it against AVAILABILITY -- copies
    // another deck has already reserved are not available to this one -- so
    // recomputing it from a raw owned count would tell the user he needs fewer
    // cards than he actually does. `owned_qty` is the older shape and is used
    // only when the server did not send a shortfall.
    //
    // THE LINE NAMES THE EXACT PRINTING AND FINISH. This is the opposite of
    // the text-IMPORT rule, and both are right because they answer different
    // questions: import asks "which of my physical cards fills this slot" (any
    // owned printing will do), while a buylist asks "which card am I BUYING",
    // where the printing IS the decision because it is a PRICE decision. Zach
    // (2026-08-19): "for buylist exact printing matters because I may chose a
    // cheaper printing." A bare "3 Sol Ring" pasted into a shop's mass entry
    // would let it pick any printing it liked and silently spend his money on
    // an object he did not choose. So the set code, collector number and any
    // non-nonfoil finish all travel with the line.
    //
    // The form is the one the user chose above; BOTH forms round-trip through
    // the import parser (verified, see BRACKET_STYLES), so a buylist pasted
    // back into Bindarr reproduces the exact requirements it came from either
    // way. The set code, collector number and finish travel on the line in
    // both, because that is what makes the line an instruction.
    return cards
      .map(card => ({
        card,
        need: card.quantity_missing !== undefined
          ? card.quantity_missing
          : Math.max(0, (card.quantity || 0) - (card.owned_qty || 0)),
      }))
      .filter(entry => entry.need > 0)
      .map(({ card, need }) => {
        const finish = card.finish || card.desired_finish || 'nonfoil';
        const marker = finish === 'foil' ? ' *F*' : (finish === 'etched' ? ' *E*' : '');
        return `${cardLine({ ...card, quantity: need }, 'mtga', bracketStyle)}${marker}`;
      })
      .join('\n');
  }

  if (format === 'mtga') {
    // Parentheses, always: this is MTG Arena's documented spec, not a
    // preference. The buylist's choice must never leak into it.
    return `Deck\n${cards.map(card => cardLine(card, 'mtga', 'parentheses')).join('\n')}`;
  }

  return cards.map(card => cardLine(card, 'plain')).join('\n');
}

// Extract quantity, card name, and any EXPLICIT printing the line states.
//
// The three cases the whole import feature turns on are decided here, at the
// text layer, because they are a property of what the line SAYS:
//
//   A. The line names a printing -- "1 Sol Ring (C21) 263", "1 Sol Ring [C21]",
//      "1 Sol Ring (c21) 263 *F*". The user has already answered "which physical
//      card"; nothing is left to ask, and nothing may be guessed at either.
//   B/C. The line is bare -- "4 Lightning Bolt". It names a card, not a card
//      object. The server then allocates from what is owned, and anything it
//      cannot cover goes to the user to pick.
//
// So `set` / `number` / `finish` are returned when and only when the line
// actually contained them, and are left undefined otherwise. An undefined here
// means "the line did not say", NOT "use the default" -- the difference is
// exactly the difference between honouring the user and inventing a printing.
//
// Set codes are 1-5 alphanumerics in parentheses or brackets (Scryfall's range,
// e.g. 'C21', 'MH2', 'PLST'). Collector numbers may carry a letter suffix
// ('263', '12a'). Foil is the widely used '*F*' / '*E*' marker.
//
// The bare words 'foil' / 'etched' are ONLY honoured as a trailing token on a
// line that also named a set, and never on their own. 'Foil' is a real Magic
// card (Prophecy, 2000), so treating the bare word as a finish marker would
// make "1 Foil" silently request a foil something -- inventing a finish out of
// a card name is precisely the failure mode this feature is built to avoid.
const SET_TOKEN = /[([]([A-Za-z0-9]{1,5})[)\]]/;
const FOIL_MARKER = /\*F\*|\*foil\*/i;
const ETCHED_MARKER = /\*E\*|\*etched\*/i;
const TRAILING_FINISH_WORD = /\s+(foil|etched)$/i;

export function parseDeckLine(line) {
  const raw = String(line).trim();
  const match = raw.match(/^(\d+)x?\s+(.+)$/i);
  if (!match) return null;

  const qty = Number.parseInt(match[1], 10);
  const rest = match[2];

  const setMatch = rest.match(SET_TOKEN);
  const set = setMatch ? setMatch[1].toUpperCase() : undefined;

  // The collector number is only read when a set code was found. A bare
  // "2 Counterspell 267" is far more likely to be a name we should not mangle
  // than a printing reference, and guessing wrong here would pin the user to a
  // printing their line never mentioned.
  let number;
  if (setMatch) {
    const after = rest.slice(setMatch.index + setMatch[0].length);
    // Collector numbers are not always plain digits. The List uses CON-31,
    // promos use 12s, prerelease printings use 001p. Accept a leading digit OR
    // a set-prefixed form, but still require the token to contain a digit --
    // otherwise a word following the set code is mistaken for a number.
    const numberMatch = after.match(/^\s*#?\s*([A-Za-z]*-?\d+[a-zA-Z]?)\b/);
    if (numberMatch) number = numberMatch[1];
  }

  // Etched is checked before foil: an etched card is not a foil one, and
  // pulling the wrong one out of the binder is the failure this app exists to
  // prevent.
  const trailingWord = setMatch ? rest.match(TRAILING_FINISH_WORD) : null;
  let finish;
  if (ETCHED_MARKER.test(rest) || trailingWord?.[1].toLowerCase() === 'etched') finish = 'etched';
  else if (FOIL_MARKER.test(rest) || trailingWord?.[1].toLowerCase() === 'foil') finish = 'foil';

  // Each strip is followed by a trim so the next pattern, which is anchored to
  // end-of-string, still sees the end of the string. Without it, removing a
  // trailing '*F*' leaves a space behind and the collector-number strip after
  // it silently stops matching.
  const name = rest
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/\*[A-Za-z]*\*/g, ' ')
    .trim()
    .replace(TRAILING_FINISH_WORD, '')
    .trim()
    .replace(/\s*#[A-Za-z]*-?\d+[a-zA-Z]?$/, '')
    .trim()
    .replace(/\s+[A-Za-z]*-?\d+[a-zA-Z]?$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    // DOUBLE-FACED CARDS -> the FRONT FACE only.
    //
    // "Tony Stark / The Invincible Iron Man" and Scryfall's own
    // "Tony Stark // The Invincible Iron Man" both become "Tony Stark", which
    // is what card_cache stores for a modal DFC. Moxfield exports one slash,
    // Scryfall writes two, and neither matched -- so a pasted commander line
    // resolved to nothing at all.
    //
    // The FRONT face is the identity: it is unique, and it does not depend on
    // the exporter spelling the back face the same way we do.
    .split(/\s*\/\/?\s*/)[0]
    .trim();

  if (!name) return null;

  const parsed = { qty, name };
  if (set) parsed.set = set;
  if (number) parsed.number = number;
  if (finish) parsed.finish = finish;
  return parsed;
}
