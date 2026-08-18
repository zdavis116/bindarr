const REVERSE_CONDITION_MAP = {
  dragonshield: { 'Near Mint': 'NM', 'Lightly Played': 'LP', 'Moderately Played': 'MP', 'Heavily Played': 'HP', 'Damaged': 'POOR' },
  manabox: { 'Near Mint': 'near_mint', 'Lightly Played': 'lightly_played', 'Moderately Played': 'moderately_played', 'Heavily Played': 'heavily_played', 'Damaged': 'damaged' }
};

const { displayPrinting } = require('./finishes');

// Exporters read the CANONICAL `finish`, never the display mirror.
//
// These used to test `item.printing === 'Holofoil'`, a Pokemon value that MTG
// rows can no longer hold -- so after the finish correction every foil would
// have exported as 'Normal'. That is the worst kind of failure for this app: a
// clean-looking CSV that quietly misdescribes the user's binder, which they
// would only discover after importing it somewhere else.
const isFoil = (item) => {
  const finish = item.finish || (item.printing === 'Foil' || item.printing === 'Etched' ? 'foil' : 'nonfoil');
  return finish === 'foil' || finish === 'etched';
};

const EXPORT_STRATEGIES = {
  internal: (item) => ({
    'Card ID': item.card_id,
    'Name': item.name || item.card_name || '',
    'Set Name': item.set_name || '',
    'Set ID': item.set_id || item.set_code || '',
    'Card Number': item.collector_number || item.number || item.card_number || '',
    'Rarity': item.rarity || 'Common',
    'Quantity': item.quantity || 1,
    'Condition': item.condition || 'Near Mint',
    // The display form, derived from the canonical finish so a Bindarr export
    // re-imported into Bindarr round-trips etched as etched rather than
    // collapsing it to a generic foil.
    'Printing': displayPrinting(item.finish || 'nonfoil'),
    'Purchase Price': item.purchase_price || 0,
    'Market Price': item.price_trend || item.market_price || 0,
    'Location Container': item.location_name || 'Unassigned',
    'Compartment': item.compartment_label || (item.compartment_idx != null ? `#${item.compartment_idx}` : ''),
    'Added At': item.added_at || ''
  }),
  tcgplayer: (item) => ({
    'Card Name': item.name || item.card_name || '',
    'Set Code': item.set_code || item.set_id || '',
    'Number': item.collector_number || item.number || item.card_number || '',
    'Quantity': item.quantity || 1,
    'Condition': item.condition || 'Near Mint',
    'Printing': isFoil(item) ? 'Foil' : 'Normal'
  }),
  dragonshield: (item) => ({
    'Card Name': item.name || item.card_name || '',
    'Set Code': item.set_code || item.set_id || '',
    'Card Number': item.collector_number || item.number || item.card_number || '',
    'Quantity': item.quantity || 1,
    'Condition': (REVERSE_CONDITION_MAP.dragonshield && REVERSE_CONDITION_MAP.dragonshield[item.condition]) || 'NM',
    'Printing': isFoil(item) ? 'Foil' : 'Normal'
  }),
  manabox: (item) => ({
    'Name': item.name || item.card_name || '',
    'Set code': item.set_code || item.set_id || '',
    'Card number': item.collector_number || item.number || item.card_number || '',
    'Quantity': item.quantity || 1,
    'Condition': (REVERSE_CONDITION_MAP.manabox && REVERSE_CONDITION_MAP.manabox[item.condition]) || 'near_mint',
    'Foil': isFoil(item) ? 'true' : 'false'
  })
};

function generateExportCSV(collectionItems, formatType = 'internal') {
  const formatKey = (formatType || 'internal').toLowerCase();
  const strategy = EXPORT_STRATEGIES[formatKey] || EXPORT_STRATEGIES.internal;
  
  const mappedRows = collectionItems.map(strategy);
  if (mappedRows.length === 0) return '';

  const headers = Object.keys(mappedRows[0]);
  const csvRows = [headers.join(',')];

  for (const row of mappedRows) {
    const values = headers.map(header => {
      const val = row[header] !== undefined && row[header] !== null ? row[header] : '';
      return `"${String(val).replace(/"/g, '""')}"`;
    });
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

module.exports = {
  REVERSE_CONDITION_MAP,
  EXPORT_STRATEGIES,
  generateExportCSV
};
