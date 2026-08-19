# Buylist / export (plan Task E3)

The first feature that makes Bindarr useful outside itself: missing cards become
something Zach can actually shop from.

---

## Core behaviour (from the original plan, Task E3)

- The buylist uses **exact printing + finish shortages**, calculated **after
  reservations by other saved active decks**. It lists what he genuinely still
  needs, not what he already owns but has committed elsewhere.
- It **never lists owned surplus copies**.
- Ordinary deck **export** includes all planned cards, including missing ones —
  export and buylist are different outputs with different rules.
- Missing **commander / mainboard / sideboard** entries are actionable and
  included by default.
- Missing **considering** entries are shown in a **separate neutral section and
  excluded from the buylist by default** — consistent with the settled rule that
  considering never reserves and is not part of the deck.

## Exact printing is required (Zach, 2026-08-19)

"for buylist exact printing matters because I may chose a cheaper printing."

This is deliberately the OPPOSITE of the import rule, and both are right because
they answer different questions:

- **Import** asks "which of my physical cards fills this slot" — any owned
  printing will do.
- **Buylist** asks "which card am I buying" — the printing IS the decision,
  because it is a price decision.

Substituting a printing on a buylist would silently spend his money differently
than he chose. Never substitute, never generalise to "any Sol Ring".

### Follow-on worth considering

If he is choosing printings on price, the moment he picks a printing is the
moment he needs to see prices. The printing picker currently shows set and
collector number, not cost — so he has to look elsewhere, decide, and come back.
Per-printing prices at the point of choosing may be the real feature here.

Do NOT build it in this PR without asking. Price data freshness is its own
question, and see the PR 6H review note below.

## Known interaction: price freshness

The PR 6H reviewer flagged that a catalogue refresh stamps `last_updated` on
every row, which permanently satisfies `scryfallApi.js`'s 3-day price-staleness
check. Nothing false is shown about ownership or legality — but it means the
price sweep may stop refreshing prices, and this PR is explicitly price-adjacent.
Check it while here.

---

## Also in this PR

### Deck Health placement (Zach, 2026-08-19)

PR 6I moved Deck Health & Rules above the card list, but below Add Cards. Zach:
"deck health should be above the card search/browse collection on mobile."

Move it above the Add Cards / Browse Collection section. On a phone the panel
that says what is wrong should come before the tool for fixing it.

### Extract MissingCardsPanel

The original plan warned: "Do not continue growing the existing 100+ KB component
without extraction", and named `DeckCardRow`, `DeckSearch`, `MissingCardsPanel`
as candidates. `CardTile` was extracted in PR 6F; `DeckBuilder.jsx` has absorbed
four more PRs of features since.

The buylist IS a missing-cards surface, so build it as `MissingCardsPanel` rather
than growing `DeckBuilder.jsx` further. This is building the new thing in the
right place, not a refactor for its own sake.

### Verify plan requirement H1

The plan required: "Preserve user-owned/deck-referenced cache rows if an upstream
object disappears." If Scryfall drops a card from bulk data, a card Zach owns must
survive the refresh. The PR 6H review found zero orphans, but confirm this is by
design rather than incidental — a refresh that removes a card he owns is data loss.

### Verify plan requirement G1

The plan's acceptance for finishes: "The UI only offers finishes available in
Scryfall's `finishes` array for the selected printing." Check whether the finish
picker filters per printing or offers all three regardless. Offering Foil for a
card never printed in foil invites recording a card that does not exist — and
that error would flow straight into a buylist.

### Harden the e2e case-count regex

`test/e2e/run.js:34,44` uses `/PASS: F\d+-TC\d+/`, so feature ids containing
letters run and pass but are NOT counted — eleven tests were silently uncounted in
PR 6I. Exit codes were always correct; only the tally was wrong. Harden to
something like `/PASS: F[A-Z0-9]+-TC[A-Za-z0-9]+/`. The tally is quoted as the
verification signal, so it needs to be honest.

---

## Style constraint

Preserve the existing production look and layout. Adapt existing UI in place.
Never replace an existing screen with a new component.
