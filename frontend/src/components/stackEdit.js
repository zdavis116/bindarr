// What saving a collection TILE has to do, as plain numbers.
//
// A tile reading "x6" is SIX collection rows of quantity 1 (one physical
// card = one row). The server's PUT /api/collection/:id knows nothing about
// tiles: there, `quantity: N` means "this row plus N-1 NEW copies".
//
// Two real bugs came from treating the tile as one row (Zach, Nov 2026):
//   - 6 -> 4: the client deleted 2 rows, then sent quantity 4, which INSERTED
//     3 more. Result 7.
//   - nonfoil -> foil on a stack of 6: only the key row changed, quantity 6
//     spawned 5 new foils, the other 5 nonfoils were untouched. "7 foil, 5
//     nonfoil" instead of 6 foil.
//
// keyId     -- the row the PUT with `quantity` goes to (memberIds[0])
// doomed    -- rows to delete (decrease)
// sendQty   -- the `quantity` for the key row: 1 + copies still to ADD
// survivors -- the OTHER kept rows; each gets the same field edit, no quantity
export function planStackEdit(memberIds, wanted) {
  const ids = Array.isArray(memberIds) && memberIds.length ? memberIds : [];
  const owned = ids.length || 1;
  if (!Number.isFinite(wanted) || wanted < 1) {
    return { doomed: [], sendQty: wanted, survivors: ids.slice(1) };
  }
  const keep = Math.min(wanted, owned);
  return {
    doomed: ids.slice(keep),
    sendQty: Math.max(1, wanted - owned + 1),
    survivors: ids.slice(1, keep),
  };
}
