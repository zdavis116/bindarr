import { useEffect } from 'react';
import { CONDITIONS, finishPickerState } from '../utils/cardOptions';
import { useT } from '../utils/i18n';

// Shared MTG collection-entry fields. Finish values remain backend-compatible.
//
// `finishes` is the SELECTED PRINTING's Scryfall finishes array, and it
// narrows the finish picker to the versions that physically exist (plan
// requirement G1). Callers that genuinely do not know pass nothing, and the
// picker falls back to offering all three — see getPrintings for why that
// fallback is permissive rather than strict.
//
// `surface` says whether this form is CREATING a record or EDITING one that
// already describes a physical card the user owns. It is the difference
// between a value that may be corrected and a value that must never be
// touched — see finishPickerState in utils/cardOptions.js, which owns that
// rule and explains at length why an out-of-range recorded finish is
// deliberately preserved rather than "fixed".
export default function CardEntryFields({
  quantity, purchasePrice, condition, printing,
  onQuantity, onPurchasePrice, onCondition, onPrinting,
  finishes,
  surface = 'add',
  variant = 'grid',
}) {
  const { t } = useT();
  const stacked = variant === 'stacked';
  const { options: printings, reset, unverifiedFinish } = finishPickerState({
    surface, finishes, printing
  });
  // Only ever applies a reset the rule above ALLOWED. On an edit surface
  // `reset` is null by construction, so this effect cannot rewrite a recorded
  // finish — that guarantee lives in finishPickerState, not here.
  useEffect(() => {
    if (reset !== null) onPrinting(reset);
  }, [reset, onPrinting]);
  const groupStyle = stacked ? { marginBottom: 0 } : undefined;
  const stepQty = (delta) => onQuantity(String(Math.max(1, (parseInt(quantity, 10) || 1) + delta)));
  const Quantity = stacked ? (
    <div className="form-group quick-add-full-width" style={groupStyle}>
      <label>{t('card.quantity')}</label>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'stretch' }}>
        <button type="button" className="btn btn-secondary" onClick={() => stepQty(-1)} aria-label={t('card.quantityDown')} style={{ padding: '0 1.1rem', fontSize: '1.3rem', flexShrink: 0 }}>&minus;</button>
        <input type="number" className="input-control" min="1" value={quantity} onChange={(e) => onQuantity(e.target.value)} required style={{ flex: 1, minWidth: 0, textAlign: 'center', fontWeight: 700 }} />
        <button type="button" className="btn btn-secondary" onClick={() => stepQty(1)} aria-label={t('card.quantityUp')} style={{ padding: '0 1.1rem', fontSize: '1.3rem', flexShrink: 0 }}>+</button>
      </div>
    </div>
  ) : (
    <div className="form-group" style={groupStyle}>
      <label>{t('card.quantity')}</label>
      <input type="number" className="input-control" min="1" value={quantity} onChange={(e) => onQuantity(e.target.value)} required />
    </div>
  );
  const Price = <div className="form-group" style={groupStyle}><label>{t('card.purchasePrice')}</label><input type="number" step="0.01" className="input-control" value={purchasePrice} onChange={(e) => onPurchasePrice(e.target.value)} placeholder="0.00" /></div>;
  const Condition = <div className="form-group" style={groupStyle}><label>{t('card.condition')}</label><select className="select-control" value={condition} onChange={(e) => onCondition(e.target.value)}>{CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}</select></div>;
  // The picker, plus the WARNING when the recorded finish contradicts the
  // catalogue. Warn, never correct: the card in his hand outranks our cache,
  // and a value he is not told about is one he cannot fix.
  const Printing = (
    <div className="form-group" style={groupStyle}>
      <label>{t('card.printing')}</label>
      <select className="select-control" value={printing} onChange={(e) => onPrinting(e.target.value)}>
        {printings.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
      {unverifiedFinish && (
        <span style={{ display: 'block', marginTop: '0.3rem', fontSize: '0.72rem', color: 'var(--accent-yellow)' }}>
          {t('card.finishUnverified')}
        </span>
      )}
    </div>
  );

  if (stacked) return <div className="quick-add-fields-group">{Quantity}{Price}{Condition}{Printing}</div>;
  return <><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>{Quantity}{Price}</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>{Condition}{Printing}</div></>;
}
