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
// Two deck lists side by side, as he asked (2026-09-20): "change the views to
// my deck and the compared deck and highlight the differences in red with both
// decks", each "organize[d] ... just like the deck view like by card type and
// do each section in alphabetical order."
//
// So this is deliberately NOT a diff view any more. It is two DECK LISTS in the
// shape he already reads, with the comparison as an annotation on each card.
// Sections line up down the page, so "they run four more creatures than I do"
// is visible without counting anything.

import { useMemo, useState } from 'react';
import { X, ExternalLink, Search } from 'lucide-react';
import { useT } from '../utils/i18n';
import { sectionCompareCards, compareSectionCount } from './compareSections';

// Section titles come out of the shared deck-view sectioning rule as plain
// English keys; this maps them onto the translation table. Keeping the map here
// rather than translating inside compareSections keeps that module pure and
// testable without an i18n context.
const SECTION_KEYS = {
  Commander: 'mpc.sectionCommander',
  Creatures: 'mpc.sectionCreatures',
  Sorcery: 'mpc.sectionSorcery',
  Instant: 'mpc.sectionInstant',
  Enchantment: 'mpc.sectionEnchantment',
  Artifact: 'mpc.sectionArtifact',
  Planeswalker: 'mpc.sectionPlaneswalker',
  Lands: 'mpc.sectionLands',
  Other: 'mpc.sectionOther',
};

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
  // SEED WITH THE COMMANDER, NOT THE DECK NAME.
  //
  // It seeded "AI Doom" -- Zach's name for his deck -- and Mana Pool indexes by
  // commander, so the very first search was guaranteed to return nothing.
  // The commander is the card flagged is_commander in the deck's own rows;
  // `commander_name` was a field I assumed and does not exist.
  const commander = (deck?.cards || []).find((c) => c.board === 'commander'
    || c.is_commander)?.name
    || deck?.commander_name || '';
  const [query, setQuery] = useState(commander || deck?.name || '');
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

  // Sectioning is pure work over a list that only changes when a new
  // comparison loads, so it is memoised rather than recomputed on every
  // keystroke in the search box above it.
  const mineSections = useMemo(
    () => (diff ? sectionCompareCards(diff.mine) : []), [diff]);
  const theirSections = useMemo(
    () => (diff ? sectionCompareCards(diff.theirs) : []), [diff]);

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
                {t('mpc.stealable', {
                  n: diff.stealableCount, of: diff.onlyTheirsCount,
                })}
              </span>
              <a className="btn btn-secondary" href={diff.premade.url}
                target="_blank" rel="noopener noreferrer">
                {t('mpc.viewOnMp')} <ExternalLink size={12} />
              </a>
            </div>

            {/* WHAT RED MEANS, SAID ONCE. Red on a card is this app's colour
                for "you cannot have this as things stand" elsewhere; here it
                means "not in the other deck". Without the key, a column of red
                reads as an error rather than as the answer. */}
            <p className="mpc-legend">
              <span className="mpc-legend-swatch" aria-hidden="true" />
              {t('mpc.legend')}
            </p>

            <div className="mpc-decks">
              <DeckColumn
                title={diff.deck.name}
                subtitle={t('mpc.nDiffer', { n: diff.onlyMineCount })}
                sections={mineSections}
                t={t}
              />
              <DeckColumn
                title={diff.premade.name || t('mpc.theirDeck')}
                subtitle={t('mpc.nDiffer', { n: diff.onlyTheirsCount })}
                sections={theirSections}
                theirs
                t={t}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// One deck, sectioned by card type, alphabetical within a section -- the same
// shape as the deck view, so a player reads it the way they already read their
// own list.
//
// The ONLY difference between the two sides is what a differing card shows
// beside its name: on their side, whether it is already in the collection and
// what it would cost if not. That is the question this screen exists to answer,
// and it has no counterpart on his side.
function DeckColumn({ title, subtitle, sections, theirs, t }) {
  return (
    <section className={`mpc-deck${theirs ? ' mpc-deck-theirs' : ''}`}>
      <header className="mpc-deck-head">
        <b title={title}>{title}</b>
        <span>{subtitle}</span>
      </header>
      <div className="mpc-deck-body">
        {sections.map((s) => (
          <div key={s.key} className="mpc-section">
            <h4 className="mpc-section-head">
              {t(SECTION_KEYS[s.title] || 'mpc.sectionOther')}
              <span>{compareSectionCount(s.cards)}</span>
            </h4>
            <ul>
              {s.cards.map((c) => (
                // `shared` is the SERVER's answer. Recomputing membership here
                // is how the Curve tab ended up with a row and its tooltip
                // disagreeing.
                <li key={c.oracleId} className={c.shared ? '' : 'mpc-differs'}>
                  <span className="mpc-name">{c.name}</span>
                  {!c.shared && theirs && (c.ownedInCollection > 0
                    ? <span className="mpc-owned">{t('mpc.ownN', { n: c.ownedInCollection })}</span>
                    : <span className="mpc-price">{money(c.marketPriceCents)}</span>)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
