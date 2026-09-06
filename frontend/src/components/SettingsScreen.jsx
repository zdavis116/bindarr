// SETTINGS -- built to the approved mockup (sketches/007-settings).
//
// Six sections of plain rows: Data sources, Card catalogue, Collection,
// Backup, Sharing & security, About. The mock's value is what it leaves out --
// the previous screen was 933 lines of panels, forms and inline state.
//
// Zach, on the mock: Moxfield is HIDDEN until it exists ("You can hide the
// moxfield decks for now until implemented"), and there is no include-tokens
// toggle ("we don't need an include tokens toggle") -- tokens are excluded as
// a rule, not a preference.
//
// EVERY FIGURE ON THIS SCREEN COMES FROM THE SERVER. The catalogue count and
// build date are read from GET /api/settings/catalogue, which was added for
// this screen. A settings page that reports a guessed catalogue size is worse
// than one that says nothing: it is the page you check when you suspect the
// catalogue is stale.
import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronRight, Upload, Download, RefreshCw, Key, Link2, Shield, Info } from 'lucide-react';
import { useT } from '../utils/i18n';
import { Z_BACKDROP, Z_MODAL } from '../utils/zLayers';

// One row. Everything on this screen is a row: label, optional detail line,
// and either a chevron (opens something) or a value (states a fact).
function Row({ icon: Icon, label, detail, value, onClick, disabled, danger, expanded, indent }) {
  const interactive = Boolean(onClick) && !disabled;
  const Tag = interactive ? 'button' : 'div';
  return (
    <Tag
      {...(interactive ? { onClick, type: 'button' } : {})}
      style={{
        display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%',
        minHeight: 56, padding: indent ? '0.7rem 1rem 0.7rem 2.6rem' : '0.7rem 1rem',
        border: 0, textAlign: 'left',
        background: 'transparent', font: 'inherit',
        color: danger ? 'var(--accent-red)' : 'var(--text-primary)',
        cursor: interactive ? 'pointer' : 'default',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {Icon && <Icon size={17} style={{ flexShrink: 0, color: danger ? 'var(--accent-red)' : 'var(--text-muted)' }} />}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: '0.95rem', fontWeight: 500 }}>{label}</span>
        {detail && (
          <span style={{ display: 'block', fontSize: '0.76rem', color: 'var(--text-muted)',
                         marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden',
                         textOverflow: 'ellipsis' }}>
            {detail}
          </span>
        )}
      </span>
      {value && (
        <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', flexShrink: 0 }}>
          {value}
        </span>
      )}
      {interactive && (
        <ChevronRight
          size={16}
          style={{
            opacity: 0.35, flexShrink: 0,
            // Rotated when open: the same glyph means "goes somewhere" when it
            // points right and "expands here" when it points down.
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms ease',
          }}
        />
      )}
    </Tag>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.06em',
                    textTransform: 'uppercase', color: 'var(--text-muted)',
                    padding: '0 1rem 0.4rem' }}>
        {title}
      </div>
      <div style={{ background: 'var(--surface-1)', borderRadius: 'var(--radius-md)',
                    overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

// Thousands separators, using the user's locale rather than a hardcoded comma.
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

// A date, or an honest dash. NEVER "just now" or a guess.
function when(iso, t) {
  if (!iso) return t('settings.never');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? t('settings.never') : d.toLocaleDateString();
}

function SettingsScreen({ user, onNavigate, showToast }) {
  const { t } = useT();
  const [catalogue, setCatalogue] = useState(null);
  const [version, setVersion] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // Which source has its detail open. One at a time -- a phone screen
  // cannot show two expanded sources usefully.
  const [sourceOpen, setSourceOpen] = useState(null);
  const importRef = useRef(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [saving, setSaving] = useState(false);

  // MOXFIELD, the second data source.
  //
  // Zach: "there is technically 2 syncs with moxfield. The deck list sync and
  // then the individual deck syncs." The ACCOUNT-level sync is configuration --
  // which account, how often, check now -- and belongs here. The DECK-level
  // sync stays on the deck list, where the deck is.
  const [mox, setMox] = useState({ account: null, decks: [], loading: true, error: null });
  const [linkOpen, setLinkOpen] = useState(false);
  const [moxUser, setMoxUser] = useState('');
  const [moxBusy, setMoxBusy] = useState(null);   // 'link' | 'check' | 'unlink'

  // useCallback so the mount effect can depend on it honestly rather than
  // silencing the lint rule. A stale closure here would show a linked account's
  // decks after an unlink.
  const loadMoxfield = useCallback(async () => {
    try {
      const res = await fetch('/api/moxfield/account');
      const body = await res.json().catch(() => ({}));
      if (!body.account) {
        setMox({ account: null, decks: [], loading: false, error: null });
        return;
      }
      // The deck list is a live Moxfield call and can fail on its own while the
      // account is perfectly fine. Those are different problems, so the row
      // must not report one as the other -- and must never show an empty list
      // as though the account genuinely had no decks.
      let decks = [];
      let error = null;
      try {
        const dres = await fetch('/api/moxfield/decks');
        const dbody = await dres.json().catch(() => ({}));
        if (dres.ok) decks = dbody.decks || [];
        else error = dbody.error || t('settings.moxUnreachable');
      } catch {
        error = t('settings.moxUnreachable');
      }
      setMox({ account: body.account, decks, loading: false, error });
    } catch {
      setMox({ account: null, decks: [], loading: false, error: t('settings.moxUnreachable') });
    }
  }, [t]);


  const changePassword = async () => {
    if (!pw.current || !pw.next) {
      showToast(t('settings.errCurrentPassword'), 'error');
      return;
    }
    if (pw.next !== pw.confirm) {
      showToast(t('settings.errPasswordMatch'), 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // The field is `password`, not `new_password` (auth.js:127).
        body: JSON.stringify({ current_password: pw.current, password: pw.next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || t('settings.errPasswordUpdate'));
      showToast(t('settings.passwordUpdated'), 'success');
      setPasswordOpen(false);
      setPw({ current: '', next: '', confirm: '' });
    } catch (err) {
      showToast(err.message || t('settings.errPasswordUpdate'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const loadCatalogue = async () => {
    try {
      const res = await fetch('/api/settings/catalogue');
      if (res.ok) setCatalogue(await res.json());
    } catch { /* the row shows a dash rather than a wrong number */ }
  };

  useEffect(() => {
    loadCatalogue();
    loadMoxfield();
    (async () => {
      try {
        const res = await fetch('/api/settings/version');
        if (res.ok) setVersion(await res.json());
      } catch { /* About shows the dash */ }
    })();
  }, [loadMoxfield]);

  const checkUpdate = async () => {
    try {
      const res = await fetch('/api/settings/version?check=1');
      const data = await res.json();
      if (data.check_failed) showToast(t('settings.updateNoGithub'));
      else if (data.update_available) showToast(t('settings.updateAvailable', { version: data.latest }));
      else showToast(t('settings.updateLatest'));
    } catch {
      showToast(t('settings.updateNoServer'));
    }
  };

  const exportCollection = () => {
    // A plain navigation, so the browser handles the download rather than the
    // app buffering a whole collection in memory.
    window.location.href = '/api/export?format=csv';
  };

  const linkMoxfield = async () => {
    const name = moxUser.trim();
    if (!name) return;
    setMoxBusy('link');
    try {
      const res = await fetch('/api/moxfield/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name }),
      });
      const body = await res.json().catch(() => ({}));
      // A 503 is Cloudflare blocking us, a 404 is a username that does not
      // exist. Opposite reactions, so the message has to say which.
      if (!res.ok) throw new Error(body.error || t('settings.moxLinkFailed'));
      setMoxUser('');
      setLinkOpen(false);
      await loadMoxfield();
      showToast(t('settings.moxLinked'), 'success');
    } catch (err) {
      showToast(err.message || t('settings.moxLinkFailed'), 'error');
    } finally {
      setMoxBusy(null);
    }
  };

  const checkMoxfield = async () => {
    setMoxBusy('check');
    try {
      const res = await fetch('/api/moxfield/check', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || t('settings.moxUnreachable'));
      // Say what was found, including "nothing". A check that reports only on
      // success trains him to distrust the silence.
      showToast(body.changed
        ? t('settings.moxCheckedChanged', { count: body.changed })
        : t('settings.moxCheckedClean', { count: body.checked }));
      await loadMoxfield();
    } catch (err) {
      showToast(err.message || t('settings.moxUnreachable'), 'error');
    } finally {
      setMoxBusy(null);
    }
  };

  const unlinkMoxfield = async () => {
    // Destructive-sounding but not destructive: the decks stay. Saying so is
    // the point -- an unexplained "Unlink" reads like "delete my decks".
    if (!window.confirm(t('settings.moxUnlinkConfirm'))) return;
    setMoxBusy('unlink');
    try {
      const res = await fetch('/api/moxfield/account', { method: 'DELETE' });
      if (!res.ok) throw new Error(t('settings.moxUnlinkFailed'));
      await loadMoxfield();
      showToast(t('settings.moxUnlinked'));
    } catch (err) {
      showToast(err.message || t('settings.moxUnlinkFailed'), 'error');
    } finally {
      setMoxBusy(null);
    }
  };

  return (
    <div style={{ paddingBottom: '2rem' }}>
      <h2 style={{ fontSize: '1.6rem', fontWeight: 700, letterSpacing: '-0.02em',
                   margin: '0 0 1.2rem', padding: '0 0.25rem' }}>
        {t('nav.settings')}
      </h2>

      {/* DATA SOURCES. Each source expands to show what it actually syncs --
          Scryfall syncs CARDS, and one day Moxfield will sync DECKS. The
          catalogue rows are that detail, not a separate subject.

          Moxfield is deliberately absent until the integration exists: showing
          a source that cannot be connected invites "why doesn't this work". */}
      <Section title={t('settings.secDataSources')}>
        <Row
          icon={Link2}
          label={t('settings.scryfall')}
          detail={catalogue
            ? t('settings.scryfallSyncs', { count: fmt(catalogue.cards) })
            : t('settings.loading')}
          expanded={sourceOpen === 'scryfall'}
          onClick={() => setSourceOpen(sourceOpen === 'scryfall' ? null : 'scryfall')}
        />

        {sourceOpen === 'scryfall' && (
          <div style={{ background: 'var(--surface-2)' }}>
            <Row
              indent
              label={t('settings.lastRefreshed')}
              detail={catalogue?.scryfall_build
                ? t('settings.scryfallBuild', { build: when(catalogue.scryfall_build, t) })
                : undefined}
              value={catalogue ? when(catalogue.refreshed_at, t) : '—'}
            />
            <Row
              indent
              label={t('settings.automatic')}
              detail={t('settings.automaticDetail')}
              value={t('settings.on')}
            />
            <Row
              indent
              icon={RefreshCw}
              label={refreshing ? t('settings.refreshing') : t('settings.refreshNow')}
              detail={t('settings.refreshDetail')}
              disabled={refreshing || Boolean(catalogue?.running_since)}
              onClick={async () => {
                setRefreshing(true);
                try {
                  const res = await fetch('/api/admin/refresh-catalogue', { method: 'POST' });
                  showToast(res.ok ? t('settings.refreshStarted') : t('settings.refreshFailed'));
                } catch {
                  showToast(t('settings.refreshFailed'));
                } finally {
                  setRefreshing(false);
                  loadCatalogue();
                }
              }}
            />
          </div>
        )}

        {/* MOXFIELD, the second source. Same expand pattern as Scryfall,
            because Zach's own rule was "each data source should have a drop
            down showing details of what it's syncing. Scryfall being cards and
            moxfield being decks as the example."

            ACCOUNT-level sync only. The per-deck sync lives on the deck list --
            two syncs, two homes, no third surface. */}
        <Row
          icon={Link2}
          label={t('settings.moxfield')}
          detail={mox.loading
            ? t('settings.loading')
            : mox.account
              ? t('settings.moxSyncs', { count: mox.decks.length })
              : t('settings.moxNotLinked')}
          expanded={sourceOpen === 'moxfield'}
          onClick={() => setSourceOpen(sourceOpen === 'moxfield' ? null : 'moxfield')}
        />

        {sourceOpen === 'moxfield' && (
          <div style={{ background: 'var(--surface-2)' }}>
            {!mox.account ? (
              <>
                {/* THE ONLY PLACE AN ACCOUNT CAN BE LINKED. The deck-list modal
                    used to own this; deleting it without this row would leave
                    the integration unreachable from a fresh install. */}
                <Row
                  indent
                  label={t('settings.moxLink')}
                  detail={t('settings.moxLinkDetail')}
                  onClick={() => setLinkOpen(true)}
                />
              </>
            ) : (
              <>
                <Row
                  indent
                  label={t('settings.moxAccount')}
                  value={mox.account.display_name || mox.account.username}
                />
                {/* LAST CHECKED, and the error if the last check failed. A
                    stale timestamp shown as current is the silent state change
                    he rules out -- last_error is why the number is old. */}
                <Row
                  indent
                  label={t('settings.moxLastChecked')}
                  detail={mox.account.last_error
                    ? t('settings.moxLastError', { error: mox.account.last_error })
                    : undefined}
                  value={when(mox.account.last_checked_at, t)}
                />
                <Row
                  indent
                  label={t('settings.moxAutomatic')}
                  detail={t('settings.moxAutomaticDetail')}
                  value={t('settings.on')}
                />
                <Row
                  indent
                  icon={RefreshCw}
                  label={moxBusy === 'check' ? t('settings.moxChecking') : t('settings.moxCheckNow')}
                  detail={t('settings.moxCheckDetail')}
                  disabled={Boolean(moxBusy)}
                  onClick={checkMoxfield}
                />
                {/* How syncing works -- from the mock. This is the sentence that
                    stops "will syncing overwrite my printings?" being a
                    question he has to test to answer. */}
                <Row indent label={t('settings.moxHowTitle')} detail={t('settings.moxHowDetail')} />
                {mox.error ? (
                  <Row indent danger label={t('settings.moxUnreachable')} detail={mox.error} />
                ) : null}
                <Row
                  indent
                  danger
                  label={t('settings.moxUnlink')}
                  detail={t('settings.moxUnlinkDetail')}
                  disabled={Boolean(moxBusy)}
                  onClick={unlinkMoxfield}
                />
              </>
            )}
          </div>
        )}
      </Section>

      <Section title={t('settings.secCollection')}>
        <Row
          icon={Upload}
          label={t('settings.importCards')}
          detail={t('settings.importDetail')}
          onClick={() => importRef.current?.click()}
        />
        <Row
          icon={Download}
          label={t('settings.exportCollection')}
          detail={t('settings.exportDetail')}
          onClick={exportCollection}
        />
      </Section>

      <Section title={t('settings.secSecurity')}>
        <Row
          icon={Key}
          label={t('settings.changePassword')}
          onClick={() => setPasswordOpen(true)}
        />
      </Section>

      <Section title={t('settings.secAbout')}>
        <Row label={t('settings.version')} value={version?.version || '—'} />
        <Row
          icon={Info}
          label={t('settings.checkUpdates')}
          onClick={checkUpdate}
        />
        {user?.role === 'admin' && (
          <Row
            icon={Shield}
            label={t('settings.adminPanel')}
            detail={t('settings.adminDetail')}
            onClick={() => onNavigate && onNavigate('admin')}
          />
        )}
      </Section>

      {/* CHANGE PASSWORD */}
      {passwordOpen && (
        <>
          <div onClick={() => setPasswordOpen(false)}
               style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: Z_BACKDROP }} />
          <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: Z_MODAL,
                        background: 'var(--surface-1)', borderTopLeftRadius: 20,
                        borderTopRightRadius: 20, padding: '0.6rem 1rem 1rem',
                        paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}>
            <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--surface-3)',
                          margin: '4px auto 12px' }} />
            <b style={{ fontSize: '1rem', display: 'block', marginBottom: '0.8rem' }}>
              {t('settings.changePassword')}
            </b>

            {[
              ['current', t('settings.currentPassword')],
              ['next', t('settings.newPassword')],
              ['confirm', t('settings.confirmPassword')],
            ].map(([key, label]) => (
              <input
                key={key}
                type="password"
                value={pw[key]}
                onChange={(e) => setPw({ ...pw, [key]: e.target.value })}
                placeholder={label}
                aria-label={label}
                autoComplete={key === 'current' ? 'current-password' : 'new-password'}
                style={{ width: '100%', minHeight: 46, marginBottom: '0.55rem',
                         padding: '0 0.85rem', borderRadius: 'var(--radius-md)',
                         border: '1px solid var(--border-glass)', background: 'var(--surface-2)',
                         color: 'var(--text-primary)', font: 'inherit', fontSize: '0.92rem',
                         boxSizing: 'border-box' }}
              />
            ))}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
              <button onClick={() => setPasswordOpen(false)}
                style={{ flex: 1, minHeight: 46, border: 0, borderRadius: 'var(--radius-md)',
                         background: 'var(--surface-3)', color: 'var(--text-primary)',
                         font: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
                {t('common.cancel')}
              </button>
              <button onClick={changePassword} disabled={saving}
                style={{ flex: 1, minHeight: 46, border: 0, borderRadius: 'var(--radius-md)',
                         background: 'var(--accent-blue)', color: '#fff',
                         font: 'inherit', fontWeight: 600,
                         cursor: saving ? 'wait' : 'pointer' }}>
                {saving ? t('settings.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </>
      )}

      {/* LINK MOXFIELD. Same bottom sheet as Change password, because it is the
          same job: one field, two buttons, no navigation away. */}
      {linkOpen && (
        <>
          <div onClick={() => setLinkOpen(false)}
               style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: Z_BACKDROP }} />
          <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: Z_MODAL,
                        background: 'var(--surface-1)', borderTopLeftRadius: 20,
                        borderTopRightRadius: 20, padding: '0.6rem 1rem 1rem',
                        paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}>
            <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--surface-3)',
                          margin: '4px auto 12px' }} />
            <b style={{ fontSize: '1rem', display: 'block', marginBottom: '0.4rem' }}>
              {t('settings.moxLink')}
            </b>
            {/* Public decks only -- said BEFORE he links, not discovered after
                his private decks fail to appear. */}
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0 0 0.8rem' }}>
              {t('settings.moxLinkHelp')}
            </p>
            <input
              value={moxUser}
              onChange={(e) => setMoxUser(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') linkMoxfield(); }}
              placeholder={t('settings.moxUsernamePlaceholder')}
              aria-label={t('settings.moxUsernameLabel')}
              autoComplete="off"
              style={{ width: '100%', minHeight: 46, marginBottom: '0.55rem',
                       padding: '0 0.85rem', borderRadius: 'var(--radius-md)',
                       border: '1px solid var(--border-glass)', background: 'var(--surface-2)',
                       color: 'var(--text-primary)', font: 'inherit', fontSize: '0.92rem',
                       boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem' }}>
              <button onClick={() => setLinkOpen(false)}
                style={{ flex: 1, minHeight: 46, border: 0, borderRadius: 'var(--radius-md)',
                         background: 'var(--surface-3)', color: 'var(--text-primary)',
                         font: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
                {t('common.cancel')}
              </button>
              <button onClick={linkMoxfield} disabled={moxBusy === 'link' || !moxUser.trim()}
                style={{ flex: 1, minHeight: 46, border: 0, borderRadius: 'var(--radius-md)',
                         background: 'var(--accent-blue)', color: '#fff',
                         font: 'inherit', fontWeight: 600,
                         cursor: moxBusy === 'link' ? 'wait' : 'pointer' }}>
                {moxBusy === 'link' ? t('settings.moxLinking') : t('settings.moxLink')}
              </button>
            </div>
          </div>
        </>
      )}

      <input
        ref={importRef}
        type="file"
        accept=".csv,.txt"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onNavigate && onNavigate('import', file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

export default SettingsScreen;
