import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { useT } from '../utils/i18n';

// EVERY CARD IN ONE SET, with the ones he is missing greyed out.
//
// Zach: "I would like to be able to click on the set and see all cards showing
// the ones I have and the ones I am missing" / "Grayed out card image" /
// "Show everything with missing grayed out" / "I think it would be cool to
// reuse the card detail pane we have. Same as when on deck view for cards I
// dont own."
//
// That last one decides the inspector contract: the deck view opens
// CardInspectorModal with `readOnly`, because a card he does not own has no
// collection row to write through. The same applies here -- a missing card is
// a catalogue entry, not an entry_id -- so this screen reuses that exact mode
// rather than inventing a third behaviour.

const PAGE = 60;

export default function SetCardsView({ code, onBack, onInspect }) {
  const { t } = useT();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/set-cards/${encodeURIComponent(code)}`);
      if (!res.ok) throw new Error('failed');
      setData(await res.json());
      setError(null);
    } catch {
      setError(t('collector.loadFailed'));
    }
  }, [code, t]);

  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    return data.cards.filter(c => {
      if (onlyMissing && c.owned) return false;
      if (!term) return true;
      return (c.name || '').toLowerCase().includes(term)
        || String(c.number) === term;
    });
  }, [data, q, onlyMissing]);

  // PAGED APPEND, the same shape the gallery uses. Reality Fracture is 461
  // cards; building 461 <img> elements for a viewport showing a dozen is the
  // 3.35s phone stall the collection screen already solved once.
  useEffect(() => { setLimit(PAGE); }, [q, onlyMissing]);

  if (!data) {
    return (
      <div className="sc-wrap">
        <button type="button" className="sc-back" onClick={onBack}>
          <ArrowLeft size={15} /> {t('collector.backToSets')}
        </button>
        <div className="sc-status">{error || t('collector.loading')}</div>
      </div>
    );
  }

  const missing = data.cards.length - data.owned;
  const visible = shown.slice(0, limit);

  return (
    <div className="sc-wrap">
      <button type="button" className="sc-back" onClick={onBack}>
        <ArrowLeft size={15} /> {t('collector.backToSets')}
      </button>

      <div className="sc-head">
        {data.set.icon && <img className="sc-icon" src={data.set.icon} alt="" />}
        <span className="sc-name">{data.set.name}</span>
        <span className="sc-code">{data.set.code}</span>
      </div>
      <div className="sc-sub">
        {t('collector.haveOfTotal', { owned: data.owned, total: data.cards.length })}
        {missing > 0 && <> · {t('collector.missingCount', { count: missing })}</>}
      </div>

      <div className="sc-toolbar">
        <span className="sc-search">
          <Search size={14} />
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder={t('collector.filterCards')} />
        </span>
        <button
          type="button"
          className={`sc-toggle${onlyMissing ? ' on' : ''}`}
          aria-pressed={onlyMissing}
          onClick={() => setOnlyMissing(v => !v)}
        >
          {t('collector.onlyMissing')}
        </button>
      </div>

      <div className="sc-grid">
        {visible.map(c => (
          <button
            type="button"
            key={c.number}
            className={`sc-card${c.owned ? '' : ' missing'}`}
            /* THE SAME READ-ONLY INSPECTOR THE DECK VIEW USES for cards he
               does not own. A missing card has no collection row, so the
               inspector must not be given an entry id to write through. */
            onClick={() => onInspect && onInspect(c)}
            title={`#${c.number} ${c.name}`}
          >
            {c.image_url
              ? <img src={c.image_url} alt={c.name} loading="lazy" />
              : <span className="sc-noimg">{c.name}</span>}
            <span className="sc-num">#{c.number}</span>
            {c.owned && c.copies > 1 && <span className="sc-qty">×{c.copies}</span>}
          </button>
        ))}
      </div>

      {visible.length < shown.length && (
        <button type="button" className="sc-more" onClick={() => setLimit(l => l + PAGE)}>
          {t('collector.showMore', { count: shown.length - visible.length })}
        </button>
      )}

      {!shown.length && <div className="sc-status">{t('collector.noCardsMatch')}</div>}
    </div>
  );
}
