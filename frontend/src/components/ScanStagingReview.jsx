import { useState, useEffect, useCallback } from 'react';
import { X, RefreshCw, Trash2, AlertTriangle, Check, Copy, Layers } from 'lucide-react';
import { useT } from '../utils/i18n';
import { describeFlag, sortForReview } from './scanStaging';

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

const FLAG_ICON = {
  low_confidence: AlertTriangle,
  duplicate_in_session: Copy,
  already_owned: Layers,
};

// low_confidence is red because it questions whether this is even the right
// card. The other two are amber: they are worth seeing, but "you already own
// one" is a perfectly normal thing for a collector to do on purpose.
const FLAG_COLOR = {
  low_confidence: 'var(--accent-red)',
  duplicate_in_session: 'var(--accent-yellow)',
  already_owned: 'var(--accent-yellow)',
};

export default function ScanStagingReview({ staging, onClose, onCommitted }) {
  const { t } = useT();
  const [state, setState] = useState(staging.getState());
  const [busyId, setBusyId] = useState(null);
  const [committing, setCommitting] = useState(false);
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

  const { entries, loading, error, flaggedCount } = state;
  const ordered = sortForReview(entries);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 120, background: 'var(--bg-primary, #12121a)',
      display: 'flex', flexDirection: 'column',
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
          <span style={{ fontSize: '0.7rem', color: flaggedCount ? 'var(--accent-yellow)' : 'var(--text-secondary)' }}>
            {flaggedCount
              ? t('scan.stagingFlagged', { count: flaggedCount })
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
            const Icon = entry.flag ? FLAG_ICON[entry.flag] : null;
            const flagText = describeFlag(entry.flag);
            return (
              <div
                key={entry.id}
                className="glass-panel"
                style={{
                  padding: '0.7rem', display: 'flex', gap: '0.7rem', alignItems: 'flex-start',
                  opacity: busyId === entry.id ? 0.5 : 1,
                  // Flagged rows are outlined, not just annotated: on a phone
                  // the eye finds an edge before it reads a caption.
                  border: entry.flag
                    ? `1px solid ${FLAG_COLOR[entry.flag] || 'var(--accent-yellow)'}`
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
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {entry.name || entry.card_id}
                  </div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                    {(entry.set_id || '').toUpperCase()} {entry.number ? `#${entry.number}` : ''} · {entry.finish}
                  </div>

                  {flagText && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.3rem',
                      fontSize: '0.68rem', color: FLAG_COLOR[entry.flag] || 'var(--accent-yellow)',
                    }}>
                      {Icon ? <Icon size={12} style={{ flexShrink: 0 }} /> : null}
                      <span>{flagText}</span>
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
          paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
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
          <button
            type="button" className="btn btn-primary"
            style={{ flex: 1, minHeight: 46, fontWeight: 700 }}
            onClick={commit}
            disabled={committing}
          >
            {committing
              ? t('scan.stagingAdding')
              : t('scan.stagingAddAll', { count: entries.length })}
          </button>
        </div>
      )}
    </div>
  );
}
