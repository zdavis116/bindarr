// THE SORT STACK EDITOR: the one control the whole redesign turns on.
//
// Zach: "I like to order by set and color identity except I can organize by
// type like lands and even categorize lands by basic and non basic" -- and,
// asked whether the stack is per container or global: "I still want it per
// container because that is how I physically have it."
//
// So this edits ONE container's stack and saves it to that location. The order
// of the levels IS the order the cards sit in.
//
// Shared by desktop and phone. The layout differs (a popover beside the header
// vs a full-width sheet); the control does not, because a stack that behaves
// differently on the two screens is two models to keep in step.

import { GripVertical, X, Plus } from 'lucide-react';
import { SORT_FIELDS } from '../utils/storageGroups';
import { useT } from '../utils/i18n';

// The per-level options. These are the two exceptions Zach named by name, so
// they are checkboxes on the level rather than separate sort fields -- "split
// lands" is a property of sorting by Type, not a different way to sort.
const LEVEL_OPTIONS = {
  type: { key: 'splitLands', labelKey: 'sort.splitLands', defaultOn: true },
  color: { key: 'multiAsOne', labelKey: 'sort.multiAsOne', defaultOn: true },
};

export default function SortStackEditor({ stack, onChange, onApply, saving }) {
  const { t } = useT();
  const levels = Array.isArray(stack) ? stack : [];

  const setLevel = (i, patch) => {
    const next = levels.map((l, n) => (n === i ? { ...l, ...patch } : l));
    onChange(next);
  };

  const move = (from, to) => {
    if (to < 0 || to >= levels.length) return;
    const next = [...levels];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  // Fields already in the stack are not offered again: grouping by Set twice
  // produces a second level that can never split a group, which looks broken.
  const unused = SORT_FIELDS.filter((f) => !levels.some((l) => l.by === f.by));

  return (
    <div className="sortstack">
      <div className="sortstack-head">
        {/* The mockup's exact words. The generic sort.title/sort.hint keys belong
            to an older sort UI and say something different. */}
        <b>{t('sort.stackTitle')}</b>
        <span className="sortstack-hint">{t('sort.stackHint')}</span>
        <button
          type="button"
          className="btn btn-primary sortstack-apply"
          onClick={onApply}
          disabled={saving}
        >
          {saving ? t('common.saving') : t('sort.apply')}
        </button>
      </div>

      {levels.map((level, i) => {
        const opt = LEVEL_OPTIONS[level.by];
        const optOn = opt
          ? (level.opts?.[opt.key] ?? opt.defaultOn) !== false
          : false;
        return (
          // Index as key is normally a smell, but these rows ARE positional --
          // the level's meaning is its position in the stack, and reordering
          // must re-render them in the new order.
          // eslint-disable-next-line react/no-array-index-key
          <div className="sortstack-level" key={i}>
            {/* Buttons, not a drag handle. Drag-and-drop on a phone fights the
                scroll gesture, and a control that only works with a mouse is
                not the same control on both screens. */}
            <span className="sortstack-move">
              <button
                type="button" aria-label={t('sort.moveUp')}
                disabled={i === 0} onClick={() => move(i, i - 1)}
              >
                <GripVertical size={13} />
                <span aria-hidden="true">&uarr;</span>
              </button>
              <button
                type="button" aria-label={t('sort.moveDown')}
                disabled={i === levels.length - 1} onClick={() => move(i, i + 1)}
              >
                <span aria-hidden="true">&darr;</span>
              </button>
            </span>

            <span className="sortstack-n">{i + 1}</span>

            <select
              className="select-control sortstack-field"
              value={level.by}
              onChange={(e) => setLevel(i, { by: e.target.value, opts: {} })}
            >
              <option value={level.by}>
                {t(`sort.field.${level.by}`)}
              </option>
              {unused.map((f) => (
                <option key={f.by} value={f.by}>{t(`sort.field.${f.by}`)}</option>
              ))}
            </select>

            {/* NO direction dropdown. The mockup's level is
                grip | number | field | option | remove -- five things. A
                direction control is a sixth that the drawing does not have,
                and every field already has the order a player expects
                (WUBRG, shelf order, newest sets first). */}

            {opt && (
              <label className="sortstack-opt">
                <input
                  type="checkbox"
                  checked={optOn}
                  onChange={(e) => setLevel(i, {
                    opts: { ...(level.opts || {}), [opt.key]: e.target.checked },
                  })}
                />
                {t(opt.labelKey)}
              </label>
            )}

            {/* An empty stack is allowed -- it means "one pile, unsorted",
                which is a real way to keep a bulk box. */}
            <button
              type="button"
              className="sortstack-remove"
              aria-label={t('sort.removeLevel')}
              onClick={() => onChange(levels.filter((_, n) => n !== i))}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}

      {unused.length > 0 && (
        <button
          type="button"
          className="sortstack-add"
          onClick={() => onChange([...levels, {
            by: unused[0].by, dir: 'asc', opts: {},
          }])}
        >
          <Plus size={13} /> {t('sort.addLevel')}
        </button>
      )}

      {levels.length === 0 && (
        <p className="sortstack-empty">{t('sort.emptyStack')}</p>
      )}
    </div>
  );
}
