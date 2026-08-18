# PR 6F — Deck picker, commanders, and grid styling

Issues found by Zach on the dev instance, 2026-08-18, from real use.

---

## 1. Browse Collection rows are already per-printing — the picker is redundant

The earlier report of "indistinguishable duplicate rows" is resolved: rows in
Browse Collection are now correctly separated by printing, e.g.

```
Sol Ring (Commander Masters · #410)   Owned: 1 | In Deck: 0
Sol Ring (Commander 2021 · #263)      Owned: 2 | In Deck: 0
```

**But clicking `+` on one of those rows opens a "Choose the exact printing and
finish" panel listing both printings again.** That is redundant and wrong: the
row the user clicked already *is* one exact printing and finish. Clicking `+`
must add that specific card directly, with no intermediate choice.

The printing picker should only appear where the app genuinely does not know
which printing is meant — e.g. a bare text-import line with nothing owned. It
must not appear when the user has just clicked a specific per-printing row.

## 2. Show FOIL in the Browse Collection list

Rows show set and collector number but not finish, so a foil and a nonfoil of
the same printing look identical. Add a foil indicator to the row.

Use the styling already used on the Collection screen, which renders a yellow
`FOIL` badge on the card (see the collection grid). Adapt that existing
treatment — do not invent a new badge style.

## 3. Deck grid mode must match the Collection screen's card styling

The deck's Grid view renders cards differently from the Collection screen.

Collection grid cards have:
- the set-symbol/rarity chip top-left (`COM`, `UNC`)
- the quantity badge top-right (`x4`) in the collection's style
- a `FOIL` badge on foil cards
- card name, set · collector number, and price below the image

Deck grid cards instead use a yellow `x1` badge, a green `Reserved 1 of 1`
pill, and a different action row.

Make deck grid cards use the **same visual treatment as the Collection screen**.
Deck-specific information (reservation state, remove/add/considering actions)
should be presented within that existing style rather than replacing it.

Adapt the existing Collection card component/styles rather than restyling the
deck cards independently — two implementations of the same card will drift.

## 4. Commander selection is still missing

Choosing format **Commander** in the Create New Deck modal still shows no
commander field. This was specified but is not implemented.

Applies **only when format is Commander**; other formats must be entirely
unaffected — no extra field, no extra validation, no visual change.

**At deck creation:**
- Selecting format Commander reveals commander input(s).
- A commander is **required** to create the deck.
- Support **one or two** commanders — partner pairs and Backgrounds are common,
  and a partner-only commander (e.g. The Prismatic Piper) is never a legal solo
  commander, so a single slot would be wrong on day one.

**Inside the deck:**
- The commander can be changed/swapped from the deck view.

**Existing commanderless decks (Zach, 2026-08-18):** requiring a commander at
creation is sufficient. Production launches on a fresh v2 database with no
decks, so a Commander deck existing without a commander is unreachable there —
it can only occur on the dev instance from decks made before this rule. Leave
the existing warning path as a harmless backstop; do not add retroactive
enforcement.

Both commanders are exact-identity entries (printing + finish) like any other
card, and occupy the existing **Commander** section in the deck card list added
in PR 6D. Commander legality stays warning-only.

## 5. Singleton rule for Commander decks — by NAME

