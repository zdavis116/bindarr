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
      warnings.push({
        code: 'COMMANDER_TOO_MANY',
        message: `This Commander deck has ${commanderCount} commanders; at most two (partners) are allowed.`
      });
    }
  }

  return warnings;
}

module.exports = { isBasicEnergyOrLand, buildDeckWarnings };
