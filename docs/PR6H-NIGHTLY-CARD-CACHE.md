# PR 6H — Nightly card catalogue cache

Zach, 2026-08-18: "I was thinking we would run overnight caches of all the
cards... have a nightly job that updates a cache."

## Why

Several problems in PRs 6C–6G trace back to one root cause: `card_cache` is
populated lazily, so the app regularly has to make a decision about a card it
has never read.

Symptoms this has produced:

- Deck search returning nothing for cards not owned (PR 6G item 4)
- Per-set index builds (`POST /api/prepare-set`) needed before search works,
  taking minutes and hitting rate limits
- Colour identity and commander legality unable to be judged from a thin row,
  requiring on-demand hydration with a hard failure when Scryfall is down
- Batch paths refusing unknown cards because they deliberately make no network
  call, forcing the user to add those cards individually

Each of those has been patched at the point it hurt. A complete local catalogue
removes the cause.

## What

A scheduled job that keeps a full local copy of the MTG card catalogue,
refreshed on a regular cadence (nightly is the stated intent).

Design questions to settle before implementing:

- **Source.** Scryfall publishes bulk data files (`default_cards`,
  `oracle_cards`, `unique_artwork`) intended exactly for this — a single
  download rather than tens of thousands of API calls. Which file matches what
  Bindarr needs? `default_cards` includes every printing, which exact-only
  identity requires.
- **Scope.** MTG-only, English-only, matching the existing rules. How large is
  that on disk, and does it fit the LXC comfortably alongside production?
- **Update strategy.** Full replace, or upsert by card id? A replace must not
  break foreign keys from `collection` and `deck_cards` into `card_cache`.
- **Scheduling.** systemd timer, in-process scheduler, or cron. The dev and
  production instances must not both hammer Scryfall.
- **Failure behaviour.** A failed refresh must leave the existing cache intact
  and say so, never leaving a half-written catalogue. Standing principle: error
  out and roll back rather than produce a partial result.
- **First run.** Populating from empty is the slow case; it should be
  observable rather than appearing to hang.
- **Interaction with prepare-set.** If the catalogue is complete, the per-set
  index build may become unnecessary or much cheaper. Check before removing
  anything.

## Consequences elsewhere

Once the catalogue is reliably complete, revisit:

- The hard-fail-on-unhydrated-colour-identity rule (PR 6G) — still correct, but
  should almost never fire.
- Batch paths refusing unknown cards — likely moot.
- Whether interactive Scryfall calls are needed at all outside price lookups.

Do not remove those guards as part of this PR. They are the correct behaviour
when the cache genuinely lacks a card; the point of the cache is that the
situation stops arising.

## Colour-identity "drift" — mostly a non-issue (Zach, 2026-08-19)

A PR 6G round-3 review finding suggested a nightly refresh could retroactively
change a card's colour identity beneath a legal deck, and asked for a drift
warning to ship with this PR.

Zach's correction, and it is right: **colour identity cannot change on a
printed card.** Once a card is printed its colours are fixed. A card printed
with different colours in another set is a *different printing* — a different
`desired_card_id` under exact-only identity — so it cannot overwrite the
original row's data.

The only real case is **Scryfall correcting its own data error**: the card was
always green, their record said otherwise, and a refresh fixes it. That is not
the card drifting, it is the app finally learning the truth, and it is rare.

So full drift detection is not warranted. What is worth doing, cheaply:

- If a refresh changes the `color_identity` of a card already used in a deck,
  log it and surface it once. Do not silently overwrite, and never auto-remove
  cards — the standing rule against silent state changes still applies, and a
  data correction is something the user should be able to see.
- Do NOT build ongoing drift monitoring, periodic re-validation of every deck,
  or a `buildDeckWarnings` code for a condition that should not occur.

Treat a changed colour identity on refresh as evidence the earlier data was
wrong, not that the card changed.

**Priority (Zach, 2026-08-19):** "errors can happen and I guess it's always a
possibility but you were right to mark it for later. That's an issue to address
if there is no other feature work or high priority bugs to fix."

So: lowest priority. Do not build it as part of PR 6H. The realistic case is a
Scryfall data correction affecting one card, once — nothing is lost, the card
is still in the binder, and the deck view will show the problem the next time
it is opened. Revisit only when there is no feature work and no high-priority
bug outstanding.
