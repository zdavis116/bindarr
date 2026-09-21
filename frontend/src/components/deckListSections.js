// THE deck-list sectioning rule. One copy, used by the deck view and by the
// pre-built comparison.
//
// Extracted from DeckView.jsx (2026-09-20) when the compare screen was asked to
// organize "just like the deck view". Matching that by EYE produced a real bug:
// the compare screen borrowed deckSections.js, whose TYPE_SECTIONS has no
// Battle entry and uses plural labels, so "Invasion of Kaldheim" landed in an
// OTHER section that the deck view does not have. Two rules that are supposed
// to agree will not stay in agreement; the only fix is for there to be one.
//
// deckSections.js keeps its own TYPE_SECTIONS for the deck BUILDER, which has
// different sections (Considering) and different labels. That is a genuinely
// different screen, not a duplicate of this one.

// DISPLAY order: how sections read down the page (Moxfield's order). The
// commander first because it is the deck's premise, lands last because they
// are the part you tune once everything else is settled.
export const TYPE_ORDER = ['Commander', 'Creature', 'Instant', 'Sorcery',
  'Artifact', 'Enchantment', 'Planeswalker', 'Battle', 'Land'];

// PRIORITY order: which type wins when a card has several. Deliberately NOT the
// display order -- conflating the two is what once filed Zach's artifact lands
// under Artifact.
//
//   - Land first. "Artifact Land" is a land: it is what he counts when he
//     checks his mana base, and a land hiding in the artifact section makes the
//     deck look four lands short. Zach: "Any card with type land should be a
//     land."
//   - Creature next. "Artifact Creature" is a creature you cast and attack
//     with; filing it under Artifact hides it from the creature count.
const TYPE_PRIORITY = ['Land', 'Creature', 'Planeswalker', 'Battle',
  'Instant', 'Sorcery', 'Enchantment', 'Artifact'];

const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant',
  'Land', 'Planeswalker', 'Sorcery'];

// Which section a card belongs in.
//
// `isCommander` is passed separately rather than read off a board field,
// because the two callers identify the commander differently: the deck view has
// board === 'commander', the comparison has Mana Pool's is_commander flag.
export function sectionForCard(typeLine, isCommander) {
  if (isCommander) return 'Commander';
  // Everything before the em dash is the card type(s); after it is subtypes
  // (Goblin, Equipment), which would produce a section per creature type.
  const line = String(typeLine || '').split('—')[0];
  for (const ty of TYPE_PRIORITY) {
    if (line.includes(ty)) return ty;
  }
  return CARD_TYPES.find((ty) => line.includes(ty)) || 'Other';
}

// Group cards into sections in display order, omitting empty ones.
//
// `sort` is optional: the deck view keeps its server ordering, the comparison
// sorts alphabetically. Sectioning and ordering-within-a-section are separate
// decisions and are kept separate here.
export function groupIntoSections(cards, { sort } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const by = new Map();
  for (const card of list) {
    const key = sectionForCard(card.typeLine ?? card.type_line,
      card.isCommander ?? card.board === 'commander');
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(card);
  }
  // 'Other' is a catch-all, never a drop. A card that VANISHES because its type
  // surprised us is far worse than one in a miscellaneous section: the user
  // counts to 99 and cannot find the hundredth.
  //
  // sectionForCard can only ever return a name from TYPE_ORDER or 'Other', so
  // filtering by that list is total -- it cannot drop a card. An earlier
  // version appended a second "unlisted sections" pass as insurance; it was
  // unreachable, and worse, it made a battle render under "Battle" even with
  // Battle deleted from TYPE_ORDER, which disguised exactly the bug that
  // shipped. Dead insurance that hides a real failure is worse than none.
  //
  // The guarantee this relies on is asserted directly (CS-TC10): every type
  // line the rule can be handed maps to a section this list contains.
  return [...TYPE_ORDER, 'Other']
    .filter((name) => by.has(name))
    .map((name) => {
      const group = by.get(name);
      return { name, cards: sort ? [...group].sort(sort) : group };
    });
}

// Header counts are PHYSICAL CARDS, not rows: 34 Mountains is 34, because that
// is the number a player counts toward 100. A card with no quantity counts as
// one -- a pre-built deck list omits it for singletons, and treating that as
// zero would under-report every section on their side.
export function sectionCardCount(cards) {
  return (cards || []).reduce((n, c) => n + (c.quantity ?? 1), 0);
}
