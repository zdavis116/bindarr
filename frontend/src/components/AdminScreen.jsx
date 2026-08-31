// ADMINISTRATION -- built to the approved mockup (sketches/008-admin).
//
// Three sections: Users, Instance, Maintenance. The old panel was 1,108 lines
// covering per-set ORB index building, a set browser, global index rebuilds
// and audit logs.
//
// MEASURED BEFORE CUTTING, on dev:
//   users            1
//   audit_logs       0 rows
//   set_indexes      no such table -- per-set builds live on disk, and there
//                    are NONE: /var/lib/bindarr-dev/index holds only the five
//                    global mtg-* files the scanner actually uses.
//
// So the per-set index tooling is real machinery that has never produced a
// build. It is NOT deleted from the backend -- the routes and setIndex module
// stay, and the scanner still reads the global index it maintains. What goes
// is the UI for driving it by hand, which is what the mock says.
//
// If Zach ever needs per-set builds, the routes are there and the screen can
// grow a row. Removing a control is reversible; a wrong record is not.
import { useState, useEffect } from 'react';
import { ChevronRight, UserPlus, RefreshCw, Trash2, Shield } from 'lucide-react';
import { useT } from '../utils/i18n';
import { Z_BACKDROP, Z_MODAL } from '../utils/zLayers';

