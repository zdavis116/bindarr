# PR 6G — Commander search, colour identity, cross-deck availability, card search

Found by Zach on the dev instance, 2026-08-18, from real use.

---

## 1. Commander search should only offer legal commanders

The commander search in the Create New Deck modal returns any card. It must
only surface cards that can actually be a commander: legendary creatures, and
cards whose text says they can be your commander (Backgrounds where relevant,
"can be your commander" planeswalkers, etc.).

The refusal logic for this already exists (`isLegalCommanderCard` in
`commanderRules.js`). Filter the search with the same rule so the user never
picks something that will then be refused — do not implement a second,
divergent notion of "legal commander".

## 2. Colour identity is not enforced (CORRECTNESS BUG)

Zach added Kodama of the West Tree (green) to a red/blue Commander deck and it
was accepted.

A Commander deck may only contain cards whose colour identity is a subset of
the commander's colour identity. Colour identity includes mana symbols in
costs, in rules text, and colour indicators — not just the card's colours.

**This is a hard format rule, so it is REFUSED, not warned**, consistent with
singleton and commander validity. The refusal must say why, naming the
offending colour(s) and the commander's identity.

Applies to every write path: add from Browse Collection, multi-select add,
import (reported in the pre-flight, not after), re-pin, and board moves.

Notes:
- Commander format only. Other formats are unaffected.
- Lands producing off-identity mana are part of colour identity and are
  refused like anything else.
- Overridable? Colour identity is computed from card data, not parsed prose,
  so the app should not be wrong about it — treat as NOT overridable, matching
  singleton. Confirm with Zach if a case emerges where this is too strict.
- **Changing the commander (Zach, 2026-08-18):** allow the swap, but warn first
  that it **will remove** any cards that are no longer colour-legal.

  The warning must be shown BEFORE the swap is applied and must **name the
  exact cards** that will be removed, with a count. The user confirms, then the
  swap and the removals happen together as one atomic operation — either both
  or neither, never a swapped commander with a half-cleaned deck.

  This is not a silent state change: the user is told precisely what will be
  removed and explicitly agrees. Removing a deck entry releases its reservation
  and any allocation; it does not touch the physical card in storage, which
  simply becomes available again.

  If the swap is refused for any other reason (illegal commander, illegal pair,
  same name), nothing is removed.

- **A commander is SWAPPED, never DELETED (Zach, 2026-08-19).** Verbatim: *"You
  cant outright delete the commander only swap and when swapping you should get
  a warning if the swap is to a different color type."*

  This SUPERSEDES the earlier rule that refused only the delete which would
  strand cards. There is now **no delete-commander operation at all**: any
  DELETE of a row on the `commander` board of a Commander-format deck is refused
  as unsupported (`COMMANDER_DELETE_UNSUPPORTED`, 409) with a message pointing
  the user at the swap. The refusal is unconditional — it applies to an empty
  deck as much as a full one — because PR 6F already refuses to *create* a
  Commander deck without a commander, and permitting deletion afterwards was a
  hole in that same rule rather than a separate question.

  It applies to a **second commander** too: removing one half of a legal partner
  pair takes the zone from two commanders to one, which is a swap of the zone,
  so it goes through the same plan-and-confirm path as any other swap.

  Because DELETE is refused outright, that transition needs somewhere to live,
  or a partner deck could never become a mono-commander deck — a rule with no
  way through. It is therefore expressed on the swap route as
  `POST /api/decks/:id/cards` with `drop_commander_deck_card_id`. It uses the
  **same planner, same warning code, same confirmation flag and same atomicity**
  as a replacement swap, so two ways of reaching one command zone cannot
  disagree about what that zone strands. The **last** commander is not droppable
  by this path either — same `COMMANDER_DELETE_UNSUPPORTED` refusal.

  This closes the reviewer's Repro A (delete commander → add off-identity card →
  restore commander) by removing its first step.

  **CORRECTION (round 2).** An earlier draft of this document claimed the
  empty-command-zone state was *structurally unreachable*. That claim was
  **wrong**, and the way it was wrong is the point.

  Both commander gates on the swap route were keyed on `board === 'commander'`
  — "is the DESTINATION the command zone" — so a write that moved a commander
  **off** the zone (destination `mainboard` or `considering`, origin
  `commander`, named via `replacing_deck_card_id`) did not look like a commander
  operation and skipped every commander check. Moving the only commander that
  way emptied the zone and returned 200. `COMMANDER_DELETE_UNSUPPORTED` was
  therefore **live, load-bearing logic**, not the backstop it was documented as,
  and the choke point's empty-zone refusal was the only thing standing between
  the user and Repro A.

  The fix keys both gates on `touchesCommandZone` — true when **either side** of
  the write is the command zone — and the last-commander refusal is raised on
  this route explicitly rather than being assumed unreachable. The empty-zone
  refusal at the write choke point remains as genuine defence in depth.

  The root error is the same one that produced the PR 6F pairing blocker and the
  PR 6G round-1 delete blocker: **the check was attached to a specific operation
  rather than to the state change it produces**. The full enumeration of verbs
  that can change the command zone, and where each is validated, is written at
  the choke point in `backend/src/routes/decks.js` and mirrored by test
  `F15-TC56`, which has one case per verb.

