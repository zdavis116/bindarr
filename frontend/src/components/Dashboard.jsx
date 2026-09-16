// HOME — the landing screen.
//
// Rebuilt against the approved mockup (sketches/002-home). Zach kept the
// dashboard as the landing screen, so it has to earn that slot.
//
// THE ORGANISING IDEA: a dashboard that only reports numbers is a poster. This
// one is built around the two things Zach does next -- carry on building a deck,
// or scan a stack -- with the numbers as context rather than the point.
//
// Order is deliberate, most-actionable first:
//   1. Scan cards      -- the action with a physical stack waiting on it
//   2. Decks in progress -- what he came here to continue, and what it costs
//   3. Collection stats -- context, small, last
//
// The old version led with a six-card metric grid and a price chart. Both are
// still reachable (Collection, and the deck screens) but neither answers "what
// do I do now", which is the only question a landing screen should answer.

import { useState, useEffect } from 'react';
// ONE rule for which name to show. Zach: "my most expensive card is cast off
// consort but it's using the blood letter of Alcatraz which isn't right."
// utils/cardName.js has said so since the Splinter/Ink-Eyes bug; this screen
// was new and simply never asked it.
import { displayName, secondaryName } from '../utils/cardName';
import CardInspectorModal from './CardInspectorModal';
import { Camera, ChevronRight } from 'lucide-react';
import { useT } from '../utils/i18n';

// A deck's completion ring. Reads at a glance from arm's length, which a
// percentage in text does not -- Zach checks this while holding cards.
function ProgressRing({ pct, size = 42 }) {
  const r = (size - 8) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (circumference * Math.min(100, Math.max(0, pct))) / 100;
  return (
    <div style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2} cy={size / 2} r={r}
          stroke="var(--surface-2)" strokeWidth="4" fill="none"
        />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          stroke="var(--accent-green)" strokeWidth="4" fill="none"
          strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset .5s cubic-bezier(.2,.8,.3,1)' }}
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-primary)',
      }}>
        {Math.round(pct)}%
      </div>
    </div>
  );
}

