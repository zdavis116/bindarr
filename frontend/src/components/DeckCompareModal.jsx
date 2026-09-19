// COMPARE A DECK AGAINST A PRE-BUILT ONE FOR SALE ON MANA POOL.
//
// Zach: "I am just looking to compare with decks I have already built to see if
// it makes sense to maybe use some of those cards in my deck."
//
// So the question this screen answers is NOT "should I buy this deck" -- it is
// "is there anything in there worth stealing for mine, and do I already own
// it?" That is why the only-theirs column leads with ownership rather than
// price, and why there is no Buy button.
//
// Three columns, as he asked: in both, only theirs, only mine.

import { useState } from 'react';
import { X, ExternalLink, Search } from 'lucide-react';
import { useT } from '../utils/i18n';

// Bracket is the one filter he asked for -- he plays Bracket 3.
const BRACKETS = [
  { value: '', labelKey: 'mpc.anyBracket' },
  { value: '1', label: '1' }, { value: '2', label: '2' },
  { value: '3', label: '3' }, { value: '4', label: '4' },
  { value: '5', label: '5' },
];

const money = (cents) => (Number.isFinite(cents)
  ? `$${(cents / 100).toFixed(2)}` : '—');

export default function DeckCompareModal({ deck, onClose, showToast }) {
  const { t } = useT();
  // Seeded with the deck's commander: the comparison he wants is almost always
  // against the same commander, so typing it again is a step for nothing.
  const [query, setQuery] = useState(deck?.commander_name || deck?.name || '');
  const [bracket, setBracket] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [diff, setDiff] = useState(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const search = async () => {
    setSearching(true);
    setDiff(null);
    try {
      const params = new URLSearchParams({ q: query });
      if (bracket) params.set('bracket', bracket);
      const res = await fetch(`/api/decks/manapool/search?${params}`,
        { credentials: 'include' });
      const body = await res.json();
      // MANA POOL FAILING MUST LOOK LIKE MANA POOL FAILING. An empty list here
      // would read as "no premade decks exist for this commander", which is a
      // different and wrong conclusion.
      if (!res.ok) throw new Error(body.error || t('mpc.errSearch'));
      setResults(body);
    } catch (err) {
      showToast(err.message || t('mpc.errSearch'), 'error');
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const compare = async (publicId) => {
    setLoadingDiff(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}/compare/${publicId}`,
        { credentials: 'include' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t('mpc.errCompare'));
      setDiff(body);
    } catch (err) {
      showToast(err.message || t('mpc.errCompare'), 'error');
    } finally {
      setLoadingDiff(false);
    }
  };

  // The number that decides whether a deck is worth reading: of the cards it
  // runs that mine does not, how many are already in my collection?
  const stealable = diff
    ? diff.onlyTheirs.filter((c) => c.ownedInCollection > 0).length : 0;

  return (
    <div className="modal-overlay mpc-overlay" onClick={onClose}>
      <div className="glass-panel mpc-panel" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-secondary btn-icon-only mpc-close"
          onClick={onClose} aria-label={t('common.close')}>
          <X size={16} />
        </button>

        <h3 className="mpc-title">{t('mpc.title', { deck: deck?.name || '' })}</h3>

        <div className="mpc-search">
          <input
            className="input-control"
            value={query}
            placeholder={t('mpc.searchPlaceholder')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
          />
          <select className="select-control" value={bracket}
            onChange={(e) => setBracket(e.target.value)}>
            {BRACKETS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label ? t('mpc.bracketN', { n: b.label }) : t(b.labelKey)}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={search} disabled={searching}>
            <Search size={14} /> {searching ? t('mpc.searching') : t('mpc.search')}
          </button>
        </div>

        {results && !diff && (
          <div className="mpc-results">
            <p className="mpc-count">
              {t('mpc.nDecks', { n: results.decks.length, total: results.total })}
            </p>
            {results.decks.length === 0 && (
              <p className="mpc-empty">{t('mpc.noDecks')}</p>
            )}
            {results.decks.map((d) => (
              <button key={d.id} type="button" className="mpc-row"
                onClick={() => compare(d.id)} disabled={loadingDiff}>
                <span className="mpc-row-main">
                  <b>{d.theme || d.commander}</b>
                  <span className="mpc-row-sub">
                    {t('mpc.bracketN', { n: d.bracket })} · {d.seller}
                  </span>
                </span>
                <span className="mpc-row-price">{money(d.priceCents)}</span>
              </button>
            ))}
          </div>
        )}

        {loadingDiff && <p className="mpc-empty">{t('mpc.comparing')}</p>}

        {diff && (
          <div className="mpc-diff">
            <div className="mpc-diff-head">
              <button type="button" className="btn btn-secondary"
                onClick={() => setDiff(null)}>{t('mpc.back')}</button>
              <span className="mpc-headline">
                {t('mpc.stealable', { n: stealable, of: diff.onlyTheirs.length })}
              </span>
              <a className="btn btn-secondary" href={diff.premade.url}
                target="_blank" rel="noopener noreferrer">
                {t('mpc.viewOnMp')} <ExternalLink size={12} />
              </a>
            </div>

            <div className="mpc-cols">
              <section className="mpc-col">
                <header>{t('mpc.both')} <span>{diff.both.length}</span></header>
                <ul>
                  {diff.both.map((c) => (
                    <li key={c.oracleId}><span className="mpc-name">{c.name}</span></li>
                  ))}
                </ul>
              </section>

              {/* THE COLUMN THAT MATTERS. Cards he does not run -- with whether
                  they are already sitting in his collection, which is what
                  decides if the idea is free. */}
              <section className="mpc-col mpc-col-theirs">
                <header>{t('mpc.onlyTheirs')} <span>{diff.onlyTheirs.length}</span></header>
                <ul>
                  {diff.onlyTheirs.map((c) => (
                    <li key={c.oracleId}>
                      <span className="mpc-name">{c.name}</span>
                      {c.ownedInCollection > 0
                        ? <span className="mpc-owned">{t('mpc.ownN', { n: c.ownedInCollection })}</span>
                        : <span className="mpc-price">{money(c.marketPriceCents)}</span>}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="mpc-col">
                <header>{t('mpc.onlyMine')} <span>{diff.onlyMine.length}</span></header>
                <ul>
                  {diff.onlyMine.map((c) => (
                    <li key={c.oracleId}><span className="mpc-name">{c.name}</span></li>
                  ))}
                </ul>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