- **The swap warning fires only when cards are actually stranded
  (Zach, 2026-08-19).** Zach's wording is "a warning if the swap is to a
  different color type", and the operative test is whether the change strands
  anything. A swap to the **same** colour identity, or to a **broader** one that
  still admits every card in the deck, removes nothing and applies cleanly with
  **no warning and no confirmation step**. Only a swap that would genuinely
  strand cards names them with a count, requires confirmation, and then applies
  the swap plus removals atomically.

  The rationale is behavioural, not cosmetic: a confirmation dialog that always
  appears trains the user to click through it without reading, which destroys
  the value of the one that actually matters.

## 3. "In Deck" must count ALL decks (CORRECTNESS BUG — false availability)

In Browse Collection, a card shows `In Deck: 1` while viewing the deck that
holds it, but `In Deck: 0` when viewing a different deck.

Zach: "that in deck should reflect if it's in any deck otherwise it gives you a
false idea if it's available or not."

**In Deck is the total number of copies committed to decks across ALL decks**,
independent of which deck is currently open — not a per-deck figure and not a
count of decks.

- Own 6 Breena, 1 copy in one deck → `Owned: 6 | In Deck: 1`
- Own 6 Breena, 1 copy in each of 4 decks → `Owned: 6 | In Deck: 4`
- Own 6 Breena, 2 in one deck and 1 in another → `Owned: 6 | In Deck: 3`

`Owned − In Deck` must equal the number genuinely free for the deck being
viewed. The current behaviour tells the user a card is available when it is
already committed elsewhere, which is exactly the "app shows something false
about what you own" class.

If it is useful to distinguish "in THIS deck" from "in other decks", show both
— but the availability figure must account for every deck.

## 4. Card search does not work outside the collection

Searching inside a deck should search **all cards, owned or not** — that is the
point of searching from the deck rather than from Browse Collection. Zach:
"searching when inside the deck would allow you to search on cards you own /
don't own."

Each result should show the **available count** alongside it, so the search
itself answers "do I even have this?" without a second lookup. A card he does
not own (or has none free) is added as a requirement and marked **missing**.

Currently a card he does not own returns nothing, so unowned cards cannot be
added as requirements and a commander cannot be chosen before acquiring it.

Search must reach the full card catalogue, not only owned rows.
`GET /api/search` already takes a `scope` parameter (`scope = 'database'` by
default) — determine why catalogue results are not returned and fix it. The
per-set index built by `POST /api/prepare-set` may be involved; if a set index
must be built before catalogue search works, that must happen transparently
rather than silently returning zero results.

Possibly related, unconfirmed: while seeding the dev instance, one card
(Cultivate) returned `503 UPSTREAM_UNAVAILABLE` from `/api/search` while nine
others succeeded. That was assumed to be Scryfall rate-limiting after repeated
set-index builds, but it may be the same underlying fault. Worth checking
whether catalogue search failures surface as empty results or 503s rather than
something diagnosable.

## 4b. MISSING must be red, not yellow

Zach: "missing should show red not yellow."

A missing card means he cannot build the deck as it stands — that is a problem,
not a caution. Red is already the app's colour for unavailable (per the
considering-card availability rule in PR 6C). Yellow reads as a warning about
something optional.

Use the existing red treatment already used for unavailable cards; do not
introduce a new colour or badge style.

---

## Style constraint

Preserve the existing production look and layout. Adapt existing UI in place.
Never replace an existing screen with a new component.

## Data model note

One physical card = one row; `splitStackedEntries()` runs at startup. Grouping
is display-only — do not merge rows in the database.
