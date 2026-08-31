// THE EXPORT DIALOG, SHARED BY THE DECK VIEW AND THE DECK LIST.
//
// Zach: "for the deck list when selecting multiple decks for the buylist can we
// have the functionality be the same as for the missing in the deck view."
//
// They had drifted: the deck view offered three formats and showed the text
// before copying; the deck list silently put one fixed format on the clipboard,
// so you could not see what you were about to paste. One component now, because
// two copies of an export dialog is exactly how that drift happened.
import { useState, useMemo } from 'react';
import { X, Download } from 'lucide-react';
import { buildDeckExport } from '../utils/deckText';
import { useT } from '../utils/i18n';
import { Z_BACKDROP, Z_MODAL } from '../utils/zLayers';

// Named for where the text gets pasted, not for the internal format id.
// buildDeckExport really supports three shapes; offering five names for three
// behaviours would hand the user the wrong format silently.
export const EXPORT_FORMATS = [
  { id: 'brackets', label: 'Moxfield', format: 'buylist', bracketStyle: 'brackets' },
  { id: 'parens', label: 'Manapool', format: 'buylist', bracketStyle: 'parentheses' },
  { id: 'plain', label: 'Names only', format: 'plain', bracketStyle: 'brackets' },
];

function ExportModal({ open, onClose, cards, title, showToast }) {
  const { t } = useT();
  const [formatId, setFormatId] = useState(EXPORT_FORMATS[0].id);

  const text = useMemo(() => {
    const chosen = EXPORT_FORMATS.find(f => f.id === formatId) || EXPORT_FORMATS[0];
    return buildDeckExport(cards, chosen.format, { bracketStyle: chosen.bracketStyle });
  }, [cards, formatId]);

  if (!open) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('deck.buylistCopied'), 'success');
      onClose();
    } catch {
      // Clipboard access can be refused; the text is on screen either way, so
      // this is recoverable by selecting it manually.
      showToast(t('deck.buylistCopyFailed'), 'error');
    }
  };

  const count = cards.reduce((n, c) => n + (c.quantity_missing || c.quantity || 0), 0);

  return (
    <>
      <div onClick={onClose}
           style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: Z_BACKDROP }} />
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: Z_MODAL,
                    background: 'var(--surface-1)', borderTopLeftRadius: 20, borderTopRightRadius: 20,
                    maxHeight: '82vh', display: 'flex', flexDirection: 'column',
                    paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--surface-3)', margin: '10px auto 4px' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '0.4rem 1rem 0.7rem' }}>
          <b style={{ fontSize: '1rem' }}>{title}</b>
          <button onClick={onClose} aria-label={t('common.close')}
                  style={{ width: 34, height: 34, borderRadius: 'var(--radius-sm)', border: 0,
                           background: 'var(--surface-3)', color: 'var(--text-primary)',
                           display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
            <X size={16} />
          </button>
        </div>

        {/* Format chips. */}
        <div style={{ display: 'flex', gap: '0.4rem', padding: '0 1rem 0.7rem', flexWrap: 'wrap' }}>
          {EXPORT_FORMATS.map(f => {
            const on = f.id === formatId;
            return (
              <button key={f.id} onClick={() => setFormatId(f.id)}
                style={{ minHeight: 36, padding: '0 0.85rem', borderRadius: 20,
                         border: `1px solid ${on ? 'var(--accent-blue)' : 'var(--border-glass)'}`,
                         background: on ? 'rgba(10,132,255,.14)' : 'transparent',
                         color: on ? 'var(--accent-blue)' : 'var(--text-secondary)',
                         font: 'inherit', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
                {f.label}
              </button>
            );
          })}
        </div>

        {/* THE TEXT IS VISIBLE BEFORE IT IS COPIED. Zach reviewed this in the
            mockup; it is also what the deck list was missing. */}
        <pre style={{ flex: 1, overflow: 'auto', margin: 0, padding: '0.8rem 1rem',
                      background: 'var(--surface-2)', fontSize: '0.78rem', lineHeight: 1.55,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      color: 'var(--text-secondary)' }}>
          {text || t('deck.nothingToExport')}
        </pre>

        <div style={{ padding: '0.8rem 1rem 1rem' }}>
          <button onClick={copy} disabled={!text}
            style={{ width: '100%', minHeight: 48, borderRadius: 'var(--radius-md)', border: 0,
                     background: text ? 'var(--accent-blue)' : 'var(--surface-3)',
                     color: text ? '#fff' : 'var(--text-muted)',
                     font: 'inherit', fontSize: '0.95rem', fontWeight: 600,
                     display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.45rem',
                     cursor: text ? 'pointer' : 'default' }}>
            <Download size={16} />
            {t('deck.copyCards', { count })}
          </button>
        </div>
      </div>
    </>
  );
}

export default ExportModal;
