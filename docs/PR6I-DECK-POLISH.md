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

## 3. ~~Commander search fails for some names~~ — FIXED by PR 6H

`The Ur-Dragon` now resolves correctly. The failure was the incomplete per-set
card index, not name tokenisation — the complete catalogue (PR 6H) removed the
cause. No work needed.

Confirmed by Zach on the dev instance, 2026-08-19.

## 3b. Owned cards must sort to the top of any all-cards search

Zach, 2026-08-19: "with any search that includes all cards. It should bubble up
the cards I own to the top. I searched Kodama and there are a lot of different
cards with that name and the one I own was toward the bottom so I had to scroll
a bit to find it."

Now that search covers ~104k cards, catalogue results swamp the handful he
actually owns. Ranking must put owned printings first.

Applies to **every** search that returns catalogue results, not just one screen:
deck card search, commander search, Browse Collection where it spans the
catalogue, and anywhere else added later.

Suggested ordering, confirm while implementing:
1. Printings he owns with copies **available**
2. Printings he owns but fully committed to other decks
3. Everything else

Within each band keep whatever ordering exists today. The available count is
already shown per result (PR 6G), so this is ordering only — no new UI.

Note ownership is per exact printing + finish, so "owned" means that specific
printing, not any printing of the card name. A search for Kodama should surface
*his* Kodama printing, not merely any Kodama.

## 4. Mobile layout — content overflows the viewport

Zach, 2026-08-19, iPhone 16 screenshot. Multiple elements run off the right
edge of the screen:

- **Browse Collection** button is clipped at the right edge of the search row
- The **Grid** toggle in the Deck Cards header is cut off
- **Settings** in the bottom nav is truncated ("Setting…")
- Card rows in Add Cards extend past the right edge — the `+`, eye and
  lightbulb buttons sit at or beyond the boundary
- The commander row under Commander (1) is cut off mid-content

The page is wider than the viewport, so the whole layout scrolls horizontally
rather than fitting. Fix the deck view's responsive behaviour so content fits
the width on a phone: wrap the search row rather than letting it overflow,
allow the deck-card rows to reflow, and make the bottom nav fit or scroll
deliberately.

Adapt existing styles — do NOT restyle the desktop view, which is correct.

## 4b. Browse Collection cannot be closed

Once the Browse Collection panel is open there is no way to close it. The
button opens the panel but does not toggle it shut, and there is no dismiss
control.

Make it a toggle, and/or give the panel an explicit close affordance consistent
with how other panels in the app are dismissed. On a phone this matters more
than on desktop — the open panel takes most of the screen.

## 4c. Deck Health & Rules should sit near the top

Zach: "moving deck health and rules toward the top would be nice as well since
it's super important to know that data."

It currently sits below the card list, so the panel that says whether the deck
is legal and buildable is the last thing seen — and on a phone it is a long
scroll away.

Move it above the card list. Keep the existing panel styling and content; this
is placement only.

---

## 5. Catalogue refresh reported FAILURE when it had SUCCEEDED

Zach, 2026-08-19, running the PR 6H refresh on the dev instance. It printed:

> refresh FAILED (SQLITE_BUSY: database is locked). The existing cache of 174
> cards is unchanged — no partial catalogue was written.

The database then contained **104,406 complete rows** — zero NULL
`color_identity`, zero NULL/empty `type_line`, zero orphaned `collection` or
`deck_cards` rows. The import had SUCCEEDED. The error handler reported a
rollback that had not happened.

**This is the one real bug in this PR**, and it is the exact class this project
blocks merges over: the app saying something false about its own state.

The cause was not the SQLITE_BUSY. It was the handler's reasoning. It assumed
"we are on the error path, therefore nothing committed" — a claim wider than
the code supported, because the failure occurred in the bookkeeping `UPDATE`
that runs *after* the catalogue swap has already committed.

The fix is to report ACTUAL state rather than inferred state:

- track whether the swap committed, flipped only once `applyStaged()` returns
- RE-READ the row count from the database before saying anything about it
- never state a rollback occurred without verifying it
- when the state cannot be verified at all, say that, rather than falling back
  to a confident claim

## 6. Guard against concurrent catalogue refreshes

The SQLITE_BUSY came from the app serving requests while the import ran. The
PR 6H reviewer flagged the missing guard as deferred; it has now bitten.

- An in-flight guard so two refreshes cannot overlap.
- The manual script must DETECT a server-side refresh in progress and say so,
  rather than colliding with it.

Note the guard cannot be an in-memory flag: the nightly job and
`scripts/refresh-card-catalogue.js` are separate PROCESSES. It is a row in
`app_settings`, claimed inside a `BEGIN IMMEDIATE` transaction, with a heartbeat
so a killed process cannot hold the lock forever.

---

## Style constraint

Preserve the existing production look and layout. Adapt existing UI in place.
Never replace an existing screen with a new component.
