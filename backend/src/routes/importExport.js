const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateExportCSV } = require('../utils/csvExporters');
const { parseThirdPartyCSV } = require('../utils/csvMappers');
const { resolveRows } = require('../utils/importResolver');
const { displayPrinting } = require('../utils/finishes');

// A ManaBox dump of a large collection is a few thousand rows. This is a
// guard against a pasted wrong file, not a real ceiling.
const MAX_IMPORT_ROWS = 20000;

// Export endpoint
router.get('/export', async (req, res) => {
  const { format = 'csv', ecosystem = 'internal' } = req.query;
  const targetFormat = (ecosystem || format || 'internal').toLowerCase();

  try {
    const query = `
      SELECT 
        c.quantity,
        c.condition,
        c.printing,
        c.finish,
        c.purchase_price,
        c.added_at,
        cc.id as card_id,
        cc.name as name,
        cc.supertype,
        cc.types,
        cc.rarity,
        cc.set_id as set_code,
        cc.set_name,
        cc.number as collector_number,
        cc.image_url,
        cc.price_trend as market_price,
        l.name as location_name,
        cp.idx as compartment_idx,
        cp.label as compartment_label
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      WHERE c.user_id = ?
    `;
    const rows = await db.all(query, [req.user.id]);

    if (format.toLowerCase() === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=bindarr_collection_${targetFormat}.json`);
      return res.json(rows);
    }

    const csvContent = generateExportCSV(rows, targetFormat);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=bindarr_collection_${targetFormat}.csv`);
    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ error: 'Export failed', message: error.message });
  }
});

// IMPORT.
//
// This was a 501 stub: "disabled until the Oracle-aware importer can validate
// every row against an English Scryfall printing". That validation exists now
// -- the nightly Scryfall refresh keeps card_cache current, and card_cache.id
// IS the Scryfall UUID, so a ManaBox row carrying a Scryfall ID resolves by
// primary key.
//
// THE ADMISSION BOUNDARY STILL HOLDS: this adds COLLECTION rows pointing at
// cards already in the catalogue. It never INSERTs into card_cache. Uploaded
// metadata does not get to define what a Magic card is.
//
// Two phases, because Zach reviews before he commits:
//   POST /import?preview=1   resolve everything, write nothing, report
//   POST /import             resolve and insert, report the same summary

async function runImport(req, res, { commit }) {
  const { rows, format = 'manabox' } = req.body || {};

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows to import.' });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({
      error: `That file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}.`
    });
  }

  const mapped = parseThirdPartyCSV(rows, format);
  const { resolved, rejected } = await resolveRows(mapped);

  // DECISIONS FROM THE REVIEW SCREEN.
  //
  // { "218": { card_id: "...", quantity: 1 } } keyed by row index. Applied
  // AFTER resolution so they can only ever rescue a row that was rejected --
  // a resolution cannot redirect a row that already matched cleanly.
  //
  // The chosen card_id goes through the same catalogue check as every other
  // row. The admission boundary is not waived because a human pointed at
  // something: the client could post any id at all.
  const resolutions = (req.body && req.body.resolutions) || {};
  const rescued = [];
  const stillRejected = [];

  for (const r of rejected) {
    const choice = resolutions[String(r.index)];
    if (!choice || choice.skip) {
      stillRejected.push(r);
      continue;
    }

    const qty = Number(choice.quantity ?? r.quantity ?? 1);
    if (!Number.isInteger(qty) || qty < 1) {
      stillRejected.push(r);
      continue;
    }

    // A chosen printing still has to exist.
    const card = choice.card_id
      ? await db.get('SELECT id, name FROM card_cache WHERE id = ?', [choice.card_id])
      : null;

    if (choice.card_id && !card) {
      stillRejected.push({ ...r, reason: 'chosen_card_not_in_catalogue' });
      continue;
    }

    // No card_id means this was a quantity fix on a row whose card was never
    // in doubt -- keep whatever the resolver had already identified.
    const target = card || r.card;
    if (!target) {
      stillRejected.push(r);
      continue;
    }

    rescued.push({
      ok: true, index: r.index, label: target.name,
      card: target, matchedBy: 'chosen',
      row: { quantity: qty, condition: r.condition || 'Near Mint',
             finish: r.finish || 'nonfoil', purchase_price: 0 }
    });
  }

  const finalResolved = resolved.concat(rescued);

  const summary = {
    total: rows.length,
    matched: finalResolved.length,
    rejected: stillRejected.length,
    resolvedByHand: rescued.length,
    copies: finalResolved.reduce((n, r) => n + Number(r.row.quantity || 0), 0),
    matchedBy: finalResolved.reduce((acc, r) => {
      acc[r.matchedBy] = (acc[r.matchedBy] || 0) + 1;
      return acc;
    }, {}),
    // Every rejection, with enough detail to fix the source row. Zach: "Report
    // it as rejected" -- so the file imports what it can and names what it
    // could not, rather than refusing wholesale.
    rejections: stillRejected.map(r => ({
      row: r.index + 1,
      card: r.label,
      reason: r.reason,
      detail: r.detail || null,
      // The printings this row could be, when Bindarr knows them. The review
      // screen offers these inline instead of sending him back to ManaBox.
      candidates: r.candidates || null
    }))
  };

  if (!commit) {
    return res.json({ preview: true, ...summary });
  }

  // DUPLICATE ROWS ARE THE POINT. Zach: "If you re-import it adds duplicate
  // rows." A ManaBox export is a full dump, so re-importing genuinely means
  // "I have these again" -- silently merging into an existing entry would
  // discard the condition and price of the copies already recorded.
  let inserted = 0;
  try {
    await db.run('BEGIN');
    for (const r of finalResolved) {
      await db.run(
        `INSERT INTO collection
           (card_id, user_id, quantity, condition, printing, finish, purchase_price)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        // `printing` is the DISPLAY label ('Normal' / 'Foil'); `finish` is the
        // machine value ('nonfoil' / 'foil'). Passing finish to both would put
        // 'nonfoil' in a column every other screen renders as text. There is a
        // helper for this, used by admin.js -- reusing it rather than writing
        // a second mapping that can drift.
        [r.card.id, req.user.id, r.row.quantity, r.row.condition,
         displayPrinting(r.row.finish), r.row.finish, r.row.purchase_price || 0]
      );
      inserted += 1;
    }
    await db.run('COMMIT');
  } catch (err) {
    // ALL OR NOTHING on the write. A partial import leaves him unable to tell
    // which rows landed, and the only way to find out is counting cardboard.
    await db.run('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: 'Import failed; nothing was saved.', message: err.message });
  }

  res.json({ preview: false, inserted, ...summary });
}

router.post('/import/preview', (req, res) => runImport(req, res, { commit: false }));
router.post('/import', (req, res) => runImport(req, res, { commit: true }));

module.exports = router;
