import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw } from 'lucide-react';
import { useT } from '../utils/i18n';

// THE COLLECTOR VIEW: how complete is each set?
//
// Zach: "I think it should be a view change in the collection section. Like
// grid view, list view and then collector view. We would see a bar with
// percentage."
//
// THE RULES ARE HIS, and they are enforced in SQL (see /api/set-completion):
//   * every collector number 1..total counts, borderless included, because
//     "borderless has its own number as well"
//   * foil is irrelevant -- "as long as I have 1 card for that set and number
//     combo"
//   * tokens excluded -- "just main set cards"
//
// The numbers are computed server-side rather than from the collection array
// this screen already holds: grouping 4,968 rows by set on a phone's main
// thread is work the database does in one indexed pass, and the response is
// ~103 small rows instead.

// No apiFetch prop: App.jsx patches window.fetch to attach the bearer token
// for every /api/ URL, so a plain fetch is already authenticated. Threading a
// second mechanism through would be a parallel auth path that can drift from
// the real one.
export default function CollectorView() {
  const { t } = useT();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/set-completion');
      if (!res.ok) throw new Error('failed');
      setRows(await res.json());
      setError(null);
    } catch {
      // Keep whatever is already on screen: a transient failure should not
      // blank a screen the user is reading.
      setError(t('collector.loadFailed'));
    } finally {
      setBusy(false);
    }
    // t is stable for a given locale; nothing else is captured.
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const term = q.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(r => r.name.toLowerCase().includes(term)
      || (r.code || '').toLowerCase().includes(term));
  }, [rows, q]);

  // The headline the whole screen is for: how much of everything he has seen
  // is actually his. Summed over sets he owns something from -- a total across
  // all 1,053 sets in existence would be a number near zero and mean nothing.
  const summary = useMemo(() => {
    if (!rows || !rows.length) return null;
    const owned = rows.reduce((s, r) => s + r.owned, 0);
    const total = rows.reduce((s, r) => s + r.total, 0);
    return {
      sets: rows.length,
      owned,
      total,
      percent: total ? Math.round((owned / total) * 1000) / 10 : 0,
      complete: rows.filter(r => r.complete).length,
    };
  }, [rows]);

  if (rows === null) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        {error || t('collector.loading')}
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        {t('collector.empty')}
      </div>
    );
  }

  return (
    <div className="collector-view">
      {/* SUMMARY across the sets he has cards from. */}
      {summary && (
        <div className="cv-summary">
          <div className="cv-sumrow">
            <b>{summary.owned.toLocaleString()} / {summary.total.toLocaleString()}</b>
            <span className="cv-sumpct">{summary.percent}%</span>
          </div>
          <div className="cv-bar cv-bar-lg">
            <span style={{ width: `${summary.percent}%` }} />
          </div>
          <div className="cv-summeta">
            {t('collector.acrossSets', { count: summary.sets })}
            {summary.complete > 0 && <> · {t('collector.completeCount', { count: summary.complete })}</>}
          </div>
        </div>
      )}

      <div className="cv-toolbar">
        <span className="cv-search">
          <Search size={14} />
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder={t('collector.filterSets')} />
        </span>
        <button type="button" className="cv-refresh" onClick={load} disabled={busy}
          aria-label={t('collector.refresh')} title={t('collector.refresh')}>
          <RefreshCw size={14} />
        </button>
      </div>

      {error && <div className="cv-error">{error}</div>}

      <div className="cv-list">
        {shown.map(s => (
          <div key={s.code + s.name} className={`cv-row${s.complete ? ' done' : ''}`}>
            <div className="cv-head">
              {/* The set symbol is how a player recognises a set faster than
                  by name. Scryfall serves these as SVG. */}
              {s.icon
                ? <img className="cv-icon" src={s.icon} alt="" loading="lazy" />
                : <span className="cv-icon cv-icon-ph" />}
              <span className="cv-name" title={s.name}>{s.name}</span>
              <span className="cv-code">{s.code}</span>
              <span className="cv-count">
                {s.owned.toLocaleString()} / {s.total.toLocaleString()}
              </span>
              <span className="cv-pct">{s.percent}%</span>
            </div>
            <div className="cv-bar">
              <span style={{ width: `${s.percent}%` }} />
            </div>
          </div>
        ))}
        {!shown.length && (
          <div className="cv-empty">{t('collector.noSetsMatch')}</div>
        )}
      </div>
    </div>
  );
}
