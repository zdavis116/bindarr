# UI overhaul mockups

Static HTML mockups for the Bindarr UI overhaul, reviewed and approved by Zach
on 2026-08-30. They are the reference the rebuilt screens are checked against.

Each file is standalone: no build step, no dependencies, inline CSS and JS.
Open one in a browser, or serve the folder.

| Folder | Screen | Notes |
|---|---|---|
| `002-home` | Home / dashboard | Landing screen. Scan is a hero button, not a nav tab. |
| `001-quiet-canvas` | Collection | Owned cards ONLY. Multi-select WUBRG pips; Types and Sets are multi-select sheets. |
| `003-deck-list` | Decks | Deck picker + multi-deck buylist. |
| `001-card-forward` | Deck detail | Missing IS the buylist; no separate panel. |
| `005-new-deck` | New deck | Format first; commander/bracket only for formats that have them. |
| `001-workbench` | Scanned list | Restyle only — behaviour already shipped in the scanner branch. |
| `004-desktop` | Desktop deck builder | The one screen with a distinct desktop layout. |
| `006-import` | Import | Built in Feature 3, not this branch. |
| `007-settings` | Settings | One "Data sources" section, not sync + connected accounts. |
| `008-admin` | Administration | No scan-index UI — see the roadmap's Phase C. |

## Decisions these encode

Recorded because the reasoning is easy to lose and expensive to relitigate:

- **Dark, Apple-like, mobile-first.** Zach uses this on a phone while holding
  physical cards; desktop matters for deck building and browsing.
- **Four nav destinations:** Home, Collection, Decks, Settings. Scan is NOT a
  tab — the Home hero button covers it.
- **Collection shows only owned cards.** No missing/needed concept:
  "it muddies the water."
- **Colours are multi-select.** A Golgari card is B *and* G; single-select
  cannot express it. Types are multi-select for the same reason — a card can be
  Creature *and* Enchantment.
- **Multi-deck buylist buys ONE COPY PER DECK, not deduped.** Three decks
  needing a Sol Ring means buying three. Zach: "I don't want to have to keep
  swapping cards between decks would rather each deck be built ready to go."
- **Nothing floats.** The Scanned list is strictly newest-first; rows needing
  attention are marked by colour, never by moving. A list that rearranges
  itself cannot be checked at a glance against the card in your hand.
- **One "Data sources" section.** Splitting sync from connected accounts sorted
  sources by whether they need a login, which is an implementation detail. What
  matters is which are current and which are stale.

## Caveat

These were never rendered by their author — no browser was available on the
machine that wrote them. Every layout judgement in them is unverified by
anything except Zach's own review on a phone. Treat his screenshots as the
authority when they disagree.

Full plan: `.hermes/plans/2026-08-30_143000-bindarr-roadmap.md`
