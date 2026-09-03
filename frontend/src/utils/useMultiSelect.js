import { useRef, useState } from 'react';
import { useLongPress } from './useLongPress';

// Long-press-to-arm multi-select + bulk actions over collection entries. Shared
// by CollectionList and the scanner's recent-scans strip so both get the same
// UX and hit the same /api/collection/bulk endpoint. onChanged({ ids, action,
// value }) runs after a successful bulk action; the caller refreshes its own
// data (refetch, or prune a local list). Selection is cleared before onChanged,
// so the acted-on ids are passed along. Optional `guard()` returns a message
// string to block arming/bulk (e.g. a locked container) or a falsy value to
// allow it; the message is shown as a toast.
export function useMultiSelect({ showToast, onChanged, guard } = {}) {
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkMoveTarget, setBulkMoveTarget] = useState('');

  // Last plainly-clicked id: the far end of a shift-click range.
  const anchorId = useRef(null);

  const toggleSelect = (entryId) => {
    anchorId.current = entryId;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId); else next.add(entryId);
      return next;
    });
  };

  // Click-to-toggle with shift-click range, over `orderedIds` as currently
  // displayed — so a range is exactly what sits between the two cards on
  // screen, whatever sort or filter is active. Shift only ever extends, so
  // several shift-clicks build a selection out of separate blocks.
  const selectAt = (entryId, orderedIds, withShift) => {
    const anchor = anchorId.current;
    if (!withShift || anchor == null || anchor === entryId) {
      toggleSelect(entryId);
      return;
    }
    const from = orderedIds.indexOf(anchor);
    const to = orderedIds.indexOf(entryId);
    if (from === -1 || to === -1) { toggleSelect(entryId); return; }
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(orderedIds[i]);
      return next;
    });
  };

  const clearSelection = () => { anchorId.current = null; setSelectedIds(new Set()); };
  const exitSelectMode = () => { setSelectMode(false); clearSelection(); setBulkMoveTarget(''); };

  // Enter select mode and select `entryId`. Exposed so callers that own the
  // long-press elsewhere (CompartmentView) can arm the same state.
  const arm = (entryId) => {
    const blocked = guard && guard();
    if (blocked) { showToast(blocked); return; }
    setSelectMode(true);
    anchorId.current = entryId;
    setSelectedIds(prev => new Set(prev).add(entryId));
  };

  // Long-press arms select mode and selects the held card (shared gesture).
  const { handlers: pressHandlers, fired: longPressFired } = useLongPress(arm);

  // Runs one bulk action against every selected entry via the bulk endpoint.
  //
  // ADD-TO-DECK VALIDATES THE WHOLE SELECTION BEFORE IT WRITES ANYTHING.
  //
  // The server judges the entire selection first and answers 409 with a
  // BULK_ADD_PREFLIGHT report naming everything that will not apply, having
  // written nothing. We show that report and let the user decide, then resend
  // the identical request with confirm:true. This is the same "see it before
  // it happens" shape as the import compare screen.
  //
  // Deliberately reuses the existing toolbar and confirm dialog rather than
  // introducing a screen: the production look and layout are fixed, and this
  // is a new answer on an existing gesture, not a new gesture.
  const runBulk = async (action, value, confirmMsg, confirmed = false) => {
    const blocked = guard && guard();
    if (blocked) { showToast(blocked); return; }
    const ids = Array.from(selectedIds);
    if (ids.length === 0) { showToast('No cards selected.'); return; }
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: ids, action, value, confirm: confirmed })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showToast(data.message || 'Done.');
        clearSelection();
        // The delete response carries batch_id so the caller can offer an
        // undo. Passing the whole response through rather than a hand-picked
        // subset, so a future field does not need this line changed again.
        onChanged && onChanged({ ids, action, value, batchId: data.batch_id, data });
        return;
      }
      if (res.status === 409 && data.code === 'BULK_ADD_PREFLIGHT' && !confirmed) {
        // Nothing has been written yet. Name every problem -- capped, so a
        // large bad selection does not produce an unreadable wall -- and offer
        // to apply the rest.
        const problems = Array.isArray(data.problems) ? data.problems : [];
        const shown = problems.slice(0, 5).map(p => `• ${p.message}`).join('\n');
        const more = problems.length > 5 ? `\n…and ${problems.length - 5} more.` : '';
        const proceed = window.confirm(
          `${problems.length} of your selection cannot be added:\n\n${shown}${more}\n\n`
          + `Nothing has been added yet. Add the other ${data.applicable} card(s)?`
        );
        if (!proceed) { showToast('Nothing was added.'); return; }
        await runBulk(action, value, null, true);
        return;
      }
      showToast(data.error || 'Bulk action failed.');
    } catch (err) {
      console.error(err);
      showToast('Error performing bulk action.');
    }
  };

  return {
    selectMode, setSelectMode, selectedIds, setSelectedIds, toggleSelect, selectAt, clearSelection, exitSelectMode, arm,
    bulkMoveTarget, setBulkMoveTarget, pressHandlers, longPressFired, runBulk,
  };
}
