// Pure presentation logic for the deck card list.
//
// Split out of DeckBuilder.jsx for two reasons. First, it can be tested without
// a DOM, so the rules that decide what the user sees are checked directly.
// Second, and more important: these functions READ server-computed quantities
// and choose a label. They never derive ownership, reservation or missing
// counts. Those are the server's answers (backend/src/utils/deckIdentity.js),
// and a second implementation here would let the screen and the database
// disagree about whether the user has to buy a card -- with the screen winning,
// because that is what the user acts on.

// Moxfield-style card type sections, in the order they are displayed.
//
// The order is not alphabetical and not arbitrary: it is roughly the order a
// player thinks about a list, with the commander first because it defines the
// deck, and lands last because they are the part you tune once everything else
// is settled.
export const TYPE_SECTIONS = [
  'Creatures',
  'Sorcery',
  'Instant',
  'Enchantment',
  'Artifact',
  'Planeswalker',
  'Lands'
];

// Map a Scryfall type_line to one of the sections above.
//
// The type_line is the cached Scryfall string, e.g.
// "Legendary Creature — Human Wizard" or "Artifact Creature — Golem". It is the
// right source because it is what Scryfall itself considers authoritative, and
// it is already cached on every deck entry, so sectioning needs no extra fetch.
//
// Order of checks is load-bearing. A card can hold several types at once, and
// the first match wins, so the list below is a PRIORITY, not a set:
//
//   - Land is checked first. "Artifact Land" and "Creature Land" both belong in
//     Lands; a player looking for their mana base expects every land there and
//     nowhere else.
//   - Creature next. "Artifact Creature" is a creature you cast and attack
//     with; filing it under Artifact hides it from the creature count that
//     matters for curve and board presence.
//
// Anything unrecognised falls into 'Other' rather than being dropped. A card
// that vanishes from the list because its type was unexpected is far worse than
// one in a catch-all section: the user would count 99 cards and be unable to
// find the hundredth.
export function sectionForTypeLine(typeLine) {
  const line = String(typeLine || '');
  if (!line) return 'Other';
  // Split off the subtype half; "Enchantment — Aura" must not match on a
  // subtype that happens to share a supertype's name.
  const main = line.split(/[—-]/)[0];
  if (/\bLand\b/i.test(main)) return 'Lands';
  if (/\bCreature\b/i.test(main)) return 'Creatures';
  if (/\bPlaneswalker\b/i.test(main)) return 'Planeswalker';
  if (/\bInstant\b/i.test(main)) return 'Instant';
  if (/\bSorcery\b/i.test(main)) return 'Sorcery';
  if (/\bEnchantment\b/i.test(main)) return 'Enchantment';
  if (/\bArtifact\b/i.test(main)) return 'Artifact';
  return 'Other';
}

// Group a deck's entries into the sections the list renders, in display order.
//
// Three kinds of section come out of this, and they are different in kind, not
// just in name:
//
//   - Commander: entries on the 'commander' board. A deck-defining slot, so it
//     is shown first and separately regardless of the card's type.
//   - Card types: entries on a real board (mainboard/sideboard), bucketed by
//     type_line.
//   - Considering: entries on the 'considering' board. These are NOT part of
//     the deck -- they are cards the user is thinking about. They sit below
//     every type section so the deck proper reads as one uninterrupted list,
//     and they never contribute to the deck's card count.
//
// Empty sections are omitted rather than rendered with a zero. A row of "(0)"
// headers is noise that pushes the actual list off the screen.
export function groupDeckCards(cards) {
  const entries = Array.isArray(cards) ? cards : [];
  const sections = [];

  const commander = entries.filter(c => c.board === 'commander');
  if (commander.length > 0) {
    sections.push({ key: 'commander', title: 'Commander', kind: 'commander', cards: commander });
  }

  const real = entries.filter(c => c.board === 'mainboard' || c.board === 'sideboard');
  const buckets = new Map();
  for (const card of real) {
    const key = sectionForTypeLine(card.type_line);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(card);
  }
  for (const title of [...TYPE_SECTIONS, 'Other']) {
    const bucket = buckets.get(title);
    if (bucket && bucket.length > 0) {
      sections.push({ key: title, title, kind: 'type', cards: bucket });
    }
  }

  const considering = entries.filter(c => c.board === 'considering');
  if (considering.length > 0) {
    sections.push({ key: 'considering', title: 'Considering', kind: 'considering', cards: considering });
  }

  return sections;
}

// A section's header count is the number of physical CARDS, not the number of
// rows. "Creatures (22)" means twenty-two creatures; a player counting toward a
// 100-card Commander deck needs the copies, and four Lightning Bolts on one row
// is four cards.
export function sectionCount(cards) {
  return (cards || []).reduce((sum, c) => sum + (c.quantity || 0), 0);
}

// The badge shown on a deck card row.
//
// The tone vocabulary is 'ok', 'warn', 'muted', 'unavailable'. There is
// deliberately no 'error': not owning a card you plan to buy is a normal state
// of a deck under construction, and styling it as an error tells the user
// something broke when nothing did.
//
// 'unavailable' is the one red state and it means something narrow: a card the
// user is CONSIDERING has no free copy right now because a real deck holds them
// all. Red because it answers a yes/no question ("can I actually put this in?"),
// not a shopping shortfall. The row itself is never removed, dimmed or edited
// when this happens -- the user is still considering the card, they just cannot
// fill it today.
export function requirementStatus(card) {
  if (!card) return { tone: 'muted', label: '' };

  // Considering entries. These claim no physical card, so "missing" is
  // meaningless for them; the useful question is whether a matching copy is
  // FREE right now, which the server answers on every read. We branch on the
  // server's flag and never re-derive it.
  if (!card.reserves) {
    if (card.available === undefined) {
      // Older payloads without availability. Stay quiet rather than guessing.
      return { tone: 'muted', label: 'Not reserved' };
    }
    return card.available
      ? { tone: 'ok', label: `Available ${card.quantity_available}` }
      : { tone: 'unavailable', label: 'Unavailable' };
  }

  if (card.quantity_missing > 0) {
    return { tone: 'warn', label: `Missing ${card.quantity_missing} of ${card.quantity_required}` };
  }
  return { tone: 'ok', label: `Reserved ${card.quantity_reserved} of ${card.quantity_required}` };
}

// Human label for a finish. Shown next to every printing, because under
// exact-only identity the finish IS part of the card's identity -- a foil and a
// nonfoil Sol Ring are two different physical objects that do not substitute
// for one another.
export const FINISH_LABELS = {
  nonfoil: 'Nonfoil',
  foil: 'Foil',
  etched: 'Etched'
};

export function finishLabel(finish) {
  return FINISH_LABELS[finish] || finish || '';
}
