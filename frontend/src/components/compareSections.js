// Section a COMPARISON side (my deck / the pre-built deck) into the same card
// type sections the deck view uses, each sorted alphabetically.
//
// Zach (2026-09-20): "organize each list just like the deck view like by card
// type and do each section in alphabetical order."
//
// ONE SECTIONING RULE, NOT TWO.
//
// This delegates to deckSections.sectionForTypeLine rather than reimplementing
// the type_line -> section mapping. That mapping is full of load-bearing
// decisions (Land beats Creature beats Artifact, so "Artifact Creature Land"
// files under Lands) and a second copy would drift. Drift here is especially
// bad: the whole point of this screen is that the two columns LINE UP, so a
// card sectioned differently on each side reads as a difference in the decks
// when it is really a difference in our code.
//
// The two sides arrive with different shapes -- Bindarr entries carry a
// Scryfall type_line string, Mana Pool cards carry a types ARRAY -- so the
// route normalises both to `typeLine` before they get here. This function
// takes only the normalised shape.
// The .js extension is REQUIRED even though Vite would resolve without it:
// these rules are tested by plain `node`, which does not guess extensions.
import { TYPE_SECTIONS, sectionForTypeLine } from './deckSections.js';

// Alphabetical, case-insensitive, and stable. localeCompare so accented names
// ("Jötun Grunt") sort where a reader expects rather than after Z.
const byName = (a, b) => String(a.name || '')
  .localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });

export function sectionCompareCards(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const sections = [];

  const commander = list.filter((c) => c.isCommander);
  if (commander.length > 0) {
    sections.push({ key: 'Commander', title: 'Commander', cards: commander.sort(byName) });
  }

  const buckets = new Map();
  for (const card of list) {
    if (card.isCommander) continue;
    const key = sectionForTypeLine(card.typeLine);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(card);
  }

  // TYPE_SECTIONS is the deck view's display order -- roughly the order a
  // player thinks about a list, lands last. 'Other' is the catch-all for an
  // unrecognised type line: a card that VANISHES because its type surprised us
  // is far worse than one in a miscellaneous section, because the user would
  // count the list, come up short, and have nothing to look at.
  for (const title of [...TYPE_SECTIONS, 'Other']) {
    const bucket = buckets.get(title);
    // Empty sections are omitted. A column of "(0)" headers pushes the real
    // list off a short screen.
    if (bucket && bucket.length > 0) {
      sections.push({ key: title, title, cards: bucket.sort(byName) });
    }
  }

  return sections;
}

// Physical cards, not rows: "Creatures (22)" must mean twenty-two creatures,
// because that is the number a player counts toward 100.
export function compareSectionCount(cards) {
  return (cards || []).reduce((sum, c) => sum + (c.quantity || 1), 0);
}