function Row({ icon: Icon, label, detail, value, onClick, danger, disabled }) {
  const interactive = Boolean(onClick) && !disabled;
  const Tag = interactive ? 'button' : 'div';
  return (
    <Tag
      {...(interactive ? { onClick, type: 'button' } : {})}
      style={{
        display: 'flex', alignItems: 'center', gap: '0.75rem', width: '100%',
        minHeight: 56, padding: '0.7rem 1rem', border: 0, textAlign: 'left',
        background: 'transparent', font: 'inherit',
        color: danger ? 'var(--accent-red)' : 'var(--text-primary)',
        cursor: interactive ? 'pointer' : 'default',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {Icon && <Icon size={17} style={{ flexShrink: 0,
                 color: danger ? 'var(--accent-red)' : 'var(--text-muted)' }} />}
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
      {interactive && <ChevronRight size={16} style={{ opacity: 0.35, flexShrink: 0 }} />}
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

function AdminScreen({ user, showToast }) {
  const { t } = useT();
  const [users, setUsers] = useState([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [catalogue, setCatalogue] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({ username: '', password: '', role: 'user' });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [u, s, c] = await Promise.all([
        fetch('/api/admin/users'),
        fetch('/api/settings'),
        fetch('/api/settings/catalogue'),
      ]);
      if (u.ok) setUsers(await u.json());
      if (s.ok) setBaseUrl((await s.json()).public_base_url || '');
      if (c.ok) setCatalogue(await c.json());
    } catch { /* rows show dashes rather than invented values */ }
  };

  useEffect(() => { load(); }, []);

  const addUser = async () => {
    if (!draft.username.trim() || !draft.password) {
      showToast(t('admin.errUserFields'), 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || t('admin.errAddUser'));
      showToast(t('admin.userAdded', { name: draft.username }), 'success');
      setAddOpen(false);
      setDraft({ username: '', password: '', role: 'user' });
      load();
    } catch (err) {
      showToast(err.message || t('admin.errAddUser'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeUser = async (u) => {
    // Deleting a user takes their collection with them. A confirm naming the
    // person is the least this can do -- and the current admin is never
    // offered the option at all.
    if (!window.confirm(t('admin.confirmDeleteUser', { name: u.username }))) return;
    try {
      const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || t('admin.errDeleteUser'));
      }
      showToast(t('admin.userDeleted', { name: u.username }), 'success');
      load();
    } catch (err) {
      showToast(err.message || t('admin.errDeleteUser'), 'error');
    }
  };

  const saveBaseUrl = async () => {
    const value = window.prompt(t('admin.baseUrlPrompt'), baseUrl);
    if (value === null) return;
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_base_url: value }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || t('admin.errBaseUrl'));
      setBaseUrl(body?.public_base_url || value);
      showToast(t('admin.baseUrlSaved'), 'success');
    } catch (err) {
      showToast(err.message || t('admin.errBaseUrl'), 'error');
    }
  };

  const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

  return (
    <div style={{ paddingBottom: '2rem' }}>
      <h2 style={{ fontSize: '1.6rem', fontWeight: 700, letterSpacing: '-0.02em',
                   margin: '0 0 1.2rem', padding: '0 0.25rem' }}>
        {t('admin.title')}
      </h2>

      <Section title={t('admin.secUsers', { count: users.length })}>
        {users.map(u => (
          <Row
            key={u.id}
            icon={Shield}
            label={u.username}
            detail={u.role === 'admin' ? t('admin.roleAdmin') : t('admin.roleUser')}
            // The signed-in admin cannot delete themselves: it would lock the
            // instance out of its own administration.
            onClick={u.id === user?.id ? undefined : () => removeUser(u)}
          />
        ))}
        <Row icon={UserPlus} label={t('admin.addUser')} onClick={() => setAddOpen(true)} />
      </Section>

      <Section title={t('admin.secInstance')}>
        <Row
          label={t('admin.baseUrl')}
          detail={baseUrl || t('admin.baseUrlUnset')}
          onClick={saveBaseUrl}
        />
      </Section>

      <Section title={t('admin.secMaintenance')}>
        <Row
          label={t('admin.cardCatalogue')}
          detail={catalogue
            ? t('admin.catalogueDetail', { count: fmt(catalogue.cards) })
            : t('admin.loading')}
          value={catalogue?.running_since ? t('admin.running') : undefined}
        />
        <Row
          icon={RefreshCw}
          label={t('admin.refreshCatalogue')}
          detail={t('admin.refreshDetail')}
          disabled={Boolean(catalogue?.running_since)}
          onClick={async () => {
            try {
              const res = await fetch('/api/admin/refresh-catalogue', { method: 'POST' });
              showToast(res.ok ? t('admin.refreshStarted') : t('admin.refreshFailed'));
            } catch {
              showToast(t('admin.refreshFailed'), 'error');
            }
            load();
          }}
        />
        <Row
          icon={Trash2}
          label={t('admin.seedCards')}
          detail={t('admin.seedDetail')}
          danger
          onClick={async () => {
            if (!window.confirm(t('admin.confirmSeed'))) return;
            try {
              const res = await fetch('/api/admin/seed-cards', { method: 'POST' });
              showToast(res.ok ? t('admin.seedDone') : t('admin.seedFailed'));
            } catch {
              showToast(t('admin.seedFailed'), 'error');
            }
          }}
        />
      </Section>

      {/* ADD USER. Above the nav bar -- see zLayers.js. */}
      {addOpen && (
        <>
          <div onClick={() => setAddOpen(false)}
               style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: Z_BACKDROP }} />
          <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: Z_MODAL,
                        background: 'var(--surface-1)', borderTopLeftRadius: 20,
                        borderTopRightRadius: 20, padding: '0.6rem 1rem 1rem',
                        paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}>
            <div style={{ width: 38, height: 4, borderRadius: 2, background: 'var(--surface-3)',
                          margin: '4px auto 12px' }} />
            <b style={{ fontSize: '1rem', display: 'block', marginBottom: '0.8rem' }}>
              {t('admin.addUser')}
            </b>

            <input
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              placeholder={t('admin.username')}
              aria-label={t('admin.username')}
              autoCapitalize="none"
              style={{ width: '100%', minHeight: 46, marginBottom: '0.55rem',
                       padding: '0 0.85rem', borderRadius: 'var(--radius-md)',
                       border: '1px solid var(--border-glass)', background: 'var(--surface-2)',
                       color: 'var(--text-primary)', font: 'inherit', fontSize: '0.92rem',
                       boxSizing: 'border-box' }}
            />
            <input
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              placeholder={t('admin.password')}
              aria-label={t('admin.password')}
              autoComplete="new-password"
              style={{ width: '100%', minHeight: 46, marginBottom: '0.55rem',
                       padding: '0 0.85rem', borderRadius: 'var(--radius-md)',
                       border: '1px solid var(--border-glass)', background: 'var(--surface-2)',
                       color: 'var(--text-primary)', font: 'inherit', fontSize: '0.92rem',
                       boxSizing: 'border-box' }}
            />

            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.8rem' }}>
              {['user', 'admin'].map(role => {
                const on = draft.role === role;
                return (
                  <button key={role} onClick={() => setDraft({ ...draft, role })}
                    style={{ flex: 1, minHeight: 40, borderRadius: 'var(--radius-md)',
                             border: `1px solid ${on ? 'var(--accent-blue)' : 'var(--border-glass)'}`,
                             background: on ? 'rgba(10,132,255,.14)' : 'transparent',
                             color: on ? 'var(--accent-blue)' : 'var(--text-secondary)',
                             font: 'inherit', fontSize: '0.85rem', fontWeight: 600,
                             cursor: 'pointer' }}>
                    {role === 'admin' ? t('admin.roleAdmin') : t('admin.roleUser')}
                  </button>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={() => setAddOpen(false)}
                style={{ flex: 1, minHeight: 46, border: 0, borderRadius: 'var(--radius-md)',
                         background: 'var(--surface-3)', color: 'var(--text-primary)',
                         font: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
                {t('common.cancel')}
              </button>
              <button onClick={addUser} disabled={busy}
                style={{ flex: 1, minHeight: 46, border: 0, borderRadius: 'var(--radius-md)',
                         background: 'var(--accent-blue)', color: '#fff',
                         font: 'inherit', fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
                {busy ? t('admin.adding') : t('admin.addUser')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default AdminScreen;