function Dashboard({ statsTrigger, onNavigate, onOpenDeck }) {
  const { t } = useT();
  const [stats, setStats] = useState(null);
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The card opened from the top-ten strip.
  const [inspectorCard, setInspectorCard] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // Both in parallel: they are independent, and serialising them would
        // make the landing screen wait for the slower of the two.
        const [statsRes, decksRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/decks'),
        ]);
        if (!statsRes.ok) throw new Error(`stats ${statsRes.status}`);
        if (!decksRes.ok) throw new Error(`decks ${decksRes.status}`);
        const statsJson = await statsRes.json();
        const decksJson = await decksRes.json();
        if (cancelled) return;
        setStats(statsJson);
        setDecks(Array.isArray(decksJson) ? decksJson : []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [statsTrigger]);

  const summary = stats?.summary;

  // MOST VALUABLE. The API returns ten, already collapsed to one row per
  // printing with a copy count, ordered by the resolved price. Nothing is
  // recomputed here -- reading mp_price_cents myself in the mockup showed
  // $0.00 for every foil while sorting them near the top.
  const topValuable = stats?.topValuable || [];

  // TO FINISH EVERY DECK. The same figure each deck row shows, summed, so the
  // headline and the rows cannot disagree.
  const toFinish = decks.reduce((t, d) => t + (Number(d.missing_cost) || 0), 0);
  const missingCards = decks.reduce(
    (t, d) => t + Math.max(0, (d.target_size || 0) - (d.owned_cards || 0)), 0);

  // DECKS IN PROGRESS = decks that are NOT finished.
  //
  // Zach: "decks in progress should just be the decks that aren't complete."
  // It was showing all four of his decks, three of them at 100% and labelled
  // "Ready to play" -- so the phone dashboard spent four tall rows telling him
  // nothing needed doing, and pushed the top ten below the fold.
  //
  // Worst-completed FIRST now: the one furthest from done is the one you are
  // most likely to act on.
  const inProgress = decks
    .filter((d) => (d.target_size || 0) > 0)
    .map((d) => ({
      ...d,
      // OWNED, not listed. total_cards counts what the list says; a freshly
      // imported deck is fully listed and entirely unowned, and this read 97%
      // for a deck holding three of its ninety-seven cards.
      pct: Math.min(100, Math.round(((d.owned_cards || 0) / d.target_size) * 100)),
    }))
    .filter((d) => d.pct < 100)
    .sort((a, b) => a.pct - b.pct);

  if (loading) {
    return (
      <div style={{ padding: '2.5rem 1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        {t('common.loading')}
      </div>
    );
  }

  if (error) {
    // Say what failed and offer the way back. A blank screen with a spinner
    // that stopped is indistinguishable from a broken app.
    return (
      <div className="glass-panel" style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
        <p>{t('dash.errLoad', { error })}</p>
        <button className="btn btn-primary" style={{ marginTop: '1rem' }}
                onClick={() => onNavigate && onNavigate('dashboard')}>
          {t('dash.retry')}
        </button>
      </div>
    );
  }

  return (
    // THE DESKTOP DASHBOARD IS A GRID, THE PHONE IS A COLUMN.
    //
    // Zach: "its just like quick glance of everything." Measured before
    // building: at 1855x731 this screen was three full-width bars stacked
    // vertically with content ending at 20% of the height -- the phone
    // stretched sideways.
    //
    // The order below is the PHONE order and is deliberate: scan first,
    // because it is the only action with a physical stack waiting on it.
    // CSS re-flows it into two columns on a desktop; the markup does not
    // change, so the two widths cannot drift apart.
    <div className="dash">
      {/* KPIs. Four numbers that answer "how am I doing" without scrolling. */}
      {summary && (
        <div className="dash-kpis">
          <button className="dash-kpi" onClick={() => onNavigate && onNavigate('collection')}>
            <span className="dash-kpi-lbl">{t('dash.kpiValue')}</span>
            <span className="dash-kpi-num">
              {summary.totalValue != null ? `$${Number(summary.totalValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
            </span>
            {/* NO INVENTED TREND. The API reports change7d.available=false
                until price history exists; the mockup's "up $12.40 this week"
                was a number I made up. */}
            <span className="dash-kpi-sub">
              {summary.change7d?.available
                ? t('dash.kpiWeek', {
                  dir: summary.change7d.abs >= 0 ? '▲' : '▼',
                  amount: `$${Math.abs(summary.change7d.abs).toFixed(2)}`,
                })
                : t('dash.kpiNoHistory')}
            </span>
          </button>

          <button className="dash-kpi" onClick={() => onNavigate && onNavigate('collection')}>
            <span className="dash-kpi-lbl">{t('dash.cards')}</span>
            <span className="dash-kpi-num">{(summary.totalCards || 0).toLocaleString()}</span>
            <span className="dash-kpi-sub">
              {t('dash.kpiUnique', { n: (summary.uniqueCards || 0).toLocaleString() })}
            </span>
          </button>

          <button className="dash-kpi" onClick={() => onNavigate && onNavigate('deckbuilder')}>
            <span className="dash-kpi-lbl">{t('nav.deckBuilder')}</span>
            <span className="dash-kpi-num">{decks.length}</span>
            <span className="dash-kpi-sub">
              {inProgress.filter((d) => d.pct < 100).length
                ? t('dash.kpiIncomplete', { n: inProgress.filter((d) => d.pct < 100).length })
                : t('dash.kpiAllComplete')}
            </span>
          </button>

          <button className="dash-kpi" onClick={() => onNavigate && onNavigate('deckbuilder')}>
            <span className="dash-kpi-lbl">{t('dash.kpiToFinish')}</span>
            <span className={`dash-kpi-num${toFinish > 0 ? ' warn' : ''}`}>
              ${toFinish.toFixed(2)}
            </span>
            <span className="dash-kpi-sub">
              {missingCards ? t('dash.kpiMissing', { n: missingCards }) : t('dash.kpiNothingMissing')}
            </span>
          </button>
        </div>
      )}

      <div className="dash-cols">
      <div className="dash-col">

      {/* PRIMARY ACTION, FIRST AND FULL WIDTH.
          Scanning is the thing Zach does most and the only action with a
          physical stack waiting on it. It replaced the Add Cards nav tab
          entirely: "Actually takes away the need to hit the scan button at the
          bottom so scan can be removed from nav bar." */}
      <button
        onClick={() => onNavigate && onNavigate('add-cards')}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.9rem', width: '100%',
          textAlign: 'left', border: 0, cursor: 'pointer', font: 'inherit',
          background: 'linear-gradient(135deg, var(--accent-blue), #0060d0)',
          color: 'var(--text-on-accent)', borderRadius: 'var(--radius-lg)',
          padding: '1.1rem', minHeight: 76, boxShadow: 'var(--shadow-accent)',
        }}
      >
        <span style={{
          width: 44, height: 44, borderRadius: 12, flexShrink: 0,
          background: 'rgba(255,255,255,0.2)', display: 'grid', placeItems: 'center',
        }}>
          <Camera size={22} />
        </span>
        <span>
          <span style={{ display: 'block', fontSize: '1.05rem', fontWeight: 600 }}>
            {t('dash.scanCards')}
          </span>
          <span style={{ fontSize: '0.8rem', opacity: 0.85 }}>
            {t('dash.scanCardsSub')}
          </span>
        </span>
      </button>

      {/* DECKS IN PROGRESS, as side-scrolling cards.
          Zach: "it should only show 3 at a time and be a scroll and I like the
          idea of it being a side scroll so maybe they should be like cards."
          Four tall rows were eating the phone's whole fold; three cards in a
          sideways strip cost one row of height and still show the commander
          art, which is how he recognises a deck. */}
      {inProgress.length > 0 && (
        <div>
          <div className="dash-head">
            {t('dash.decksInProgress')}
            <span className="dash-head-sub">
              {t('dash.deckCount', { n: inProgress.length })}
            </span>
          </div>
          <div className="dash-decks">
            {inProgress.map((deck) => (
              <button
                key={deck.id}
                className="dash-deck"
                // Open THIS deck, not the deck list. Zach: "when you click
                // on the deck in the deck in progress it should take you
                // into that deck." Falls back to the list if the handler is
                // missing, so the card is never a dead tap.
                onClick={() => (onOpenDeck ? onOpenDeck(deck.id) : onNavigate && onNavigate('deckbuilder'))}
              >
                {deck.commander_image_url
                  ? <img src={deck.commander_image_url} alt="" loading="lazy" />
                  : <span className="dash-deck-noart" />}
                <span className="dash-deck-body">
                  <span className="dash-deck-name">{deck.name}</span>
                  {/* WHICH DECKS MIRROR MOXFIELD. Lost when these rows became
                      cards -- Zach: "The card for decks in progress lost the
                      moxfield bubble can that be added." Same class as the
                      deck list so the two screens cannot drift. */}
                  {deck.moxfield_public_id ? (
                    <span className="deck-source-badge">{t('decks.moxfieldBadge')}</span>
                  ) : null}
                  <span className="dash-deck-sub">
                    {t('dash.deckCards', { have: deck.owned_cards || 0, want: deck.target_size })}
                  </span>
                  {/* The buying question, which is why this card is here. */}
                  {Number(deck.missing_cost) > 0 ? (
                    <span className="dash-deck-cost">
                      ${Number(deck.missing_cost).toFixed(2)}
                    </span>
                  ) : null}
                </span>
                <span className="dash-deck-ring"><ProgressRing pct={deck.pct} /></span>
              </button>
            ))}
          </div>
        </div>
      )}

      </div>{/* /dash-col */}

      {/* SECOND COLUMN on desktop, below the decks on a phone. */}
      <div className="dash-col">
        {/* MOST VALUABLE. Zach: "I dont believe it should be static if a card
            jumps in price it should jump up the list... Maybe it should be the
            current top 10 cards" and "I would like to maybe see top 10 most
            valuable on my dashboard on my phone as well."
            Ordered by live price server-side, so it re-ranks itself. One row
            per PRINTING: two copies of Commander's Plate are one card with an
            x2 badge, not two entries. */}
        {topValuable.length > 0 && (
          <div>
            <div className="dash-head">
              {t('dash.mostValuable')}
              <span className="dash-head-sub">
                {t('dash.pricedBy', { source: summary?.priceSources?.[0]?.label || '' })}
              </span>
            </div>
            <div className="dash-top">
              {topValuable.map((c) => (
                <button
                  key={c.entry_id || c.card_id}
                  className="dash-topcard"
                  title={`${displayName(c)}${secondaryName(c) ? ` (${secondaryName(c)})` : ''} — $${Number(c.price_trend || 0).toFixed(2)}${c.copies > 1 ? ` · ${c.copies} copies` : ''}`}
                  // Zach: "when I click on the card it just takes me to
                  // collection but it should just open the card detail modal."
                  // Dumping him on a 1,500-card list and leaving him to find
                  // the card again is not what clicking a card means.
                  onClick={() => setInspectorCard(c)}
                >
                  {c.image_url ? <img src={c.image_url} alt={displayName(c)} loading="lazy" /> : null}
                  {c.copies > 1 ? <span className="dash-copies">x{c.copies}</span> : null}
                  <span className="dash-topcap">
                    <b>{displayName(c)}</b>
                    <span>${Number(c.price_trend || 0).toFixed(2)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      </div>{/* /dash-cols */}

      {/* EMPTY STATE. A new user sees the scan button above and this, rather
          than three zeroes and an empty deck list that look like a failure. */}
      {!inProgress.length && summary && !summary.totalCards && (
        <div style={{
          textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-secondary)',
          background: 'var(--surface-1)', borderRadius: 'var(--radius-md)',
        }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>
            {t('dash.emptyTitle')}
          </div>
          <div style={{ fontSize: '0.85rem' }}>
            {t('dash.emptyBody')}
          </div>
        </div>
      )}
    {inspectorCard && (
        <CardInspectorModal
          card={inspectorCard}
          onClose={() => setInspectorCard(null)}
          // This screen does not own the stats trigger (the parent passes it
          // in) and is not given a toast handler, so neither is forwarded --
          // passing undefined would crash the modal on its first edit.
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}

export default Dashboard;
