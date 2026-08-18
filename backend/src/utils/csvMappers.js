const CONDITION_MAP = {
  'near mint': 'Near Mint', 'nm': 'Near Mint', 'near_mint': 'Near Mint',
  'lightly played': 'Lightly Played', 'lp': 'Lightly Played', 'lightly_played': 'Lightly Played',
  'moderately played': 'Moderately Played', 'mp': 'Moderately Played',
  'heavily played': 'Heavily Played', 'hp': 'Heavily Played',
  'damaged': 'Damaged', 'dmg': 'Damaged', 'poor': 'Damaged'
};

const { normalizeFinish } = require('./finishes');

// Every importer emits a CANONICAL finish ('nonfoil' | 'foil' | 'etched').
//
// These used to emit 'Holofoil' -- a Pokemon value that the corrected
// collection CHECK constraint now refuses, so a foil line in any third-party
// CSV would have failed the import outright. Emitting the canonical value also
// means an imported foil is immediately usable as deck identity, rather than
// being stored in a vocabulary nothing else in the app compares against.
//
// A source that says a card is foil is trusted; anything unrecognised is
// treated as nonfoil, which is the honest reading of "this exporter did not
// tell us it was foil".
function finishFromFoilFlag(value) {
  return (value === 'true' || value === '1' || value === true || value === 'Foil' || value === 'Holofoil')
    ? 'foil'
    : 'nonfoil';
}

const STRATEGIES = {
  internal: (row) => ({
    name: row['Name'] || row['card_name'] || row['Name'],
    set_code: row['Set ID'] || row['set_code'] || row['Set Code'],
    set_name: row['Set Name'] || row['set_name'],
    collector_number: row['Card Number'] || row['card_number'] || row['number'],
    card_id: row['Card ID'] || row['card_id'],
    quantity: parseInt(row['Quantity'] || row['quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    // Bindarr's own export writes the display form, which normalizeFinish
    // understands. An unreadable value falls back to nonfoil rather than
    // aborting a whole file over one cell.
    finish: (() => {
      try { return normalizeFinish(row['Printing']); } catch { return 'nonfoil'; }
    })(),
    language: row['Language'] || 'English',
    purchase_price: parseFloat(row['Purchase Price'] || row['purchase_price']) || 0,
    game: 'mtg'
  }),
  tcgplayer: (row) => ({
    name: row['Card Name'] || row['Name'],
    set_code: row['Set Code'] || row['Set'],
    collector_number: row['Number'] || row['Card Number'],
    quantity: parseInt(row['Quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    finish: finishFromFoilFlag(row['Printing']),
    game: 'mtg'
  }),
  dragonshield: (row) => ({
    name: row['Card Name'] || row['Name'],
    set_code: row['Set Code'] || row['Set'],
    collector_number: row['Card Number'] || row['Number'],
    quantity: parseInt(row['Quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    finish: finishFromFoilFlag(row['Printing']),
    game: 'mtg'
  }),
  manabox: (row) => ({
    name: row['Name'] || row['Card Name'],
    set_code: row['Set code'] || row['Set Code'] || row['Set'],
    collector_number: row['Card number'] || row['Number'],
    quantity: parseInt(row['Quantity'], 10) || 1,
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    finish: finishFromFoilFlag(row['Foil']),
    game: 'mtg'
  })
};

function parseThirdPartyCSV(rows, formatType = 'tcgplayer') {
  const formatKey = (formatType || 'internal').toLowerCase();
  const strategy = STRATEGIES[formatKey] || STRATEGIES.internal;
  return rows.map(strategy);
}

module.exports = {
  CONDITION_MAP,
  STRATEGIES,
  parseThirdPartyCSV
};
