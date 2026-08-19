# Backlog after PR 6H

Ranked by Zach, 2026-08-19. He also said: "overall I think we should re-evaluate
after 6H" — so treat this as a starting order, not a committed queue.

---

## 1. Buylist / export (plan Task E3)

Missing cards already render red in the deck view. Make them actionable: a
buylist you can actually shop from.

- Aggregate missing requirements across a deck, and probably across all decks.
- Export in a form a shop or marketplace accepts.
- **EXACT PRINTING IS REQUIRED** (Zach, 2026-08-19): "for buylist exact
  printing matters because I may chose a cheaper printing."

  Note this is the OPPOSITE of the import rule, and correctly so — they answer
  different questions. Import asks "which of my physical cards fills this slot",
  so any owned printing will do. Buylist asks "which card am I buying", where
  the printing IS the decision because it is a price decision. Substituting a
  printing on a buylist would silently spend his money differently than he
  chose.

  So: the missing entry's exact printing and finish is the instruction. Never
  substitute, never generalise to "any Sol Ring".

  Implication worth exploring: if he is choosing printings on price, the deck
  view may need to show per-printing prices when picking a printing, so the
  choice can be made where it is made rather than by checking elsewhere first.
  Confirm with him before building — price data availability and freshness is
  its own question.
- The existing export path may already do some of this. Check before building.

## 2. Scanner (plan Tasks H2 then G2)

H2 is explicitly "measure scanner throughput BEFORE redesign" — the plan says
measure first rather than assume a rebuild is needed. The infrastructure exists
(`scanPool`, embedding DBs in `app/backend/data`) but was never MTG-adapted.

G2 (scanner finish confirmation) depends on scanning working at all.

Note the nightly catalogue (6H) is effectively a prerequisite: scan matching
needs complete card data to match against.

## 3. Moxfield integration (NEW — Zach, 2026-08-19)

"if I build a deck in moxfield being able to automatically pull it into the app"

Import a deck from Moxfield directly rather than copy-pasting a decklist.

- Moxfield has a public API for public decks; check current access rules and
  rate limits before designing.
- The import pre-flight built in PR 6F already handles the hard part: singleton
  refusals, printing choices, unowned cards reported before committing. A
  Moxfield pull should feed that same path, not a parallel one.
- Moxfield decklists may name printings; where they do, honour them (Case A of
  the settled import rules). Where they don't, the existing allocate-from-owned
  logic applies.
- Decide whether this is one-shot import or an ongoing sync. Sync raises the
  question of what wins when both sides change — worth avoiding initially.

## 4. Mana Pool integration (NEW — Zach, 2026-08-19)

"being able to send missing cards to mana pool automatically as well"

Push the buylist (item 1) straight to Mana Pool rather than exporting and
re-entering it.

- Depends on item 1: there must be a buylist before it can be sent anywhere.
- Check what Mana Pool actually accepts — API, cart URL, or file upload.
- Same printing question as the buylist: does it request the exact printing or
  just the card?

## 5. Other-format legality (plan Task F3)

Modern, Standard, Pioneer legality checks. Lowest priority — only matters if
Zach builds non-Commander decks, and he has not said he does.

---

## Deliberately not doing

Colour-identity drift detection. See docs/PR6H-NIGHTLY-CARD-CACHE.md — colour
identity cannot change on a printed card; the only real case is Scryfall
correcting its own data error. Revisit only when nothing else is outstanding.