In a Commander deck a card may appear only once **by card name**. Exact-only
identity does not relax this: if Sol Ring (C21 · #263) is in the deck, adding
Sol Ring (CMM · #410) must be refused — different printing and finish, but the
same card name, so it breaks singleton.

Notes:
- This applies to the Commander format only. Other formats keep their own
  limits (e.g. 4-of in Constructed).
- Basic lands are exempt from singleton, as are cards whose text explicitly
  allows any number (Relentless Rats, Shadowborn Apostle, Dragon's Approach,
  Persistent Petitioners, Nazgûl, Seven Dwarves).
- Per Zach (2026-08-18): singleton is **REFUSED, not warned** — in the picker
  AND in import. The refusal must say why ("Sol Ring is already in this deck;
  Commander decks allow one copy by name").

  This is a deliberate exception to the warning-only rule. Ownership and
  suggestions are warnings; singleton is a hard format rule, and a deck that
  silently breaks it is not a deck you can play.

## 5b. Import needs a pre-flight validation summary

Following from the above — import should **check before it commits** and report
what is wrong, rather than importing and leaving the user to discover problems.

Before applying an import, surface a summary of errors and warnings, e.g.:

- duplicates that break singleton (refused — line will not import)
- lines needing a printing choice
- lines that are unowned (imported, but flagged)
- anything else that will not import cleanly

The user sees what will happen before it happens, and refused lines are named
rather than silently dropped. This is consistent with the conservation
invariant already enforced in PR 6D: copies requested must equal entries
created plus copies explicitly reported.

Reuse the existing import/compare screen for this — do not build a new screen.

---

## Commander pairing rules (Zach, 2026-08-18)

- **Two commanders may never share a card name.** Singleton applies in the
  command zone exactly as it does in the deck. REFUSED.
- **A command zone may never hold more than two commanders, and that refusal is
  NOT overridable** (Zach, 2026-08-18). No printing could make three commanders
  legal, so there is nothing the user could know that the app does not. An
  override here would only ever produce an unplayable deck.

  The test for whether a refusal gets an override: **can Bindarr be wrong about
  this?** Zone size, same-name commanders and singleton are fixed rules the app
  cannot be wrong about — no override. Pairing legality is parsed from oracle
  text and new mechanics are printed regularly, so the app CAN be wrong — that
  one is overridable with a recorded reason.

- A deck has **one** commander, OR a second one **only if the pair is legal** —
  the cards must actually permit it (Partner, Partner With, Friends Forever,
  Choose a Background, Doctor's companion, and similar). Two arbitrary
  legendary creatures are not a legal pair.
- **An illegal pairing is REFUSED at deck creation, not warned** (Zach,
  2026-08-18, superseding the earlier warning-only treatment for this case) —
  **but the refusal is overridable with an explicit confirmation.**

  Zach: "Refuse, but let me override with a confirmation if I know it's legal."

  Why an override here and nowhere else: singleton has no override because the
  rule is fixed and the app cannot be wrong about it — two cards named Sol Ring
  is always illegal. Pairing legality is detected by parsing oracle text, and
  Wizards prints new pairing mechanics regularly, so the app CAN be wrong. The
  override exists because the app's knowledge is incomplete, not because the
  rule is soft. Without it, an unrecognised new mechanic would permanently
  block a legal deck with no way around it.

  Behaviour: refuse by default with a clear reason, and offer an explicit
  confirmation to proceed anyway. Silence is not consent — the user must
  actively confirm. Do not make the override the default path or a checkbox
  that can be left ticked.

  **The override must capture WHY** (Zach, 2026-08-18): "include a way to note
  why I am confirming it's legal so you can update yourself and in the future
  be more aware of the new pairing mechanic."

  So the confirmation takes a short free-text reason from the user, and the
  override is RECORDED — the two card IDs/names, the reason given, and the
  timestamp. This is not an audit-trail formality; it is a feedback loop. Each
  recorded override is a concrete report that the parser failed to recognise a
  real mechanic, with a worked example attached, so the detection can be
  improved rather than the user re-overriding the same pair forever.

  Surface these somewhere reviewable (a settings/admin view or an existing log
  view — reuse an existing surface, do not build a new screen). The value is
  that the list of overrides becomes the to-do list for improving partner
  detection.

  Rationale for refusing at all, so this is not "corrected" back later:
  warning-only is right for deck *contents*, where an incomplete or not-yet-
  legal deck is a normal work-in-progress state — the user fixes it by
  continuing to work. The commander is different: it is the deck's identity,
  fixed at creation, and it determines the colour identity every other card is
  validated against. An illegal pair is not "unfinished"; it is a deck that can
  never become legal, with every subsequent card checked against a wrong
  foundation. The test is: can the user fix this by continuing? If yes, warn.
  If no, refuse at the point it is introduced.

  So: commander validity is REFUSED (overridable) at creation and on swap. Deck
  *contents* legality (missing cards, colour-identity violations among the 99,
  deck size) remains warning-only and is NOT overridable-because-not-blocking.
- The commander must also be a legal commander in its own right — a legendary
  creature, or a card whose text says it can be your commander. Refuse at
  creation if it is not.

## Multi-select add must validate before applying

Selecting several cards at once in Browse Collection must behave like import:
validate the whole selection first, report anything that will not apply
(singleton duplicates, cards already in the deck), then apply. Do not apply
part of a selection and report the rest afterwards.

Same principle as the import pre-flight and PR 6D's conservation invariant:
never let the user discover afterwards what they could have been told
beforehand.

### As implemented

- `commanderRules.preflightDeckAdds()` is the ONE implementation of "judge
  many candidates against one snapshot plus the candidates already accepted in
  this pass". The bulk route calls it; it is not a second copy of the import
  logic.
- `POST /api/collection/bulk` with `action: 'add_to_deck'` answers **409 /
  `BULK_ADD_PREFLIGHT`** when any part of the selection would be refused,
  having written **nothing**. The body carries `problems[]` (each naming the
  card and the reason) and `applicable` (how many would apply).
- Resending the same request with `confirm: true` applies the applicable part
  and still names the refused cards in `problems[]`.
- A clean selection applies immediately, with no extra round trip.
- Non-Commander formats never see a pre-flight refusal.

### As implemented — pairing

- **Same name → REFUSED**, at `commanderRules.writeDeckCard`, the choke point
  every `deck_cards` write passes through. This covers creation, the add/swap
  route, import and the bulk route alike, so a future route cannot forget it.
  **Not overridable** — the rule is fixed and the app cannot be wrong about it.
- **Illegal pairing → REFUSED**, code `COMMANDER_PAIR_ILLEGAL`, HTTP 409, by
  `commanderRules.checkCommanderZone`. It runs INSIDE the write transaction on
  every route that touches the `commander` board (deck create and the add/swap
  route), after the rows land — because "do these two cards pair" is a question
  about the command zone as a whole and cannot be answered one card at a time.
  A refusal throws, so the deck row and both commander rows roll back together
  and a refused create leaves nothing behind.
- **Not a legal commander → REFUSED**, code `COMMANDER_NOT_LEGAL`. A commander
  must be a legendary creature, a Background, or a card whose text says it can
  be your commander (`isLegalCommanderCard`).
- **Both refusals are OVERRIDABLE with an explicit, reasoned confirmation.**
  The refusal body carries `overridable: true` and the two cards. The client
  re-sends with `commander_override: { reason }`; an override with a missing or
  blank reason is rejected with `COMMANDER_OVERRIDE_REASON_REQUIRED`. There is
  no pre-ticked checkbox and no default path — absence of the field means
  refuse.
- **Accepted overrides are RECORDED** via the existing `auditLogger` into the
  existing `audit_logs` table, `action_type = 'COMMANDER_PAIR_OVERRIDE'`, in
  the SAME transaction as the write they permitted. `after_state` carries both
  card IDs *and* names, the reason verbatim, and the rule overridden;
  `created_at` supplies the timestamp. They are surfaced on the existing
  **Settings** screen (reusing `GET /api/audit-logs`) — no new store, no new
  screen.
- Pairing legality is detected from cached `keywords` / `oracle_text` --
  Partner, Partner with (which must name the actual partner), Friends Forever,
  Choose a Background + Background (both sides must match), Doctor's companion.
  Deliberately not a hardcoded card list, which would go stale every set — and
  the override is what makes a stale parse recoverable rather than fatal.
- **`buildDeckWarnings` no longer emits `COMMANDER_PAIR_ILLEGAL`.** An illegal
  pair can now only exist because the user explicitly overrode and justified
  it; warning about it afterwards would nag them about a decision the app
  already accepted. Deck CONTENTS legality (missing copies, colour identity
  among the 99, deck size) is untouched and still warning-only.

## "In Deck" semantics (still applies)

On a row, **In Deck is the total number of copies committed to decks**, counted
across all decks — not per-row and not a count of decks.

- Own 6 Breena, 1 copy in one deck → `Owned: 6 | In Deck: 1`
- Own 6 Breena, 1 copy in each of 4 decks → `Owned: 6 | In Deck: 4`
- Own 6 Breena, 2 in one deck and 1 in another → `Owned: 6 | In Deck: 3`

`Owned − In Deck` is the number free for a new deck.

## Data model note — do not change

One physical card = one row. `server.js:125` runs `splitStackedEntries()` at
startup, splitting any `quantity > 1` row into individual rows (see
`collectionHelpers.js:180`). This is deliberate: checkout allocates *specific*
physical copies. Any grouping is a **display** concern only — do not merge rows
in the database and do not touch `splitStackedEntries`.

## Style constraint

Preserve the existing production look and layout. Adapt existing UI in place.
Never replace an existing screen with a new component.
