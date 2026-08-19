#!/usr/bin/env node
// Manually refresh the local MTG card catalogue.
//
//   node scripts/refresh-card-catalogue.js
//   node scripts/refresh-card-catalogue.js --force
//
// Without --force this skips the download when Scryfall has not rebuilt the
// bulk file since the last successful import, so it is cheap to re-run.
// --force re-imports the same build anyway, which is what you want after
// manually editing or truncating card_cache.
//
// Safe to run while the app is serving: writes go through the same serialized
// database queue the server uses, and card_cache is only touched once the whole
// download has been read successfully.
//
// It is NOT safe to run two refreshes at once, which is what PR 6I item 8 adds
// a guard for. This script and the server's nightly job are separate PROCESSES,
// so the guard is a row in app_settings rather than a variable — see
// cardCatalogue.js acquireLock(). If the server is already importing, this exits
// non-zero and says so, rather than colliding and producing the SQLITE_BUSY
// Zach hit on 2026-08-19.
const db = require('../src/db');
const { refreshCatalogue, RefreshInProgressError } = require('../src/cardCatalogue');

async function main() {
  const force = process.argv.includes('--force');
  await db.initDb();
  // Labelled so the lock row names a human-recognisable holder. When the server
  // later refuses to start a refresh, its message can say "started by
  // manual-script pid N" instead of something an operator has to go and decode.
  const result = await refreshCatalogue({ force, lockLabel: 'manual-script' });
  if (result.skipped) {
    console.log('Nothing to do: local catalogue already matches the published build.');
  } else {
    console.log(`Imported ${result.imported} cards; ${result.cached} now cached.`);
  }
}

main()
  .then(async () => {
    await db.close();
    process.exit(0);
  })
  .catch(async (error) => {
    // A refresh already running is NOT a failure of this script, and calling it
    // one would send an operator looking for a bug that is not there. It gets
    // its own message naming the holder, so the next action is obvious: wait,
    // or go and look at that process.
    if (error instanceof RefreshInProgressError || error.code === 'CATALOGUE_REFRESH_IN_PROGRESS') {
      console.error(`Not starting: ${error.message}`);
      console.error('Nothing was downloaded and nothing was written. Wait for that run to finish, then re-run this.');
    } else {
      console.error('Catalogue refresh failed:', error.message);
      // refreshCatalogue() has already reported the VERIFIED resulting state.
      // This must not restate it: the old version asserted here that the cache
      // was intact, which is precisely the false claim PR 6I item 7 removes.
      // Echo what was actually established instead of asserting anything new.
      if (error.catalogueState === 'committed') {
        console.error(
          `IMPORTANT: the catalogue WAS replaced (${error.catalogueCached} cards cached). ` +
          'Do not treat this as a no-op; re-run to complete the bookkeeping.'
        );
      } else if (error.catalogueState === 'unverified') {
        console.error('The resulting catalogue state could not be verified — inspect it before relying on it.');
      }
    }
    try { await db.close(); } catch { /* already reporting a failure */ }
    process.exit(1);
  });
