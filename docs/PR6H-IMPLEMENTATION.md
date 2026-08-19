# PR 6H — Nightly card catalogue: decisions and how to run it

Implements the spec in `PR6H-NIGHTLY-CARD-CACHE.md`. This file records the
design decisions that spec asked to be settled, and why each went the way it
did. Code lives in `backend/src/cardCatalogue.js`.

## Source: `default_cards`, JSONL variant

`default_cards`, not `oracle_cards` or `unique_artwork`.

Deck identity in this app is exact-only: a card is its printing plus finish
(`utils/deckIdentity.js`), and both `collection.card_id` and
`deck_cards.desired_card_id` store a specific printing's Scryfall id.
`oracle_cards` holds one arbitrary printing per Oracle id, so most of the ids
the app actually stores would simply not be in it. `unique_artwork` has the
same gap for a different reason. `default_cards` is the only file containing
every printing.

The **JSONL** variant is used, so the file is read one card per line rather
than parsed as one enormous JSON array. Peak memory stays at roughly one
insert batch regardless of file size, which matters on a box shared with
production.

One download of the bulk file replaces what would otherwise be tens of
thousands of search-API calls.

## Scope and size — measured, not estimated

MTG-only and English-only, matching the existing rules in
`utils/languages.js`. Also excluded: tokens, emblems, art series, schemes,
planes, vanguards and memorabilia — none can go in a deck, and a non-English
printing shares a collector number with its English counterpart and would
collide in search.

A real import measured on this machine:

| | |
|---|---|
| Cards imported | 104,406 |
| Rows skipped by scope rules | 12,306 |
| Wall time (warm network) | ~15 s |
| **SQLite cost on disk (VACUUMed)** | **160.6 MB** |
| Compressed download | ~78 MB, transient |

160 MB is the number to plan around. The download is streamed to a temp file
and deleted afterwards, so it is not a lasting cost.

## Update strategy: upsert, not full replace

**Forced by the schema, not chosen.** `collection.card_id` and
`deck_cards.desired_card_id` are real foreign keys into `card_cache`, and
`db.js` turns `PRAGMA foreign_keys` ON. A truncate-and-reload would have to
delete rows those tables reference, and SQLite refuses that outright with
`SQLITE_CONSTRAINT: FOREIGN KEY constraint failed` — verified directly, not
assumed.

`INSERT OR REPLACE` is safe where a bulk `DELETE` is not: it keeps the same
primary key, so referencing rows stay valid.

Rows Scryfall no longer publishes are **deliberately left in place**. They are
what someone's collection or deck points at. Removing them would be a silent
state change against physical cards the user still owns.

## Scheduling: in-process, deduplicated by build timestamp

In-process (`server.js`), alongside the existing price, sets and backup timers.

- Works identically in dev, production and Docker, with no per-host unit files
  to keep in sync.
- Shares the app's database handle, so the refresh takes its turn on the same
  serialized queue as everything else. An external cron process opening the
  same SQLite file would contend for write locks with a live server.

**Dev and production do not both hammer Scryfall**, and this is handled by data
rather than by scheduling. Each run first fetches the few-kilobyte bulk *index*
and compares Scryfall's build timestamp against
`app_settings.card_catalogue_updated_at`. If they match, the large download is
skipped entirely. Two instances therefore cost one download between them, and
the job is safe to re-run by hand as often as you like.

Set `CARD_CATALOGUE_REFRESH=off` to disable it on a host that should never pull
the file.

## Failure: nothing is written until everything is read

Rows are staged in a scratch table (`card_cache_staging`) with no foreign keys.
`card_cache` is not touched until the entire download has been read and staged
successfully; the copy across happens in a single transaction.

So a network drop, a truncated transfer, a malformed row, or an empty file all
leave the previous catalogue **byte-identical**, and the failure is logged
explicitly saying so. There is no half-written state to recover from — which
matters because partial rows are exactly what would bring the thin-data rulings
back to life.

A failed refresh also does **not** record its build timestamp, so the next run
retries rather than skipping.

## First run is observable

Progress is logged every 10,000 staged cards, with a line up front warning that
a first run takes a while. Populating from empty looks like work, not a hang.

## prepare-set: checked, and left alone

`POST /api/prepare-set` is **not** made redundant by this and was not changed.

It looks like a card-data path but is not: `setIndex.buildSet()` downloads card
*images* and computes ORB features and dhashes for the scanner. Caching card
rows is a side effect it does along the way. The catalogue removes that side
effect's necessity but none of the image work, which is the actual cost. It
remains load-bearing for scanning.

## Guards left in place

The hard-fail-on-unhydrated-colour-identity rule, the batch paths that refuse
unknown cards, and the could-not-verify errors are all untouched. They are
correct when the cache genuinely lacks a card. The point of the catalogue is
that the situation stops arising, not that the guards become wrong.

## Colour identity

Per the spec: no drift detection, no deck re-validation, no warning code, no
auto-removal. If a refresh changes the `color_identity` of a card already used
in a deck, it is logged once — with the card's name and the fact that nothing
was removed — and that is all. This is treated as Scryfall correcting its own
data error, not as the card changing.

## Running a refresh manually

```
cd backend
node scripts/refresh-card-catalogue.js           # skips if already current
node scripts/refresh-card-catalogue.js --force   # re-import the same build
```

Safe to run while the app is serving: writes go through the same serialized
database queue the server uses, and `card_cache` is only touched at the end.
Exits non-zero on failure.

`--force` is what you want after manually editing or truncating `card_cache`.

## Tests

`backend/test/card-catalogue.test.js`, wired into `npm test`. Behaviour tests
through the real refresh path against a real database; only the network is
stubbed, so nothing downloads hundreds of megabytes or reaches Scryfall.

Covered: a successful refresh populates the cache; running twice is idempotent;
an unchanged build skips the download; foreign keys from `collection` and
`deck_cards` survive a refresh; a refresh failing partway leaves the previous
cache byte-identical and says so; a network error and an empty file are equally
safe; a colour-identity correction on a deck card is logged and the card is left
in place; the refresh is safe to run while the app serves requests; scope stays
MTG-only and English-only.

The intactness test was checked against a deliberately broken implementation
that wrote rows as it read them, and it fails there — so it is testing the
property, not passing vacuously.
