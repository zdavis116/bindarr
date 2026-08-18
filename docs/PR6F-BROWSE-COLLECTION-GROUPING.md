# PR 6F — Deck picker grouping + Commander selection

Two issues found by Zach on the dev instance, 2026-08-18.

---

# Part 1 — Browse Collection must group by exact identity

## The bug

In the deck view's **Browse Collection** picker, the same card appears as
multiple separate rows:

```
The Prismatic Piper (Commander Masters · #1)   Owned: 2 | In Deck: 1
Breena, the Demagogue (Commander 2021 · #1)    Owned: 4 | In Deck: 1
The Prismatic Piper (Commander Masters · #1)   Owned: 3 | In Deck: 1
Breena, the Demagogue (Commander 2021 · #1)    Owned: 2 | In Deck: 1
```

Two rows for Prismatic Piper, two for Breena — identical set, identical
collector number, no visible difference between them. Nothing on screen lets
you tell the rows apart or choose between them.

The **Collection screen** shows the same cards correctly grouped: `x8`
Prismatic Piper, `x6` Breena. Two screens, same data, different answers.

## Expected behaviour

Group by **exact identity — printing + finish**, the same rule PR 6C
established for deck entries. Breena should be one row reading
`Owned: 6 | In Deck: 1`.

Rows split **only** when identity genuinely differs:

- different finish (2 foil vs 4 nonfoil)
- different printing (same name, different set or collector number)

If two rows cannot be told apart on screen, they must not be two rows.

## "In Deck" semantics

On a grouped row, **In Deck is the total number of copies committed to decks**,
counted across all decks — not per-row, and not a count of decks.

- Own 6 Breena, 1 copy in one deck → `Owned: 6 | In Deck: 1`
- Own 6 Breena, 1 copy in each of 4 decks → `Owned: 6 | In Deck: 4`
- Own 6 Breena, 2 in one deck and 1 in another → `Owned: 6 | In Deck: 3`

The row answers "how many of these are spoken for", so `Owned − In Deck` is the
number free for a new deck. The current bug shows `In Deck: 1` on every
duplicate row, which double-counts and hides where copies went.

## Root cause (to confirm)

Browse Collection is likely rendering raw `collection` rows rather than
grouping by `(card_id, finish)`. Multiple physical rows for one printing arise
legitimately — adds at different times, conditions, or storage locations — and
the Collection screen already folds them. The deck picker does not.

Worth checking while fixing:

- Does grouping need to preserve per-row data the picker relies on (condition,
  location, purchase price)? Group for display but keep rows addressable.
- Does the same ungrouped-rows problem appear anywhere else listing collection
  entries?
- Ensure In Deck is computed against grouped identity, not summed per row.

---

# Part 2 — Choosing a commander

## The gap

The deck view warns that a Commander deck has no commander, but there is **no
way to actually set one**. No control to nominate a creature as commander, and
none to swap it later.

## Expected behaviour — Commander format only

Every part of this applies **only when the deck's format is Commander**. Other
formats must be completely unaffected — no extra field, no extra validation, no
visual change.

**At deck creation (Create New Deck modal):**

- Choosing format **Commander** reveals an additional input for the commander.
- The commander is **required** to create the deck — it is a Commander deck, so
  it does not make sense to create one without naming its commander.
- The field must not appear for any other format.

**Inside the deck:**

- The commander can be changed/swapped from the deck view.

## Notes for implementation

- Commander selection must respect exact-only identity: choosing a commander
  means choosing an exact printing + finish, like any other deck entry.
- The commander occupies the existing **Commander** section in the deck card
  list (added in PR 6D) — do not build a separate screen for it.
- Existing Commander validation stays warning-only per the settled rules; this
  change is about providing the missing control, not about hardening rules
  enforcement.
- Use existing UI patterns in the Create New Deck modal and deck view. Adapt in
  place; do not introduce a new screen or restyle the modal.

## Two commanders — supported from the start (Zach, 2026-08-18)

Partner commanders and Background pairs are common enough that this is not
deferred. A Commander deck may have **one or two** commanders.

- The create modal must allow naming a second commander, not just one.
- A deck with a partner-only commander (e.g. The Prismatic Piper, which is
  never a legal solo commander) must be creatable — so a one-slot field would
  be wrong on day one.
- Both commanders occupy the existing Commander section in the deck card list.
- Both are exact-identity entries (printing + finish) like any other card.
- Commander legality stays warning-only, consistent with the settled rules.
  Do not hard-block on partner/Background legality — warn.

## Open question for Zach

Partner commanders / Background pairs allow two commanders. The seeded dev data
includes The Prismatic Piper, which is a partner-only commander. Worth deciding
whether the field supports a second commander now or in a later PR.
