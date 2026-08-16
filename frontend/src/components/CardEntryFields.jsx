import { CONDITIONS, getPrintings } from '../utils/cardOptions';
import { useT } from '../utils/i18n';

// Shared MTG collection-entry fields. Finish values remain backend-compatible.
export default function CardEntryFields({
  quantity, purchasePrice, condition, printing,
  onQuantity, onPurchasePrice, onCondition, onPrinting,
  variant = 'grid',
}) {
  const { t } = useT();
  const stacked = variant === 'stacked';
  const printings = getPrintings();
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
  const Printing = <div className="form-group" style={groupStyle}><label>{t('card.printing')}</label><select className="select-control" value={printing} onChange={(e) => onPrinting(e.target.value)}>{printings.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></div>;

  if (stacked) return <div className="quick-add-fields-group">{Quantity}{Price}{Condition}{Printing}</div>;
  return <><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>{Quantity}{Price}</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem' }}>{Condition}{Printing}</div></>;
}
