// Section a COMPARISON side (my deck / the pre-built deck) for display.
//
// Zach (2026-09-20): "organize each list just like the deck view like by card
// type and do each section in alphabetical order."
//
// "JUST LIKE THE DECK VIEW" MEANS THE DECK VIEW'S RULE, NOT A MATCHING ONE.
//
// The first attempt borrowed deckSections.js, which looked equivalent and was
// not: no Battle section and plural labels, so a battle card appeared in an
// OTHER section the deck view does not have. This now calls the SAME function
// DeckView renders with (deckListSections.js), so the two screens cannot drift.
//
// The only thing this module adds on top is the alphabetical ordering, which is
// specific to the comparison: the deck view keeps its server ordering, while
// two lists being read against each other have to be scannable in parallel.
import { groupIntoSections, sectionCardCount } from './deckListSections.js';

// Alphabetical, case-insensitive. localeCompare so accented names ("Jötun
// Grunt") sort where a reader expects rather than after Z.
const byName = (a, b) => String(a.name || '')
  .localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });

export function sectionCompareCards(cards) {
  return groupIntoSections(cards, { sort: byName })
    .map((s) => ({ key: s.name, title: s.name, cards: s.cards }));
}

export { sectionCardCount as compareSectionCount };
