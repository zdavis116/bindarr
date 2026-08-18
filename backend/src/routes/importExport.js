const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateExportCSV } = require('../utils/csvExporters');

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

// Import is intentionally disabled until the Oracle-aware importer can validate
// every row against an English Scryfall printing. Trusting uploaded metadata here
// would bypass the card-admission boundary and poison the shared cache.
router.post('/import', (_req, res) => {
  res.status(501).json({
    error: 'Collection import is temporarily disabled until Scryfall validation is available.'
  });
});

module.exports = router;
