// Shared collection-entry options.
//
// PR 6E: these values are now the CANONICAL MTG finishes the backend stores
// ('nonfoil' | 'foil' | 'etched'), not the legacy pre-fork serialized forms.
// The API accepts both, but sending the canonical value means what the picker
// submits is exactly what deck identity matches on -- no translation step that
// can drift.
export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const PRINTINGS = ['nonfoil', 'foil', 'etched'];

const MTG_PRINTINGS = [
  { value: 'nonfoil', label: 'Nonfoil' },
  { value: 'foil', label: 'Foil' },
  { value: 'etched', label: 'Etched' },
];

export function getPrintings() {
  return MTG_PRINTINGS;
}

export const isBinderType = (type) => type === 'Binder' || type === 'Toploader Binder';
