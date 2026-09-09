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
import { X, Download, Receipt } from 'lucide-react';
import { buildDeckExport } from '../utils/deckText';
import { useT } from '../utils/i18n';
import { Z_BACKDROP, Z_MODAL } from '../utils/zLayers';

// Named for where the text gets pasted, not for the internal format id.
// buildDeckExport really supports three shapes; offering five names for three
// behaviours would hand the user the wrong format silently.
// Not exported: nothing outside this file imports it, and a non-component
// export here breaks Fast Refresh for the whole module. If another screen ever
// needs these, they belong in their own file rather than hanging off a modal.
const EXPORT_FORMATS = [
  { id: 'brackets', label: 'Moxfield', format: 'buylist', bracketStyle: 'brackets' },
  { id: 'parens', label: 'Manapool', format: 'buylist', bracketStyle: 'parentheses' },
  { id: 'plain', label: 'Names only', format: 'plain', bracketStyle: 'brackets' },
];

function ExportModal({ open, onClose, cards, title, showToast, deckId }) {
  const { t } = useT();
  const [formatId, setFormatId] = useState(EXPORT_FORMATS[0].id);

  // WHAT THIS LIST WOULD ACTUALLY COST, DELIVERED.
  //
  // Zach: "being able to send buy list to mana pool". Kept out of the per-card
  // prices deliberately: delivered cost is a property of an ORDER. His measured
  // four-card cart is $130.95 across 4 sellers on lowest_price and $150.32 from
  // one seller on fewest_packages -- two correct answers $19.37 apart.
  //
  // Never fetched speculatively: a quote costs a rate-limited API call (Mana
  // Pool allows ~3/minute) and is a snapshot of live inventory, not a fact.
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState(null);
  const [model, setModel] = useState('lowest_price');

  const priceIt = async () => {
    if (!deckId || quoting) return;
    setQuoting(true);
    setQuoteError(null);
    try {
      const res = await fetch(`/api/decks/${deckId}/buylist/price`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setQuote(null);
        // EVERY FAILURE IS NAMED. A 409 means Mana Pool could not source
        // specific cards -- he needs to SEE which, not have them quietly
        // dropped from an order he then pays for.
        setQuoteError(data.code === 'MANAPOOL_NO_STOCK'
          ? { kind: 'stock', unavailable: data.unavailable || [] }
          : { kind: 'error', message: data.error || `Request failed (${res.status})` });
        return;
      }
      setQuote(data);
    } catch (e) {
      setQuote(null);
      setQuoteError({ kind: 'error', message: e.message });
    } finally {
      setQuoting(false);
    }
  };

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

        {/* PRICE IT ON MANA POOL. Only when there is a deck to price and
            something to buy. */}
        {deckId && text && (
          <div style={{ padding: '0.7rem 1rem 0', borderTop: '1px solid var(--border-glass)' }}>
            <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center' }}>
              <select
                value={model}
                onChange={(e) => { setModel(e.target.value); setQuote(null); setQuoteError(null); }}
                style={{ flex: 1, minHeight: 38, borderRadius: 'var(--radius-sm)',
                         border: '1px solid var(--border-glass)', background: 'var(--surface-2)',
                         color: 'var(--text-primary)', font: 'inherit', fontSize: '0.8rem',
                         padding: '0 0.5rem' }}>
                <option value="lowest_price">{t('deck.mpLowestPrice')}</option>
                <option value="fewest_packages">{t('deck.mpFewestPackages')}</option>
                <option value="balanced">{t('deck.mpBalanced')}</option>
              </select>
              <button onClick={priceIt} disabled={quoting}
                style={{ minHeight: 38, padding: '0 0.9rem', borderRadius: 'var(--radius-sm)',
                         border: 0, background: 'var(--surface-3)',
                         color: 'var(--text-primary)', font: 'inherit',
                         fontSize: '0.82rem', fontWeight: 600,
                         display: 'flex', alignItems: 'center', gap: '0.35rem',
                         cursor: quoting ? 'default' : 'pointer' }}>
                <Receipt size={14} />
                {quoting ? t('deck.mpPricing') : t('deck.mpPriceIt')}
              </button>
            </div>

            {quote && (
              <div style={{ marginTop: '0.6rem', fontSize: '0.8rem' }}>
                {[[t('deck.mpItems'), quote.items],
                  [t('deck.mpShipping'), quote.shipping],
                  [t('deck.mpFee'), quote.buyerFee]].map(([label, v]) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.12rem 0' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                    <span>${Number(v || 0).toFixed(2)}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between',
                              paddingTop: '0.35rem', marginTop: '0.3rem',
                              borderTop: '1px solid var(--border-glass)', fontWeight: 700 }}>
                  <span>{t('deck.mpTotal')}</span>
                  <span>${Number(quote.total || 0).toFixed(2)}</span>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                  {t('deck.mpSellers', { count: quote.sellerCount })}
                </div>
              </div>
            )}

            {quoteError?.kind === 'stock' && (
              <div style={{ marginTop: '0.55rem', fontSize: '0.78rem' }}>
                <div style={{ color: 'var(--accent-amber, #ff9f0a)', fontWeight: 600 }}>
                  {t('deck.mpNoStock')}
                </div>
                {quoteError.unavailable.map((u, i) => (
                  <div key={i} style={{ color: 'var(--text-secondary)', fontSize: '0.74rem' }}>
                    {(u.set_code || '').toUpperCase()} #{u.collector_number}
                  </div>
                ))}
              </div>
            )}
            {quoteError?.kind === 'error' && (
              <div style={{ marginTop: '0.55rem', fontSize: '0.78rem', color: 'var(--accent-red, #ff453a)' }}>
                {quoteError.message}
              </div>
            )}
          </div>
        )}

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
