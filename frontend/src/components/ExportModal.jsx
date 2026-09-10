// THE EXPORT DIALOG, SHARED BY THE DECK VIEW AND THE DECK LIST.
//
// Zach: "for the deck list when selecting multiple decks for the buylist can we
// have the functionality be the same as for the missing in the deck view."
//
// They had drifted: the deck view offered three formats and showed the text
// before copying; the deck list silently put one fixed format on the clipboard,
// so you could not see what you were about to paste. One component now, because
// two copies of an export dialog is exactly how that drift happened.
import { useState, useMemo, useEffect } from 'react';
import { X, Download, Check, ExternalLink } from 'lucide-react';
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

  // WHAT THIS LIST WOULD COST, FROM PRICES WE ALREADY HAVE.
  //
  // Zach: "I would rather when I go to export tell me what the cost would be if
  // I was to export for manapool using the cheapest prices you have. Obviously
  // won't be exact because shipping cost but it gives an idea."
  //
  // Loaded as soon as the sheet opens because it costs nothing: no external
  // call, no waiting. The version this replaces made him press a button and wait
  // ~40 seconds for an optimizer quote whose cart could not be used at all.
  const [estimate, setEstimate] = useState(null);

  // PER-CARD: will he take another printing when buying this one?
  //
  // Zach: "Some cards I would be fine with a substitute and some I wouldn't just
  // would depend so would probably be ideal for it to be toggleable like I want
  // this printing exactly or not."
  //
  // Seeded from the server (the choice persists on deck_cards) and written back
  // immediately, so the toggle is the source of truth rather than a local
  // overlay that disagrees with the next quote.
  const [anyPrinting, setAnyPrinting] = useState({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Server state wins on open; a stale local map would price differently than
  // the screen claims.
  useMemo(() => {
    const seed = {};
    for (const c of cards || []) {
      const id = c.desired_card_id || c.card_id;
      if (id) seed[id] = Boolean(c.allow_any_printing);
    }
    setAnyPrinting(seed);
    return null;
  }, [cards]);

  // Reload whenever the sheet opens or a printing choice changes: both change
  // the answer, and a stale total is worse than none.
  useEffect(() => {
    if (!open || !deckId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/decks/${deckId}/buylist/estimate`);
        if (r.ok && !cancelled) setEstimate(await r.json());
      } catch { /* the estimate simply does not render */ }
    })();
    return () => { cancelled = true; };
  }, [open, deckId, anyPrinting]);

  // Pinned = he wants THAT printing. Counted from the live map so the summary
  // can never disagree with the checkboxes.
  const pinnedCount = (cards || [])
    .filter(c => !anyPrinting[c.desired_card_id || c.card_id]).length;

  const visibleCards = (cards || []).filter(c => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${c.name} ${c.set_id} ${c.number}`.toLowerCase().includes(q);
  });

  // ONE CALL, NOT 49. Zach: "maybe an option to select all for exact printing".
  // Server-side so a partial sweep cannot leave the deck in a state the screen
  // does not describe.
  const bulkPrinting = async (allowAny) => {
    if (!deckId) return;
    const prev = anyPrinting;
    const next = {};
    for (const c of cards || []) {
      const id = c.desired_card_id || c.card_id;
      if (id) next[id] = allowAny;
    }
    setAnyPrinting(next);
    setEstimate(null);
    try {
      const res = await fetch(`/api/decks/${deckId}/cards/printing-preference`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_any_printing: allowAny }),
      });
      if (!res.ok) throw new Error('bulk failed');
    } catch {
      setAnyPrinting(prev);
      showToast(t('deck.mpPrefFailed'), 'error');
    }
  };

  const togglePrinting = async (cardId, next) => {
    if (!deckId || !cardId) return;
    // Optimistic, then reconciled: the checkbox must feel instant, but a failed
    // write must not leave the UI claiming a preference the server does not have.
    setAnyPrinting(prev => ({ ...prev, [cardId]: next }));
    setEstimate(null);
    try {
      const res = await fetch(`/api/decks/${deckId}/cards/${cardId}/printing-preference`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_any_printing: next }),
      });
      if (!res.ok) throw new Error('save failed');
    } catch {
      setAnyPrinting(prev => ({ ...prev, [cardId]: !next }));
      showToast(t('deck.mpPrefFailed'), 'error');
    }
  };

  // COPY THE LIST AND OPEN MASS ENTRY.
  //
  // Zach: "I do like the idea of just copying and sending me right to mass
  // entry."
  //
  // manapool.com/add-deck is their Mass Entry screen -- a `decklist` textarea
  // that accepts "4 Plains [M20] 261", with an Optimize Price button. It cannot
  // be prefilled from a URL: eight query parameter names were tried against the
  // live page and the textarea came back empty every time. So this is clipboard
  // plus a new tab, and he pastes. A link that LOOKS like it prefills and lands
  // him on an empty box would be worse than asking for the paste.
  const copyAndOpen = async () => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('deck.mpCopiedForMassEntry'), 'success');
    } catch {
      showToast(t('deck.buylistCopyFailed'), 'error');
      return;   // no tab if the list is not on the clipboard
    }
    window.open('https://manapool.com/add-deck', '_blank', 'noopener');
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

        {/* WHICH CARDS MUST BE THE EXACT PRINTING?
            Zach: "Printing list is horrible definitely needs a better design...
            It should default to any printing and I pick the cards I want exact
            printing."

            The old version was 49 rows of lock icons -- a data dump, not a
            design. This shows the SUMMARY plus only the cards he has pinned;
            the full list is one tap away and searchable. The common case
            (everything flexible) needs no interaction at all. */}
        {deckId && text && cards.length > 0 && (
          <div style={{ padding: '0.75rem 1rem 0' }}>
            {/* Label above the control, matching the price block below it. The
                first version had a bare row with different padding from its
                neighbours, so nothing lined up down the sheet. */}
            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase',
                          letterSpacing: '0.04em', color: 'var(--text-tertiary)',
                          marginBottom: '0.4rem' }}>
              {t('deck.mpPrintingsLabel')}
            </div>
            <button onClick={() => setPickerOpen(true)}
              style={{ width: '100%', display: 'flex', alignItems: 'center',
                       justifyContent: 'space-between', gap: '0.6rem',
                       minHeight: 44, padding: '0 0.75rem',
                       borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)',
                       background: 'var(--surface-2)', color: 'var(--text-primary)',
                       font: 'inherit', fontSize: '0.82rem', textAlign: 'left',
                       cursor: 'pointer' }}>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap',
                             overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {pinnedCount === 0
                  ? t('deck.mpAllFlexible')
                  : t('deck.mpSomePinned', { count: pinnedCount, total: cards.length })}
              </span>
              <span style={{ flexShrink: 0, color: 'var(--accent-blue)', fontWeight: 600 }}>
                {t('deck.mpChoose')}
              </span>
            </button>
          </div>
        )}

        {/* THE PICKER. A separate full-height sheet so 49 cards have room, with
            search and the two bulk actions he asked for. */}
        {pickerOpen && (
          <div style={{ position: 'fixed', inset: 0, zIndex: Z_MODAL + 1,
                        background: 'var(--surface-1)', display: 'flex', flexDirection: 'column',
                        paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '0.9rem 1rem 0.6rem' }}>
              <b style={{ fontSize: '1rem' }}>{t('deck.mpExactTitle')}</b>
              <button onClick={() => setPickerOpen(false)} aria-label={t('common.close')}
                style={{ width: 34, height: 34, borderRadius: 'var(--radius-sm)', border: 0,
                         background: 'var(--surface-3)', color: 'var(--text-primary)',
                         display: 'grid', placeItems: 'center', cursor: 'pointer' }}>
                <X size={16} />
              </button>
            </div>

            <div style={{ padding: '0 1rem 0.5rem', fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
              {t('deck.mpExactHint')}
            </div>

            {/* Bulk actions: "select all for exact printing just in case". */}
            <div style={{ display: 'flex', gap: '0.4rem', padding: '0 1rem 0.6rem' }}>
              <button onClick={() => bulkPrinting(false)}
                style={{ flex: 1, minHeight: 36, borderRadius: 'var(--radius-sm)', border: 0,
                         background: 'var(--surface-3)', color: 'var(--text-primary)',
                         font: 'inherit', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
                {t('deck.mpPinAll')}
              </button>
              <button onClick={() => bulkPrinting(true)}
                style={{ flex: 1, minHeight: 36, borderRadius: 'var(--radius-sm)', border: 0,
                         background: 'var(--surface-3)', color: 'var(--text-primary)',
                         font: 'inherit', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer' }}>
                {t('deck.mpUnpinAll')}
              </button>
            </div>

            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('deck.mpSearchCards')}
              style={{ margin: '0 1rem 0.6rem', minHeight: 38, borderRadius: 'var(--radius-sm)',
                       border: '1px solid var(--border-glass)', background: 'var(--surface-2)',
                       color: 'var(--text-primary)', font: 'inherit', fontSize: '0.85rem',
                       padding: '0 0.6rem' }}
            />

            <div style={{ flex: 1, overflow: 'auto', padding: '0 1rem 1rem' }}>
              {visibleCards.map((c) => {
                const id = c.desired_card_id || c.card_id;
                const exact = !anyPrinting[id];
                return (
                  <button key={id} onClick={() => togglePrinting(id, exact)}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.6rem',
                             padding: '0.55rem 0.5rem', border: 0, background: 'transparent',
                             borderBottom: '1px solid var(--border-glass)',
                             color: 'var(--text-primary)', font: 'inherit', textAlign: 'left',
                             cursor: 'pointer' }}>
                    <span style={{ flexShrink: 0, width: 22, height: 22, borderRadius: 6,
                                   border: `1.5px solid ${exact ? 'var(--accent-blue)' : 'var(--border-glass)'}`,
                                   background: exact ? 'var(--accent-blue)' : 'transparent',
                                   display: 'grid', placeItems: 'center', color: '#fff' }}>
                      {exact && <Check size={13} />}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: '0.82rem', whiteSpace: 'nowrap',
                                     overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.name}
                      </span>
                      <span style={{ display: 'block', fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>
                        {(c.set_id || '').toUpperCase()} #{c.number}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ padding: '0.8rem 1rem 1rem' }}>
              <button onClick={() => setPickerOpen(false)}
                style={{ width: '100%', minHeight: 46, borderRadius: 'var(--radius-md)', border: 0,
                         background: 'var(--accent-blue)', color: '#fff', font: 'inherit',
                         fontSize: '0.92rem', fontWeight: 600, cursor: 'pointer' }}>
                {t('common.done')}
              </button>
            </div>
          </div>
        )}

        {/* WHAT IT WOULD COST, FROM PRICES WE ALREADY HAVE.
            No button and no waiting: arithmetic over the Mana Pool prices
            Bindarr refreshes every 6 hours. It states that shipping is excluded,
            because shipping genuinely cannot be known until checkout -- it
            depends on how the order splits across sellers. */}
        {deckId && estimate && estimate.lines > 0 && (
          <div style={{ padding: '0.75rem 1rem 0' }}>
            <div style={{ fontSize: '0.7rem', textTransform: 'uppercase',
                          letterSpacing: '0.04em', color: 'var(--text-tertiary)',
                          marginBottom: '0.4rem' }}>
              {t('deck.mpCostLabel')}
            </div>
            <div style={{ padding: '0.7rem 0.75rem', borderRadius: 'var(--radius-sm)',
                          background: 'var(--surface-2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between',
                            alignItems: 'baseline' }}>
                <span style={{ fontSize: '1.05rem', fontWeight: 700 }}>
                  ${Number(estimate.items || 0).toFixed(2)}
                </span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)' }}>
                  {t('deck.mpEstCards', { count: estimate.priced })}
                </span>
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                {t('deck.mpEstExcludesShipping')}
              </div>

              {/* A CARD WITH NO PRICE IS NAMED, never quietly costed at zero. */}
              {estimate.unpriced?.length > 0 && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.72rem',
                              color: 'var(--accent-amber, #ff9f0a)' }}>
                  {t('deck.mpEstUnpriced', { count: estimate.unpriced.length })}
                </div>
              )}

              {/* WHICH CARDS BINDARR CHOSE A DIFFERENT PRINTING FOR. With any
                  printing as the default, this is his only warning that
                  different cardboard is coming. */}
              {estimate.substitutions?.length > 0 && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.71rem',
                              color: 'var(--text-secondary)' }}>
                  <div style={{ fontWeight: 600 }}>
                    {t('deck.mpSwapped', { count: estimate.substitutions.length })}
                  </div>
                  {estimate.substitutions.slice(0, 5).map((sub, n) => (
                    <div key={n}>{sub.name}: {sub.from} → {sub.to}</div>
                  ))}
                  {estimate.substitutions.length > 5 && (
                    <div>+{estimate.substitutions.length - 5} more</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div style={{ padding: '0.8rem 1rem 1rem', display: 'grid', gap: '0.5rem' }}>
          {/* Straight to Mass Entry with the list on the clipboard. */}
          {deckId && text && (
            <button onClick={copyAndOpen}
              style={{ width: '100%', minHeight: 48, borderRadius: 'var(--radius-md)',
                       border: 0, background: 'var(--accent-blue)', color: '#fff',
                       font: 'inherit', fontSize: '0.95rem', fontWeight: 600,
                       display: 'flex', alignItems: 'center', justifyContent: 'center',
                       gap: '0.45rem', cursor: 'pointer' }}>
              <ExternalLink size={16} />
              {t('deck.mpOpenMassEntry')}
            </button>
          )}
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
