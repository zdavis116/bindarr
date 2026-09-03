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
// Is this row a foil?
//
// CASE-INSENSITIVE, because every tool writes it differently: ManaBox uses
// lowercase 'foil', TCGplayer 'Foil', Deckbox 'true'. The previous version
// compared against a capitalised list, so ManaBox foils -- the only export
// Zach actually uses -- all imported as non-foil. A foil is routinely worth
// several times the regular printing, so that is a valuation error across a
// whole collection rather than a cosmetic flag.
//
// 'etched' is a real third finish and must not collapse into 'foil': etched
// and traditional foil are separately priced printings.
function finishFromFoilFlag(value) {
  if (value === true) return 'foil';
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'etched' || v === 'foil etched') return 'etched';
  return (v === 'foil' || v === 'holofoil' || v === 'true' || v === '1')
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
    quantity: parseQuantity(row['Quantity']),
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    finish: finishFromFoilFlag(row['Printing']),
    game: 'mtg'
  }),
  dragonshield: (row) => ({
    name: row['Card Name'] || row['Name'],
    set_code: row['Set Code'] || row['Set'],
    collector_number: row['Card Number'] || row['Number'],
    quantity: parseQuantity(row['Quantity']),
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    finish: finishFromFoilFlag(row['Printing']),
    game: 'mtg'
  }),
  manabox: (row) => ({
    // THE SCRYFALL ID IS THE MATCH. card_cache.id IS a Scryfall UUID, so this
    // column is a primary-key lookup -- exact, and immune to the variant
    // problem that makes set+number a guess. Promos, alternate arts and
    // Universes Beyond printings share collector numbers; picking the wrong
    // one writes the wrong card into a collection, which costs a recount
    // against cardboard. set+number stays as the fallback for exports that
    // predate the column.
    scryfall_id: (row['Scryfall ID'] || row['Scryfall Id'] || row['scryfall_id'] || '').trim() || null,
    name: row['Name'] || row['Card Name'],
    set_code: row['Set code'] || row['Set Code'] || row['Set'],
    collector_number: row['Card number'] || row['Number'] || row['Collector number'],
    quantity: parseQuantity(row['Quantity']),
    condition: CONDITION_MAP[(row['Condition'] || '').toLowerCase()] || 'Near Mint',
    finish: finishFromFoilFlag(row['Foil']),
    purchase_price: parsePrice(row['Purchase price'] || row['Purchase Price']),
    game: 'mtg'
  })
};

// Quantity, preserving the difference between "absent" and "zero".
//
// `parseInt(x, 10) || 1` is the obvious idiom and it is wrong here: 0 is
// falsy, so an explicit "Quantity: 0" became 1 -- a card written into a
// collection that its owner said they do not have. A missing column really
// does mean one; a stated zero means zero, and the resolver rejects it.
function parseQuantity(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 1;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isNaN(n) ? null : n;   // null: present but unreadable
}

// ManaBox writes a bare number, a blank, or occasionally a currency symbol.
// Anything unparseable becomes 0 rather than NaN -- a price is decoration
// here, and a NaN would propagate into collection value totals.
function parsePrice(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseThirdPartyCSV(rows, formatType = 'tcgplayer') {
  const formatKey = (formatType || 'internal').toLowerCase();
  const strategy = STRATEGIES[formatKey] || STRATEGIES.internal;
  return rows.map(strategy);
}

module.exports = {
  CONDITION_MAP,
  parsePrice,
  parseQuantity,
  STRATEGIES,
  parseThirdPartyCSV
};
