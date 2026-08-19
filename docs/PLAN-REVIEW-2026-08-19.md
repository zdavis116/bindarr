# Plan review, 2026-08-19 (after PRs 6A–6H)

The original plan (`.hermes/plans/2026-08-16_...`) was written before Zach had
used any of it. Eight PRs later, roughly 60% is delivered — but not in the
plan's order, and several items were reshaped by his hands-on feedback into
something better than specified. This is the reconciliation.

---

## Delivered

| Plan task | Where | Note |
|---|---|---|
| E1 — search all cards from a deck | PR 6G | plus PR 6H made it complete and fast |
| E2 — display ownership and shortage | PR 6G | Owned / In Deck / Available / Missing |
| F1 — deck zones | PR 6D | card-type sections inside the deck list |
| F2 — Commander validation | PR 6F/6G | far beyond the plan: singleton by name, colour identity, pairing rules, overrides with recorded reasons |
| G1 — MTG finish semantics | PR 6E | nonfoil/foil/etched; found and fixed the Pokémon CHECK constraint that made every foil add fail |
| H1 — Scryfall bulk importer | PR 6H | stage-and-validate before replacing, as specified |

## Outstanding

**E3 — Buylist/export.** The largest untouched piece. Already well specified in
the plan; see `docs/BACKLOG-AFTER-6H.md` for Zach's additional decisions.

**H2 — Measure scanner throughput.** Explicitly a measurement exercise, not a
build task. The plan is right to demand numbers before any redesign.

**G2 — Scanner finish confirmation.** Depends on scanning working at all.

**F3 — Other-format legality.** The plan says "implement after Commander
behavior is accepted" — it now is. Lowest priority; Zach has not said he builds
non-Commander decks.

---

## Where the plan is now WRONG — do not implement these

- **Flexible match mode.** E2 lists `Deck match mode: Exact / Flexible` as a UI
  field. Flexible was dropped early; deck identity is exact-only. Do not
  reintroduce it.
- **E3's import rules.** The plan says a name-only import line should go to an
  import-review list unless exactly one variant is unambiguous. Zach superseded
  this in PR 6F with a better rule: allocate from printings he owns, extend the
  most-used owned printing to cover a shortfall, and ask ONLY when he owns zero
  and the line names no printing. Keep his rule.

## Verify rather than assume

- **H1 requirement not explicitly confirmed:** "Preserve user-owned/
  deck-referenced cache rows if an upstream object disappears." If Scryfall
  drops a card from bulk data, an owned copy must survive the refresh. The PR 6H
  review found zero orphans, but confirm this is by design, not luck.
- **G1 acceptance not confirmed:** "The UI only offers finishes available in
  Scryfall's `finishes` array for the selected printing." Check whether the
  finish picker filters per printing, or offers all three regardless.

## Standing advice we have been ignoring

> "Do not continue growing the existing 100+ KB component without extraction."

`DeckBuilder.jsx` was already large when the plan flagged it, and has absorbed
four PRs of feature work since. `CardTile` was extracted in PR 6F; the plan also
suggested `DeckCardRow`, `DeckSearch`, `MissingCardsPanel`.

Not urgent, and not worth a dedicated PR — but the buylist adds a missing-cards
surface, which is exactly the `MissingCardsPanel` the plan named. Extract it as
part of that work rather than growing the component further.

---

## Agreed order (Zach, 2026-08-19)

1. **PR 6I** — polish (in flight)
2. **Buylist / export** (plan E3)
3. **Scanner measurement** (plan H2)
4. Then: Moxfield import, Mana Pool push, other-format legality
