#!/usr/bin/env node
// Does the parser produce the right rows from a REAL deck?
//
// Reading the code proves what it says; running it proves what it does. That
// distinction has caught six bugs on this project today.
const fs = require('fs');
const { summarise } = require('/opt/bindarr-dev/backend/src/utils/moxfieldPayload');
const sqlite3 = require('/opt/bindarr-dev/backend/node_modules/sqlite3');

const payload = JSON.parse(fs.readFileSync('/tmp/urdragon.json', 'utf8'));
const s = summarise(payload);

console.log(`deck        : ${s.name} (${s.format})`);
console.log(`updated     : ${s.last_updated_at}`);
console.log(`public id   : ${s.public_id}`);
console.log(`rows        : ${s.rows.length}   total cards: ${s.total_cards}`);
console.log(`skipped     : ${s.skipped.length}`);
s.skipped.slice(0, 5).forEach(x => console.log(`   ${x.name} -> ${x.reason}`));

const byBoard = {};
for (const r of s.rows) byBoard[r.board] = (byBoard[r.board] || 0) + r.quantity;
console.log('by board    :', JSON.stringify(byBoard));

const byFinish = {};
for (const r of s.rows) byFinish[r.finish] = (byFinish[r.finish] || 0) + 1;
console.log('by finish   :', JSON.stringify(byFinish));

// A commander deck is 100 cards: 1 commander + 99 mainboard. If the parser is
// right, that is what comes out -- an arithmetic check the payload cannot fake.
const deckSize = (byBoard.commander || 0) + (byBoard.mainboard || 0);
console.log(`\ncommander + mainboard = ${deckSize}  (a legal EDH deck is 100)`);

// Every row must resolve in the catalogue: the admission boundary.
const db = new sqlite3.Database('/var/lib/bindarr-dev/bindarr.db', sqlite3.OPEN_READONLY);
const ids = s.rows.map(r => r.scryfall_id);
db.all(`SELECT id FROM card_cache WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
  (err, found) => {
    if (err) { console.error('query failed: ' + err.message); process.exit(1); }
    const have = new Set(found.map(r => r.id));
    const missing = s.rows.filter(r => !have.has(r.scryfall_id));
    console.log(`in card_cache: ${have.size}/${ids.length}   missing: ${missing.length}`);
    missing.slice(0, 5).forEach(m => console.log(`   ${m.name}`));

    // Duplicate keys would break the UNIQUE constraint mid-sync.
    const keys = s.rows.map(r => `${r.scryfall_id}|${r.finish}|${r.board}`);
    console.log(`duplicate keys after merge: ${keys.length - new Set(keys).size} (must be 0)`);

    console.log('\nfirst five rows:');
    s.rows.slice(0, 5).forEach(r =>
      console.log(`   ${String(r.name).slice(0, 26).padEnd(26)} ` +
                  `${String(r.set_id).toUpperCase().padEnd(5)} #${String(r.number).padEnd(6)} ` +
                  `${r.board.padEnd(11)} x${r.quantity} ${r.finish}`));
    db.close();
  });
