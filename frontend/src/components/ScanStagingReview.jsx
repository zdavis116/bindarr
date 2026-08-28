import { useState, useEffect, useCallback } from 'react';
import { X, RefreshCw, Trash2, AlertTriangle, Check, Search } from 'lucide-react';
import { useT } from '../utils/i18n';
import { sortForReview } from './scanStaging';

// SEARCH FOR A PRINTING when none of the offered candidates is right.
//
// Zach: "allow to search manually just in case its not one of those 3." This is
// the escape hatch that makes the top-3 list safe to keep short -- without it a
// row the matcher got wrong would be stuck, and a stuck row blocks Add All for
// the whole session.
function StagingSearch({ onPick, disabled }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const term = q.trim();
    if (!term) return;
    setBusy(true);
    try {
      const p = new URLSearchParams({ game: 'mtg', lang: 'en', name: term, prints: '1' });
      const res = await fetch(`/api/search?${p.toString()}`);
      setHits(res.ok ? (await res.json()).slice(0, 12) : []);
    } catch {
      setHits([]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <div style={{ display: 'flex', gap: '0.3rem' }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run(); } }}
          placeholder="Card name"
          className="input"
          style={{ flex: 1, minHeight: 38, fontSize: '0.75rem' }}
          disabled={disabled}
        />
        <button
          type="button" className="btn btn-secondary"
          style={{ minHeight: 38, minWidth: 44, fontSize: '0.72rem' }}
          onClick={run} disabled={disabled || busy || !q.trim()}
        >
          {busy ? '…' : 'Go'}
        </button>
      </div>
      {hits.map(h => (
        <button
          key={h.id}
          type="button" className="btn btn-secondary"
          style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.5rem',
            minHeight: 40, textAlign: 'left', justifyContent: 'flex-start', fontSize: '0.72rem',
          }}
          onClick={() => onPick(h.id)}
          disabled={disabled}
        >
          {h.image_url ? (
            <img src={h.image_url} alt="" style={{ width: 24, height: 34, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }} />
          ) : null}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {h.name} · {(h.set_id || '').toUpperCase()} {h.number ? `#${h.number}` : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

// THE SCAN SESSION REVIEW SCREEN: everything scanned, nothing added yet.
//
// Zach: "instead of auto putting in my collection. Just putting aside and at the
// end letting me add all. That way I can ensure no weirdness occurred or ensure
// there isn't any dupes." And on how to present it, he chose flagging over a
// flat list — a sixty-row list gets skimmed, not reviewed.
//
// NOTHING ON THIS SCREEN IS OWNED. These rows live in `scan_staging`, a separate
// table from `collection`, so no query counts them by accident. This screen must
// not undo that by implying otherwise: the header says what will happen, and the
// only way into the collection is the explicit Add All.
//
// THE FLAGGED ROWS COME FIRST. That is the whole design: he should not have to
// hunt for the two rows that need a decision among fifty-eight that do not.

export default function ScanStagingReview({ staging, onClose, onCommitted }) {
  const { t } = useT();
  const [state, setState] = useState(staging.getState());
  const [busyId, setBusyId] = useState(null);
  const [committing, setCommitting] = useState(false);
  // Which unresolved row has its manual search open. One at a time: a phone
  // screen cannot show several open search panels usefully.
  const [searchFor, setSearchFor] = useState(null);
  // A completed commit is reported HERE rather than by closing the screen: a
  // stack of forty cards vanishing with no confirmation is exactly the silent
  // state change Zach does not accept from software tracking physical objects.
  const [result, setResult] = useState(null);

  const sync = useCallback(async () => {
    setState(await staging.refresh());
  }, [staging]);

  // Read from the server on mount. This is what makes the session survive a
  // reload: the screen has no memory of its own to lose.
  useEffect(() => { sync(); }, [sync]);

  const resolve = async (entry, cardId) => {
    setBusyId(entry.id);
    await staging.resolveEntry(entry.id, cardId);
    setBusyId(null);
    setSearchFor(null);
    setState(staging.getState());
  };

  const discard = async (entry) => {
    setBusyId(entry.id);
    await staging.discardEntry(entry.id);
    setBusyId(null);
    setState(staging.getState());
  };

  const setQty = async (entry, quantity) => {
    if (quantity < 1) return;
    setBusyId(entry.id);
    await staging.updateEntry(entry.id, { quantity });
    setBusyId(null);
    setState(staging.getState());
  };

  const commit = async () => {
    setCommitting(true);
    const r = await staging.commitAll();
    setCommitting(false);
    setState(staging.getState());
    if (r.ok) {
      setResult({ ok: true, committed: r.committed });
      if (onCommitted) onCommitted(r.committed);
    } else {
      // The session is still there — the server commits all or nothing — so the
      // screen stays open on a full list with the reason shown.
      setResult(null);
    }
  };

  const { entries, loading, error, unresolvedCount } = state;
  const ordered = sortForReview(entries);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--bg-primary, #12121a)',
      // ABOVE THE APP CHROME. This was zIndex 120 while the global bottom nav
      // is z-index 1000 (index.css) -- so the nav, which is opaque, drew ON TOP
      // of this full-screen overlay and covered exactly the strip where Add All
      // and the per-row buttons live.
      //
      // Zach: "Scanned page is still not functional no add all or you can see
      // some of the other buttons are covered." My previous fix addressed the
      // notch, which was a real bug but NOT this one -- his screenshot shows the
      // app header and the Dashboard/Add Cards/Collection nav rendering over the
      // list, which no amount of safe-area padding can move out of the way.
      //
      // 1100 matches the scanner's own modals in CameraScanner.jsx, which sit
      // above the nav for the same reason.
      zIndex: 1100,
      display: 'flex', flexDirection: 'column',
      // RESPECT THE NOTCH AND THE HOME BAR.
      //
      // Zach: "when you go to the scanned page it needs to be cleaned up the
      // header is overlapping the top and there is no add but at all."
      //
      // Both symptoms, one cause. `inset: 0` on a fixed element covers the
      // WHOLE screen including the iPhone's status bar and home indicator, so
      // the header ran under the notch and the commit bar sat under the home
      // bar -- off-screen far enough that Add All looked absent entirely. It
      // was rendering the whole time; he could not reach it.
      //
      // The rest of the app already handles this (CardImageZoom, the scanner
      // overlays); this screen simply never did. Padding the container rather
      // than each bar keeps the scroll area correct too.
      paddingTop: 'max(env(safe-area-inset-top, 0px), var(--sat, 0px))',
      paddingBottom: 'max(env(safe-area-inset-bottom, 0px), var(--sab, 0px))',
      boxSizing: 'border-box',
    }}>
      {/* Header stays put while the list scrolls, so the way out and the count
          are always reachable on a phone. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '0.5rem', padding: '0.75rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.1)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-strong)' }}>
            {t('scan.stagingTitle', { count: entries.length })}
          </span>
          <span style={{ fontSize: '0.7rem', color: unresolvedCount ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}>
            {unresolvedCount
              ? `${unresolvedCount} need${unresolvedCount === 1 ? 's' : ''} a printing chosen`
              : t('scan.stagingSubtitle')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <button
            type="button" className="btn btn-secondary"
            style={{ padding: '0.45rem', minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={sync} aria-label={t('scan.reviewRefresh')}
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button" className="btn btn-secondary"
            style={{ padding: '0.45rem', minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={onClose} aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 1rem',
          background: 'rgba(239,68,68,0.15)', color: 'var(--accent-red)', fontSize: '0.75rem',
        }}>
          <AlertTriangle size={14} />
          <span>{t('scan.stagingCommitFailed', { error })}</span>
        </div>
      )}

      {result?.ok && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 1rem',
          background: 'rgba(74,222,128,0.15)', color: 'var(--type-grass)', fontSize: '0.75rem',
        }}>
          <Check size={14} /> {t('scan.stagingCommitted', { count: result.committed })}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0.75rem' }}>
        {loading && entries.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            {t('scan.reviewLoading')}
          </p>
        )}

        {!loading && entries.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem', padding: '2rem 1rem' }}>
            {t('scan.stagingEmpty')}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {ordered.map(entry => {
            const isUnresolved = !!entry.unresolved;
            return (
              <div
                key={entry.id}
                className="glass-panel"
                style={{
                  padding: '0.7rem', display: 'flex', gap: '0.7rem', alignItems: 'flex-start',
                  opacity: busyId === entry.id ? 0.5 : 1,
                  // UNRESOLVED IS THE ONLY THING THAT STANDS OUT NOW.
                  //
                  // Zach removed the advisory flags: "The only cards that should
                  // stand out are the ones that unresolved." An outline rather
                  // than a caption, because on a phone the eye finds an edge
                  // before it reads text -- and these are the rows that block
                  // Add All, so he has to be able to spot them while scrolling.
                  border: isUnresolved
                    ? '1px solid var(--accent-yellow)'
                    : '1px solid transparent',
                }}
              >
                {/* The crop he actually photographed. Without it a list of forty
                    rows is forty names with no way to tell which physical card
                    each one was. */}
                {entry.crop ? (
                  <img
                    src={entry.crop} alt=""
                    style={{ width: 52, height: 73, objectFit: 'cover', borderRadius: 6, flexShrink: 0, background: 'rgba(0,0,0,0.4)' }}
                  />
                ) : (
                  <div style={{ width: 52, height: 73, borderRadius: 6, flexShrink: 0, background: 'rgba(255,255,255,0.06)' }} />
                )}

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: isUnresolved ? 'var(--accent-yellow)' : 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {isUnresolved
                      ? (entry.matched_name || 'Unidentified card')
                      : (entry.name || entry.card_id)}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                    {isUnresolved
                      ? 'Which printing is this?'
                      : `${(entry.set_id || '').toUpperCase()} ${entry.number ? `#${entry.number}` : ''} · ${entry.finish}`}
                  </div>

                  {/* THE TOP 3, THEN A SEARCH. Zach: "if we are unsure of the
                      card give the top 3 options and then allow to search
                      manually just in case its not one of those 3."
                      The search matters as much as the options: when the
                      matcher is wrong, restricting him to its guesses would
                      make the row impossible to resolve. */}
                  {isUnresolved && (
                    <div style={{ marginTop: '0.45rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                      {/* THREE, as asked. The row STORES every candidate the
                          matcher found -- truncating in the database would make
                          a fourth-place correct printing reachable only by
                          search -- but a phone row cannot show eight buttons
                          without rebuilding the cluttered screen this replaced.
                          Anything past three is reached via the search below. */}
                      {(entry.candidates || []).slice(0, 3).map(c => (
                        <button
                          key={c.id}
                          type="button"
                          className="btn btn-secondary"
                          style={{
                            display: 'flex', alignItems: 'center', gap: '0.5rem',
                            padding: '0.35rem 0.5rem', minHeight: 40, textAlign: 'left',
                            justifyContent: 'flex-start', fontSize: '0.72rem',
                          }}
                          onClick={() => resolve(entry, c.id)}
                          disabled={busyId === entry.id}
                        >
                          {c.image_url ? (
                            <img src={c.image_url} alt="" style={{ width: 24, height: 34, objectFit: 'cover', borderRadius: 3, flexShrink: 0 }} />
                          ) : null}
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.name} · {(c.set_id || '').toUpperCase()} {c.number ? `#${c.number}` : ''}
                          </span>
                        </button>
                      ))}
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ minHeight: 40, fontSize: '0.72rem', display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'center' }}
                        onClick={() => setSearchFor(searchFor === entry.id ? null : entry.id)}
                        disabled={busyId === entry.id}
                      >
                        <Search size={13} />
                        {(entry.candidates || []).length ? 'None of these — search' : 'Search for this card'}
                      </button>
                      {searchFor === entry.id && (
                        <StagingSearch
                          onPick={(cardId) => resolve(entry, cardId)}
                          disabled={busyId === entry.id}
                        />
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.5rem' }}>
                    <button
                      type="button" className="btn btn-secondary"
                      style={{ minWidth: 34, minHeight: 34, padding: 0 }}
                      onClick={() => setQty(entry, entry.quantity - 1)}
                      disabled={entry.quantity <= 1 || busyId === entry.id}
                      aria-label={t('scan.stagingQtyDown')}
                    >−</button>
                    <span style={{ fontSize: '0.8rem', minWidth: 22, textAlign: 'center', color: 'var(--text-strong)' }}>
                      {entry.quantity}
                    </span>
                    <button
                      type="button" className="btn btn-secondary"
                      style={{ minWidth: 34, minHeight: 34, padding: 0 }}
                      onClick={() => setQty(entry, entry.quantity + 1)}
                      disabled={busyId === entry.id}
                      aria-label={t('scan.stagingQtyUp')}
                    >+</button>

                    <button
                      type="button" className="btn btn-secondary"
                      style={{ marginLeft: 'auto', minWidth: 34, minHeight: 34, padding: 0, color: 'var(--accent-red)' }}
                      onClick={() => discard(entry)}
                      disabled={busyId === entry.id}
                      aria-label={t('scan.stagingDiscardOne')}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* THE COMMIT BAR. Fixed to the bottom so "Add All" is reachable with a
          thumb after scrolling a long session, and labelled with the COUNT so
          the button says exactly what it is about to do to the collection. */}
      {entries.length > 0 && (
        <div style={{
          flexShrink: 0, padding: '0.75rem', borderTop: '1px solid rgba(255,255,255,0.1)',
          display: 'flex', gap: '0.5rem', alignItems: 'center',
          // The container now owns the safe-area inset, so this bar just needs
          // ordinary padding -- adding it twice would float it above the home
          // bar with a visible gap.
          paddingBottom: '0.75rem',
        }}>
          <button
            type="button" className="btn btn-secondary"
            style={{ minHeight: 46 }}
            onClick={async () => {
              setCommitting(true);
              await staging.discardAll();
              setCommitting(false);
              setState(staging.getState());
            }}
            disabled={committing}
          >
            {t('scan.stagingDiscardAll')}
          </button>
          {/* ADD ALL IS BLOCKED WHILE ANYTHING IS UNRESOLVED, and says so.
              Zach chose this over committing the resolved rows and leaving the
              rest: a partial commit empties the list halfway, and a stack that
              half-disappears is exactly the silent state change he does not
              accept from software tracking physical cardboard.
              The server enforces the same rule (409 unresolved_entries) -- this
              button is the explanation, not the guard. */}
          <button
            type="button" className="btn btn-primary"
            style={{ flex: 1, minHeight: 46, fontWeight: 700 }}
            onClick={commit}
            disabled={committing || unresolvedCount > 0}
          >
            {committing
              ? t('scan.stagingAdding')
              : unresolvedCount > 0
                ? `${unresolvedCount} card${unresolvedCount === 1 ? '' : 's'} need a printing`
                : t('scan.stagingAddAll', { count: entries.length })}
          </button>
        </div>
      )}
    </div>
  );
}
