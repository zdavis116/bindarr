import { useState, useEffect, useCallback } from 'react';
import { X, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import { useT } from '../utils/i18n';
import { getPrintings } from '../utils/cardOptions';
import { describeReason } from './scanReviewQueue';

// The review queue screen: every scanned card whose exact printing we could not
// determine, waiting for one tap.
//
// WHY THIS SCREEN EXISTS AT ALL. Scanning identifies the CARD reliably (12/12
// measured) but not the PRINTING, because the scan index is built from
// Scryfall's unique_artwork bulk — one row per illustration, so a C21 Sol Ring
// and a CMM Sol Ring are the same entry. Guessing a printing would put a card
// Zach does not own into availability, buylists and deck matching, with no way
// to reconcile it against the physical shoebox later. So unresolved scans wait
// here instead, and he decides.
//
// A CARD ON THIS SCREEN IS NOT OWNED. It lives in `scan_review_queue`, a
// separate table from `collection` — not a flag on it — so no query can count
// it by accident. This screen must not undo that by showing these in any total.
//
// ONE TAP IS THE DESIGN TARGET. Candidates arrive pre-sorted owned-first from
// the server, so the printing he is holding is usually the first row. Tapping a
// candidate resolves the entry outright; nothing here asks a second question in
// the common case. Finish defaults to the app default and is CHOSEN, never
// inferred from the photo — surge foils share artwork with normal printings, so
// no image can tell them apart.

export default function ScanReviewQueue({ queue, onClose, onResolved }) {
  const { t } = useT();
  const [state, setState] = useState(queue.getState());
  // Which entry is mid-request. Kept per-entry rather than as one global flag so
  // a slow resolve greys out only the row he tapped.
  const [busyId, setBusyId] = useState(null);
  // Finish is per-entry and defaults to nonfoil, matching the rest of the app.
  // It is NEVER derived from the crop.
  const [finishByEntry, setFinishByEntry] = useState({});

  const sync = useCallback(async () => {
    setState(await queue.refresh());
  }, [queue]);

  // Read from the server on mount. This is what makes the queue survive a
  // reload: the screen has no memory of its own to lose.
  useEffect(() => { sync(); }, [sync]);

  const resolve = async (entry, candidate) => {
    setBusyId(entry.id);
    const result = await queue.resolveEntry(entry.id, {
      card_id: candidate.id,
      printing: finishByEntry[entry.id] || 'nonfoil',
      quantity: 1,
    });
    setBusyId(null);
    setState(queue.getState());
    if (result.ok && onResolved) onResolved(candidate);
  };

  const discard = async (entry) => {
    setBusyId(entry.id);
    await queue.discardEntry(entry.id);
    setBusyId(null);
    setState(queue.getState());
  };

  const { entries, loading, error } = state;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 120, background: 'var(--bg-primary, #12121a)',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header stays put while the list scrolls, so the way out is always
          reachable on a phone. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '0.5rem', padding: '0.75rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.1)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-strong)' }}>
            {t('scan.reviewTitle')}
          </span>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
            {t('scan.reviewSubtitle')}
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
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: '0.75rem' }}>
        {loading && entries.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            {t('scan.reviewLoading')}
          </p>
        )}

        {/* An empty queue is a GOOD outcome, not an error state: it means every
            card scanned resolved to exactly one printing. */}
        {!loading && entries.length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem', padding: '2rem 1rem' }}>
            {t('scan.reviewEmpty')}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {entries.map(entry => (
            <div
              key={entry.id}
              className="glass-panel"
              style={{
                padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem',
                opacity: busyId === entry.id ? 0.5 : 1,
              }}
            >
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                {/* The crop he actually photographed. Without it a queue of 40
                    entries is 40 names with no way to tell which physical card
                    each one was. */}
                {entry.crop ? (
                  <img
                    src={entry.crop} alt=""
                    style={{ width: 64, height: 89, objectFit: 'cover', borderRadius: 6, flexShrink: 0, background: 'rgba(0,0,0,0.4)' }}
                  />
                ) : (
                  <div style={{ width: 64, height: 89, borderRadius: 6, flexShrink: 0, background: 'rgba(255,255,255,0.06)' }} />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {entry.matched_name}
                  </div>
                  {/* WHY it is here. The three reasons need different reactions:
                      a rescan can fix glare but cannot make a 2003 frame print a
                      number it never had. */}
                  <div style={{ fontSize: '0.7rem', color: 'var(--accent-yellow)', marginTop: '0.2rem' }}>
                    {describeReason(entry.reason)}
                  </div>
                  {entry.ocr?.number && (
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                      {t('scan.reviewRead', { number: entry.ocr.number, set: (entry.ocr.set || '?').toUpperCase() })}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => discard(entry)}
                  disabled={busyId === entry.id}
                  aria-label={t('scan.reviewDiscard')}
                  style={{
                    background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
                    minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>

              {/* Finish is an explicit choice, never read from pixels.
                  Options come from getPrintings(), so a card never printed in
                  foil does not offer one — recording a finish that does not
                  physically exist would put an unbuyable variant into deck
                  matching and buylists (the failure PR 7 fixed).
                  The candidates of one queue entry are all printings of the
                  same card but not the same product, so the offered finishes
                  are taken from the FIRST candidate as a display default; the
                  server re-validates whatever is submitted. */}
              <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  {t('scan.reviewFinish')}
                </span>
                {getPrintings(entry.candidates[0]?.finishes).map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setFinishByEntry(prev => ({ ...prev, [entry.id]: opt.value }))}
                    style={{
                      fontSize: '0.65rem', fontWeight: 700, padding: '0.3rem 0.55rem', minHeight: 32,
                      borderRadius: 999, cursor: 'pointer',
                      border: (finishByEntry[entry.id] || 'nonfoil') === opt.value
                        ? '1px solid var(--accent-red)' : '1px solid rgba(255,255,255,0.18)',
                      background: (finishByEntry[entry.id] || 'nonfoil') === opt.value
                        ? 'var(--accent-red)' : 'transparent',
                      color: (finishByEntry[entry.id] || 'nonfoil') === opt.value
                        ? '#fff' : 'var(--text-secondary)',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {/* THE CANDIDATES, IN THE SERVER'S ORDER — owned printings first.
                  Not re-sorted here: the server's banding is what makes the
                  first row usually correct, and a tap on it the whole
                  interaction. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {entry.candidates.length === 0 && (
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    {t('scan.reviewNoCandidates')}
                  </span>
                )}
                {entry.candidates.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => resolve(entry, c)}
                    disabled={busyId === entry.id}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem',
                      width: '100%', minHeight: 44, padding: '0.5rem 0.65rem', textAlign: 'left',
                      background: c.owned_qty > 0 ? 'rgba(74,222,128,0.12)' : 'rgba(255,255,255,0.05)',
                      border: c.owned_qty > 0 ? '1px solid rgba(74,222,128,0.35)' : '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)',
                      fontSize: '0.72rem', cursor: 'pointer',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.set_name || c.set_id} · #{c.number}
                    </span>
                    {/* "You already own N of this printing" is the strongest hint
                        available that this is the card in his hand. */}
                    {c.owned_qty > 0 && (
                      <span style={{ color: 'var(--type-grass)', fontWeight: 700, flexShrink: 0 }}>
                        {t('scan.reviewOwned', { qty: c.owned_qty })}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
