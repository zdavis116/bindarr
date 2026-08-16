// Shared collection-entry options. Finish values deliberately remain the legacy
// serialized values accepted by the backend; only their MTG labels are exposed.
export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const PRINTINGS = ['Normal', 'Holofoil'];

const MTG_PRINTINGS = [
  { value: 'Normal', label: 'Nonfoil' },
  { value: 'Holofoil', label: 'Foil' },
];

export function getPrintings() {
  return MTG_PRINTINGS;
}

export const isBinderType = (type) => type === 'Binder' || type === 'Toploader Binder';
