// WHEN EACH BACKGROUND SYNC RUNS NEXT.
//
// Zach: "one small update I would like in settings is for each sync to show
// when the next sync to run like a countdown. Because you say scryfall syncs at
// 0400 but I see on the site 0300 hundred is that local time zone adjusted."
//
// He found a real inconsistency. There were THREE different answers:
//
//   * the scheduler ran at "04:00 local", but both hosts are Etc/UTC, so that
//     was 04:00 UTC -- MIDNIGHT for him in EDT, not 4am
//   * Settings displayed "Nightly at 03:00", a hardcoded locale string that
//     matched neither
//   * the startup log said 04:00 UTC
//
// A schedule written down in the UI is a second source of truth, and it had
// already drifted. So the schedulers publish their real next-run time HERE, the
// settings route reads it, and the UI formats it in the reader's own timezone.
// Nothing displays a time that was typed by hand.
//
// Values are ISO 8601 UTC strings, or null when a scheduler is disabled
// (CARD_CATALOGUE_REFRESH=off, MOXFIELD_POLL=off) -- null means "not scheduled",
// which the UI must show as such rather than as a countdown to nothing.

let catalogueNextRun = null;
let moxfieldNextRun = null;
let manaPoolNextRun = null;

function setCatalogueNextRun(iso) { catalogueNextRun = iso || null; }
function setMoxfieldNextRun(iso) { moxfieldNextRun = iso || null; }
function setManaPoolNextRun(iso) { manaPoolNextRun = iso || null; }
let cardKingdomNextRun = null;
function setCardKingdomNextRun(iso) { cardKingdomNextRun = iso || null; }

function getSchedule() {
  return {
    catalogue_next_run: catalogueNextRun,
    moxfield_next_run: moxfieldNextRun,
    manapool_next_run: manaPoolNextRun,
    cardkingdom_next_run: cardKingdomNextRun,
    // The server's own clock, so the client can correct for a device clock that
    // is off. Without it a phone running two minutes fast shows a countdown two
    // minutes short, and "why did it not sync?" becomes unanswerable.
    server_now: new Date().toISOString(),
  };
}

module.exports = { setCatalogueNextRun, setMoxfieldNextRun, setManaPoolNextRun,
                   setCardKingdomNextRun, getSchedule };
