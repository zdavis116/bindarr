// Do any cards in his decks genuinely have NO rules text in the catalogue?
//
// Zach: "sometimes when I click on cards when in deck view the description
// just doesnt show up."
//
// I could not reproduce this as a timing bug in 60 clicks across two network
// profiles, so the next hypothesis is that it is not a race at all: some cards
// may simply have no oracle_text stored, and the pane renders nothing because
// there IS nothing. That would explain "sometimes" precisely -- it would be
// the same cards every time, which is a very different fix.
const sqlite3 = require('/opt/bindarr-dev/backend/node_modules/sqlite3');
const db = new sqlite3.Database('/var/lib/bindarr-dev/bindarr.db', sqlite3.OPEN_READONLY);
const q = (sql, p = []) => new Promise((res, rej) =>
  db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

(async () => {
  const t = (await q(`SELECT COUNT(*) AS n,
      SUM(CASE WHEN oracle_text IS NULL OR TRIM(oracle_text) = '' THEN 1 ELSE 0 END) AS blank
    FROM card_cache`))[0];
  console.log('card_cache rows:', t.n, '| blank oracle_text:', t.blank,
    `(${((t.blank / t.n) * 100).toFixed(1)}%)`);

  // A blank is EXPECTED for a vanilla creature or a basic land -- those cards
  // really have no rules text. The interesting case is a card that should have
  // some.
  const byType = await q(`SELECT
      CASE WHEN type_line LIKE '%Basic Land%' THEN 'basic land'
           WHEN type_line LIKE '%Land%'       THEN 'land'
           WHEN type_line LIKE '%Creature%'   THEN 'creature'
           ELSE 'other' END AS kind,
      COUNT(*) AS n
    FROM card_cache
    WHERE oracle_text IS NULL OR TRIM(oracle_text) = ''
    GROUP BY kind ORDER BY n DESC`);
  console.log('\nblank rules text by card kind:');
  for (const r of byType) console.log('  ', r.kind.padEnd(12), r.n);

  // The ones that actually matter: cards IN HIS DECKS with no rules text that
  // are not vanilla creatures or basic lands.
  const inDecks = await q(`SELECT DISTINCT cc.name, cc.type_line, cc.set_id
    FROM deck_cards dc
    JOIN card_cache cc ON cc.id = dc.desired_card_id
    WHERE (cc.oracle_text IS NULL OR TRIM(cc.oracle_text) = '')
      AND cc.type_line NOT LIKE '%Basic Land%'
    LIMIT 20`);
  console.log('\nCARDS IN HIS DECKS with no rules text (excluding basics):', inDecks.length);
  for (const r of inDecks) console.log('  ', r.name, '|', r.type_line, '|', r.set_id);

  // And how many deck cards are affected in total.
  const cnt = (await q(`SELECT COUNT(*) AS n FROM deck_cards dc
    JOIN card_cache cc ON cc.id = dc.desired_card_id
    WHERE (cc.oracle_text IS NULL OR TRIM(cc.oracle_text) = '')
      AND cc.type_line NOT LIKE '%Basic Land%'`))[0];
  console.log('\ntotal affected deck rows:', cnt.n);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
