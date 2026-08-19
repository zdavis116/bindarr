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
const db = require('../src/db');
const { refreshCatalogue } = require('../src/cardCatalogue');

async function main() {
  const force = process.argv.includes('--force');
  await db.initDb();
  const result = await refreshCatalogue({ force });
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
    console.error('Catalogue refresh failed:', error.message);
    // The failure path in refreshCatalogue() already reported that the existing
    // cache is intact; exit non-zero so a timer or operator sees the failure.
    try { await db.close(); } catch { /* already reporting a failure */ }
    process.exit(1);
  });
