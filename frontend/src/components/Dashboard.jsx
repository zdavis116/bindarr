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

function Dashboard({ statsTrigger, onNavigate, showToast }) {
  const { t } = useT();
  const [stats, setStats] = useState(null);
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  // Decks that are NOT finished, worst-completed first: the point of this list
  // is what still needs work. A completed deck is not "in progress", and
  // showing it here would push the unfinished ones down.
  const inProgress = decks
    .filter(d => (d.target_size || 0) > 0)
    .map(d => ({
      ...d,
      pct: Math.min(100, Math.round(((d.total_cards || 0) / d.target_size) * 100)),
    }))
    .sort((a, b) => b.pct - a.pct);

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

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

      {/* DECKS IN PROGRESS -- "continue where you left off", and the screen's
          real job. Each row answers the buying question at a glance. */}
      {inProgress.length > 0 && (
        <div>
          <div style={{
            fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)',
            textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.6rem',
          }}>
            {t('dash.decksInProgress')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
            {inProgress.slice(0, 5).map(deck => (
              <button
                key={deck.id}
                onClick={() => onNavigate && onNavigate('deckbuilder')}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.8rem', width: '100%',
                  textAlign: 'left', border: 0, cursor: 'pointer', font: 'inherit',
                  background: 'var(--surface-1)', color: 'var(--text-primary)',
                  borderRadius: 'var(--radius-md)', padding: '0.8rem 0.9rem', minHeight: 44,
                }}
              >
                <ProgressRing pct={deck.pct} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{
                    display: 'block', fontSize: '0.95rem', fontWeight: 600,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {deck.name}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {deck.pct >= 100
                      ? t('dash.deckReady')
                      : t('dash.deckCards', { have: deck.total_cards || 0, want: deck.target_size })}
                  </span>
                </span>
                <ChevronRight size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* NUMBERS LAST, AND SMALL. Context, not the headline. */}
      {summary && (
        <div>
          <div style={{
            fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)',
            textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.6rem',
          }}>
            {t('nav.collection')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.55rem' }}>
            {[
              [summary.totalCards, t('dash.cards')],
              [summary.uniqueCards, t('dash.unique')],
              [summary.totalValue != null ? `$${Math.round(summary.totalValue)}` : '—', t('dash.value')],
            ].map(([value, label]) => (
              <button
                key={label}
                onClick={() => onNavigate && onNavigate('collection')}
                style={{
                  background: 'var(--surface-1)', borderRadius: 'var(--radius-md)',
                  padding: '0.9rem 0.5rem', textAlign: 'center', border: 0,
                  cursor: 'pointer', font: 'inherit', color: 'var(--text-primary)',
                  minHeight: 44,
                }}
              >
                <span style={{ display: 'block', fontSize: '1.35rem', fontWeight: 700, letterSpacing: '-0.02em' }}>
                  {value ?? 0}
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

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
    </div>
  );
}

export default Dashboard;
