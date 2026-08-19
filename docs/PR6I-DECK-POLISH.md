# PR 6I — Deck polish: stale counts, duplicate names, search, mobile

Found by Zach on the dev instance, 2026-08-19, running PR 6G (`2579da0`).
All four are minor; none are data-correctness bugs.

---

## 1. Browse Collection counts go stale after deleting a deck card

Deleting a card from a deck while the Browse Collection panel is open leaves
`In Deck` and the available count showing pre-deletion values. They only correct
on a reload.

The numbers are computed correctly server-side (PR 6G) — this is a client
refresh gap: the delete succeeds but the open panel is not re-fetched.

Fix by refreshing the panel's data after any mutation that can change
availability: delete, add, re-pin, board move, commander swap removals. Prefer
re-reading from the server over adjusting numbers locally — a locally-adjusted
count is a second implementation of the availability rule and will drift from
the real one.

## 2. Duplicate deck names are allowed

Two decks can be created with the same name. Deck creation must reject a name
already in use, saying so clearly.

- Applies to renaming an existing deck too, not just creation.
- Case- and whitespace-insensitive comparison ("Ur-Dragon" vs "ur-dragon ").
- Per-user, consistent with the rest of the app.

## 3. Commander search fails for some names

In the commander selection box (shown during a commander swap), the dropdown
search works for some cards but not others.

- Works: `Tony Stark`
- Fails: `The Ur-Dragon`

Likely causes, to investigate rather than assume:
- A leading article (`The `) being stripped, or matched literally against a
  name that starts with it
- The hyphen in `Ur-Dragon` — tokenisation or escaping in the search query
- Apostrophes and other punctuation may fail the same way; check
  `Urza's Saga`-style names while fixing

Note the commander search is filtered to legal commanders (PR 6G), so confirm
the filter is not what is dropping the result before looking at tokenisation.

Add cases for names with articles, hyphens, apostrophes, commas, and accents
(`Nazgûl` already exercises accents elsewhere).

## 4. Mobile layout, and Deck Health placement

On an iPhone 16, some boxes sit slightly off. Tighten the deck view's responsive
layout — adapt existing styles, do not restyle the desktop view.

Also: **move Deck Health & Rules toward the top of the deck view.** Zach: "it's
super important to know that data." Currently it sits below the card list, so
the thing that tells him whether the deck is legal and buildable is the last
thing he sees.

Keep the existing panel styling and content; this is placement and responsive
polish only.

---

## Style constraint

Preserve the existing production look and layout. Adapt existing UI in place.
Never replace an existing screen with a new component.
