import { useState, useEffect, useCallback } from 'react';
import { useT } from '../utils/i18n';

// MOXFIELD SYNC PANEL.
//
// Zach builds decks in Moxfield and wants Bindarr to follow them, so he can see
// what he owns versus what he needs to buy.
//
// Mockup 016 put the source badge and coverage on the deck rows themselves;
// this is the surface behind "Check Moxfield" — link an account, see which
// decks have drifted, preview a sync before applying it.
//
// The preview is not optional polish. A sync changes a decklist he plays from,
// and an unpreviewable state change is the thing he objects to most.

function fmtWhen(iso, t) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return t('moxfield.justNow');
  if (mins < 60) return t('moxfield.minsAgo', { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t('moxfield.hoursAgo', { count: hrs });
  return t('moxfield.daysAgo', { count: Math.round(hrs / 24) });
}

function MoxfieldPanel({ onClose, onDecksChanged, showToast }) {
  // useT() returns { locale, setLocale, t } -- an OBJECT, not a function. I
  // assigned the whole object, so every translation call was "t is not a
  // function" and the panel threw the moment it mounted. Every other component
  // here destructures; I wrote the shape I expected instead of reading the one
  // that exists.
  const { t } = useT();
  const [account, setAccount] = useState(null);
  const [username, setUsername] = useState('');
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);      // public_id currently syncing
  const [plan, setPlan] = useState(null);      // { public_id, name, ...plan }
  const [error, setError] = useState(null);

  // App.jsx patches window.fetch to attach the auth header, so a second
  // wrapper here would be a rival source of truth about how this app
  // authenticates -- and mine read localStorage['token'], which is not even the
  // key it uses.
  const authed = useCallback((path, opts = {}) => fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  }), []);

  const loadDecks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authed('/api/moxfield/decks');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t('moxfield.loadFailed'));
      setDecks(body.decks || []);
    } catch (err) {
      // A block and a missing account are different problems with different
      // fixes, so the message must say which. Never a stale list shown as
      // current.
      setError(err.message);
      setDecks([]);
    } finally {
      setLoading(false);
    }
  }, [authed, t]);

  useEffect(() => {
    (async () => {
      const res = await authed('/api/moxfield/account');
      const body = await res.json().catch(() => ({}));
      if (body.account) {
        setAccount(body.account);
        loadDecks();
      } else {
        setLoading(false);
      }
    })();
  }, [authed, loadDecks]);

  const link = async () => {
    const name = username.trim();
    if (!name) return;
    setBusy('link');
    setError(null);
    try {
      const res = await authed('/api/moxfield/account', {
        method: 'POST', body: JSON.stringify({ username: name })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t('moxfield.linkFailed'));
      setAccount(body.account);
      setUsername('');
      loadDecks();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const unlink = async () => {
    await authed('/api/moxfield/account', { method: 'DELETE' });
    setAccount(null);
    setDecks([]);
    // Deliberately not clearing the badge on decks: unlinking should not
    // silently orphan decks he may want to relink.
    showToast?.(t('moxfield.unlinked'));
  };

  const preview = async (deck) => {
    setBusy(deck.public_id);
    setError(null);
    try {
      const res = await authed(`/api/moxfield/decks/${deck.public_id}/plan`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t('moxfield.previewFailed'));
      setPlan({ ...body, public_id: deck.public_id, name: deck.name });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const apply = async (publicId) => {
    setBusy(publicId);
    setError(null);
    try {
      const res = await authed(`/api/moxfield/decks/${publicId}/sync`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t('moxfield.syncFailed'));
      setPlan(null);
      // Say what happened in cards, not row counts. "1404 cards" when he had
      // 2433 was the importer's worst moment.
      showToast?.(t('moxfield.syncedSummary', {
        added: body.added, removed: body.removed,
        moved: body.moved, preferred: body.printing_preferred
      }));
      await loadDecks();
      onDecksChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-overlay" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '1rem', overflowY: 'auto', zIndex: 1000
    }} onClick={onClose}>
      <div className="glass-panel" style={{
        width: '100%', maxWidth: '520px', padding: '1rem', marginTop: '2rem'
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.9rem' }}>
          <h2 style={{ flex: 1, fontSize: '1.05rem', fontWeight: 600 }}>{t('moxfield.title')}</h2>
          <button onClick={onClose} aria-label={t('common.close')} style={{
            background: 'none', border: 'none', color: 'var(--text-secondary)',
            fontSize: '1.4rem', lineHeight: 1, cursor: 'pointer', padding: '0 0.25rem'
          }}>×</button>
        </div>

        {error ? <div className="mfx-error">{error}</div> : null}

        {!account ? (
          <div>
            <p className="mfx-help">{t('moxfield.linkHelp')}</p>
            <div className="mfx-link-row">
              <input
                className="select-control"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') link(); }}
                placeholder={t('moxfield.usernamePlaceholder')}
                aria-label={t('moxfield.usernameLabel')}
              />
              <button className="btn btn-primary" onClick={link} disabled={busy === 'link'}>
                {busy === 'link' ? t('moxfield.linking') : t('moxfield.link')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="mfx-account">
              <span className="mfx-account-name">{account.displayName || account.userName}</span>
              <button className="mfx-unlink" onClick={unlink}>{t('moxfield.unlink')}</button>
            </div>

            {loading ? (
              <p className="mfx-help">{t('moxfield.loading')}</p>
            ) : decks.length === 0 ? (
              <p className="mfx-help">{t('moxfield.noDecks')}</p>
            ) : decks.map(deck => (
              <div className="mfx-deck" key={deck.public_id}>
                <div className="mfx-deck-main">
                  <span className="mfx-deck-name">{deck.name}</span>
                  <span className="mfx-deck-meta">
                    {deck.bindarr_deck_id
                      ? (deck.changed
                          ? t('moxfield.hasChanges')
                          : t('moxfield.upToDate', { when: fmtWhen(deck.last_synced_at, t) || '' }))
                      : t('moxfield.notSynced')}
                  </span>
                </div>
                <button
                  className={deck.bindarr_deck_id && !deck.changed ? 'btn btn-secondary' : 'btn btn-primary'}
                  onClick={() => preview(deck)}
                  disabled={busy === deck.public_id}
                >
                  {busy === deck.public_id
                    ? t('moxfield.checking')
                    : deck.bindarr_deck_id ? t('moxfield.review') : t('moxfield.sync')}
                </button>
              </div>
            ))}
          </>
        )}

        {plan ? (
          <div className="mfx-plan">
            <h3 className="mfx-plan-title">{plan.name}</h3>
            {plan.changes === 0 ? (
              <p className="mfx-help">{t('moxfield.noChanges')}</p>
            ) : (
              <>
                <div className="mfx-chips">
                  {plan.add.length ? <span className="mfx-chip add">{t('moxfield.chipAdd', { count: plan.add.length })}</span> : null}
                  {plan.remove.length ? <span className="mfx-chip rm">{t('moxfield.chipRemove', { count: plan.remove.length })}</span> : null}
                  {plan.moveBoard.length ? <span className="mfx-chip mv">{t('moxfield.chipMove', { count: plan.moveBoard.length })}</span> : null}
                  {plan.requantify.length ? <span className="mfx-chip qty">{t('moxfield.chipQty', { count: plan.requantify.length })}</span> : null}
                </div>
                {/* The reassurance that matters most: his printings survive. */}
                <p className="mfx-help">{t('moxfield.printingsKept', { count: plan.unchanged.length })}</p>

                {plan.add.slice(0, 6).map((c, i) => (
                  <div className="mfx-row" key={`a${i}`}>
                    <span className="mfx-row-name">{c.name}</span>
                    <span className="mfx-row-meta">{String(c.set_id || '').toUpperCase()} #{c.number} · {c.board}</span>
                  </div>
                ))}
                {plan.add.length > 6
                  ? <p className="mfx-help">{t('moxfield.andMore', { count: plan.add.length - 6 })}</p>
                  : null}

                {plan.skipped.length ? (
                  <p className="mfx-warn">{t('moxfield.skipped', { count: plan.skipped.length })}</p>
                ) : null}
              </>
            )}
            <div className="mfx-plan-actions">
              <button className="btn btn-secondary" onClick={() => setPlan(null)}>{t('common.cancel')}</button>
              {plan.changes > 0 ? (
                <button className="btn btn-primary" onClick={() => apply(plan.public_id)}
                        disabled={busy === plan.public_id}>
                  {busy === plan.public_id ? t('moxfield.syncing') : t('moxfield.applyChanges')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default MoxfieldPanel;
