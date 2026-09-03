// Deck construction rules.
//
// The important change in PR 6C is a change of KIND, not of content: these
// rules used to BLOCK a save, and now they WARN.
//
// Why. The old `validateDeckAddition` refused to add a card the user did not
// own. That makes the deck builder useless for the thing people actually use a
// deck builder for -- planning a deck you have not finished buying. It also put
// two unrelated concerns behind one gate: "is this a legal Magic deck" (a rules
// question, answerable while you shop) and "can I physically assemble this
// right now" (an inventory question, only relevant at checkout). Checkout still
// enforces the inventory question hard; everything before it advises.
//
// Legality warnings are advisory in a second sense too: Commander validation
// here is intentionally shallow (PR 8 owns the real thing).
const db = require('../db');
// NOTE: this module no longer imports commanderRules. It used to, to produce
// the COMMANDER_PAIR_ILLEGAL *warning*; pairing is now a REFUSAL enforced at
// the write choke point (commanderRules.checkCommanderZone), so the coupling
// is gone. deckRules is once again purely advisory, which is the invariant
// worth protecting: nothing in this file may ever block a save.

function parseSubtypes(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) { try { return JSON.parse(raw); } catch { return []; } }
  return [];
}

// Basic lands are exempt from the "max 4 copies" rule.
function isBasicEnergyOrLand(card) {
  if (!card) return false;
  const subs = parseSubtypes(card.subtypes);
  const basicTypes = ['Basic', 'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];
  return (subs.includes('Land') || card.supertype === 'Land')
    && basicTypes.some(t => subs.includes(t) || card.name === t);
}

function client(database) {
  return database || db;
}

// Build the advisory warning list for a deck.
//
// `entries` are the availability-annotated requirements from
// deckIdentity.availabilityForDeck, so this function never re-derives ownership
// -- there is exactly one definition of "owned" in the codebase and it lives in
// deckIdentity.js.
//
// Every warning carries a machine-readable `code` alongside its human message.
// The message is a display string and will be reworded and translated; anything
// that branches on warning type must branch on the code.
// colour_identity is a JSON string in the cache and an array once parsed,
// depending on the caller. Never throws: a parse failure here would take out
// the entire deck response, not just one warning.
function safeColours(entry) {
  const raw = entry && entry.color_identity;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function buildDeckWarnings(database, deck, entries) {
  const warnings = [];

  for (const entry of entries) {
    // Ownership shortfall. Reported for reserving requirements only: a
    // considering entry is a shopping note, not a gap in the deck.
    if (entry.reserves && entry.quantity_missing > 0) {
      const label = `${entry.name} (${entry.set_name} #${entry.number}, ${entry.desired_finish})`;
      warnings.push({
        code: 'MISSING_COPIES',
        deck_card_id: entry.id,
        message: entry.quantity_owned === 0
          ? `You do not own ${label}. Missing ${entry.quantity_missing} of ${entry.quantity_required}.`
          : `You own ${entry.quantity_owned} of ${label}, but ${entry.quantity_allocated_elsewhere} `
            + `${entry.quantity_allocated_elsewhere === 1 ? 'is' : 'are'} reserved by another deck. `
            + `Missing ${entry.quantity_missing}.`
      });
    }
  }

  // Copy limit, counted across PRINTINGS of the same card name.
  //
  // Magic's four-copy rule is about the card NAME, so four different printings
  // of Lightning Bolt is still four Lightning Bolts. Grouping by name rather
  // than by oracle_id or desired_card_id is what makes that come out right.
  const byName = new Map();
  for (const entry of entries) {
    // The considering board is explicitly a maybeboard and does not count
    // toward deck legality.
    if (entry.board === 'considering') continue;
    const key = entry.name;
    byName.set(key, (byName.get(key) || 0) + entry.quantity);
  }
  for (const [name, total] of byName) {
    if (total <= 4) continue;
    const sample = entries.find(e => e.name === name);
    const card = await client(database).get(
      `SELECT name, supertype, subtypes FROM card_cache WHERE id = ?`,
      [sample.desired_card_id]
    );
    if (isBasicEnergyOrLand(card)) continue;
    warnings.push({
      code: 'COPY_LIMIT',
      message: `${name}: ${total} copies across all printings exceeds the 4-copy limit.`
    });
  }

  // Commander sanity, warning-only per requirement 5 and plan Task D3.
  if (deck && /commander|edh/i.test(deck.format || '')) {
    const commanders = entries.filter(e => e.board === 'commander');
    const commanderCount = commanders.reduce((sum, e) => sum + e.quantity, 0);
    if (commanderCount === 0) {
      warnings.push({ code: 'COMMANDER_MISSING', message: 'This Commander deck has no commander assigned.' });
    } else if (commanderCount > 2) {
      // A BACKSTOP, no longer the enforcement. As of the command-zone fix, a
      // zone of three or more is REFUSED by commanderRules.checkCommanderZone
      // after every mutation that can change the zone -- add, delete, swap,
      // create -- so no route can produce this state any more.
      //
      // It stays as a warning because data that predates the rule (or a
      // restored backup) can still hold such a zone, and a deck that is already
      // wrong must SAY so rather than look fine. It describes a state the app
      // will not create; it does not permit one.
      warnings.push({
        code: 'COMMANDER_TOO_MANY',
        message: `This Commander deck has ${commanderCount} commanders; at most two (partners) are allowed.`
      });
    }
    // COLOUR IDENTITY (Zach, 2026-08-31). Adding an off-colour card used to be
    // REFUSED with a 409. He asked for that to stop -- "in case there is a bug
    // or rule change it doesn't break deck building" -- so the write now
    // succeeds and this reports it instead.
    //
    // Removing the refusal without adding this would let the card in silently,
    // leaving a deck that is illegal and says nothing. That is worse than
    // either the old behaviour or the new one.
    if (commanderCount > 0) {
      const identity = new Set();
      for (const c of commanders) {
        for (const colour of safeColours(c)) identity.add(colour);
      }

      const offending = entries.filter(e =>
        e.board !== 'commander'
        && e.board !== 'considering'
        && safeColours(e).some(colour => !identity.has(colour)));

      if (offending.length > 0) {
        // ONE warning naming the cards, not one per card. A deck with a
        // mis-set commander can put ninety cards out of identity, and ninety
        // warnings read as noise -- which is exactly what makes the real ones
        // easy to miss.
        const names = offending.map(e => e.name);
        const shown = names.slice(0, 6).join(', ');
        const rest = names.length > 6 ? ` and ${names.length - 6} more` : '';
        warnings.push({
          code: 'OFF_COLOUR',
          level: 'error',
          message: `${names.length} ${names.length === 1 ? 'card is' : 'cards are'} outside your `
            + `commander's colours: ${shown}${rest}.`
        });
      }
    }

    // COMMANDER LEGALITY (Zach, 2026-08-31). Being a legal commander is a
    // property of the card -- "Legendary Creature", or text that says it can
    // be one. This used to be refused at write time with an override; it is
    // now reported here, so a deck whose commander is not actually a legal
    // commander says so instead of looking fine.
    for (const c of commanders) {
      const line = String(c.type_line || '');
      const isLegendaryCreature = /Legendary/i.test(line) && /Creature/i.test(line);
      const saysCanBeCommander = /can be your commander/i.test(String(c.oracle_text || ''));
      const isBackground = /Background/i.test(line);

      // Only claim this when the app actually HAS the card's type line. An
      // empty line means the app has not read the card, and "I do not know"
      // must not be reported as "this is wrong" -- that is the same mistake as
      // treating a Scryfall outage as a legality ruling.
      if (!line) continue;

      if (!isLegendaryCreature && !saysCanBeCommander && !isBackground) {
        warnings.push({
          code: 'COMMANDER_ILLEGAL',
          level: 'error',
          message: `${c.name} is not a legal commander: it is not a legendary creature `
            + `and does not say it can be your commander.`
        });
      }
    }

    // PARTNER PAIRING. Two commanders are legal together only if the cards
    // allow it -- Partner, Partner With, Friends Forever, Doctor's companion,
    // or a Background. Reported rather than refused, same reasoning.
    if (commanders.length === 2) {
      const pairingText = commanders
        .map(c => `${c.oracle_text || ''} ${c.type_line || ''}`)
        .join(' ');
      const allowsPair = /partner|friends forever|doctor's companion|choose a background|background/i
        .test(pairingText);
      const haveText = commanders.every(c => c.type_line || c.oracle_text);

      if (haveText && !allowsPair) {
        warnings.push({
          code: 'COMMANDER_PAIRING',
          level: 'error',
          message: `${commanders[0].name} and ${commanders[1].name} cannot be commanders `
            + `together: neither has Partner, Friends Forever, or a Background.`
        });
      }
    }

    // PAIRING LEGALITY IS NO LONGER A WARNING (Zach, 2026-08-18).
    //
    // It is REFUSED at the point a commander is written, by
    // commanderRules.checkCommanderZone, and the refusal is overridable with
    // a recorded reason. It deliberately does NOT appear here.
    //
    // Why it must not also warn: an illegal pair can now only exist in a deck
    // because the user EXPLICITLY overrode the refusal and said why. Warning
    // about it afterwards would nag them about a decision the app already
    // asked them to justify and then accepted -- and a warning nobody can act
    // on is noise that trains the user to ignore the warning list.
    //
    // The boundary this preserves: deck CONTENTS legality (missing copies,
    // colour identity among the 99, deck size) stays warning-only, because
    // the user fixes those by continuing to work. The command zone is not
    // that -- it is a foundation that can never become legal -- so it refuses.
  }

  // DECK SIZE. Counted from the entries that are actually IN the deck --
  // reserving requirements plus the command zone. A 'considering' entry is a
  // shopping note and must not push a legal deck over its limit.
  //
  // The commander counts toward the 100: that is how Commander works, and a
  // count that excluded it would tell him 100 while he holds 101 cards.
  if (deck && deck.target_size) {
    const inDeck = entries.reduce((sum, entry) => {
      if (entry.board === 'considering') return sum;
      return sum + (entry.quantity_required || entry.quantity || 0);
    }, 0);

    if (inDeck > deck.target_size) {
      warnings.push({
        code: 'DECK_OVER_SIZE',
        message: `This deck holds ${inDeck} cards but its limit is `
          + `${deck.target_size}. Remove ${inDeck - deck.target_size} `
          + `${inDeck - deck.target_size === 1 ? 'card' : 'cards'} before playing it.`,
      });
    }
  }

  return warnings;
}

module.exports = { isBasicEnergyOrLand, buildDeckWarnings };
