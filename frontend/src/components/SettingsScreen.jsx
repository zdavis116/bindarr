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
import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, Upload, Download, RefreshCw, Key, Link2, Shield, Info, DollarSign } from 'lucide-react';
import { useT } from '../utils/i18n';
import { Z_BACKDROP, Z_MODAL } from '../utils/zLayers';
import ImportModal from './ImportModal';

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
// WHEN A SOURCE LAST REFRESHED -- date AND time.
//
// Zach: "for the last refreshed date can it be date and time. I want that for
// all data sources."
//
// It was toLocaleDateString(), so a feed that refreshed four minutes ago and one
// that refreshed twenty hours ago both read "9/11/2026". For a source that syncs
// every 6 hours the date alone cannot answer the only question worth asking --
// are these prices current -- and it made a stale feed indistinguishable from a
// fresh one.
//
// Rendered in HIS timezone, not the server's. The dev box runs Etc/UTC, so a
// server-side format would read an hour off his phone and look like a bug even
// when the underlying timestamp was right.
function when(iso, t) {
  if (!iso) return t('settings.never');
  // THE TIMESTAMP IS UTC, AND MUST BE SAID SO.
  //
  // Zach: "the last run time is behind 1 hr."
  //
  // SQLite's CURRENT_TIMESTAMP returns 'YYYY-MM-DD HH:MM:SS' with NO zone
  // marker, and new Date() on that reads it as LOCAL time. The dev box runs
  // Etc/UTC while he is on EDT, so a sync that ran at 12:35 UTC rendered as
  // 12:35 PM on his phone instead of 8:35 AM -- four hours adrift, and always
  // in the direction that makes a stale feed look fresh.
  //
  // Measured, not assumed: TZ=America/New_York node showed 12:35:22 PM raw
  // versus 8:35:22 AM parsed as UTC.
  const d = new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(iso)
    ? iso
    : String(iso).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return t('settings.never');
  return d.toLocaleString(undefined, {
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// A COUNTDOWN TO THE NEXT SYNC, plus the clock time it lands at.
//
// Zach: "for each sync to show when the next sync to run like a countdown.
// Because you say scryfall syncs at 0400 but I see on the site 0300 hundred is
// that local time zone adjusted if so can I also see 0300 est or something."
//
// He was reading three different numbers for one schedule. Both halves are here
// deliberately: the countdown answers "how long until it happens", the clock
// time answers "at what time", and neither is typed by hand -- they are derived
// from the timestamp the scheduler published.
//
// toLocaleTimeString with timeZoneName renders in the READER's zone and labels
// it, so "23:00 EST" on his phone and "04:00 UTC" on the server are visibly the
// same instant rather than two contradictory claims.
function untilText(iso, serverNow, t) {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;

  // Measure against the SERVER's clock, not the device's. A phone running a few
  // minutes fast would otherwise show a countdown that disagrees with when the
  // sync actually fires, and "why didn't it sync?" becomes unanswerable.
  const skew = serverNow ? Date.now() - new Date(serverNow).getTime() : 0;
  const ms = target - (Date.now() - skew);

  // Due but not yet reported as started: say so rather than counting into
  // negative numbers or freezing at "0m", both of which read as broken.
  if (ms <= 0) return t('settings.dueNow');

  const mins = Math.round(ms / 60000);
  if (mins < 60) return t('settings.inMinutes', { count: mins });
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem
    ? t('settings.inHoursMinutes', { hours: hrs, minutes: rem })
    : t('settings.inHours', { count: hrs });
}

function clockText(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

function SettingsScreen({ user, onNavigate, showToast }) {
  const { t } = useT();
  const [catalogue, setCatalogue] = useState(null);
  const [priceSources, setPriceSources] = useState(null);
  // WHERE MANA POOL SHIPS TO.
  //
  // Required before a cart can be created at all -- their API refuses an order
  // without a destination. Zach chose to store it once rather than retype it.
  const [savingOrder, setSavingOrder] = useState(false);
  const [version, setVersion] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // Which source has its detail open. One at a time -- a phone screen
  // cannot show two expanded sources usefully.
  const [sourceOpen, setSourceOpen] = useState(null);
  // Opens the shared ImportModal. Was a hidden <input> whose file went to a
  // navigation callback that could not receive it -- see the render below.
  const [importOpen, setImportOpen] = useState(false);
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

  // useCallback so the countdown effect can depend on it without re-subscribing
  // on every render.
  // PRICE SOURCE PRIORITY.
  //
  // Zach: "Priority order in settings and scryfall last resort." The order is
  // read from the server rather than assumed, so what is shown here is what
  // actually prices his cards.
  // WHERE MANA POOL SHIPS TO. Required before a cart can be created at all.


  const loadPriceSources = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/price-sources');
      if (res.ok) setPriceSources(await res.json());
    } catch { /* the section stays hidden rather than showing a wrong order */ }
  }, []);

  // WHICH SHOP PRICES HIS CARDS.
  //
  // This was a drag-to-reorder list. Zach removed it after seeing the numbers:
  // "I would like to get rid of the priority list and it be a selection whether
  // I used mana pool or card kingdom but the fallback is always scryfall since
  // it's an average."
  //
  // He is right that a ranking was the wrong model. The two shops have
  // different price FLOORS -- $0.15 at Mana Pool, $0.35 at Card Kingdom -- so a
  // ranked chain produced a total that was the price at neither shop and could
  // not be checked against any real page.
  const selectPriceSource = async (id) => {
    if (!priceSources || savingOrder || priceSources.selected === id) return;
    setSavingOrder(true);
    try {
      const res = await fetch('/api/settings/price-sources', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || t('settings.priceSourceFailed'));
      } else {
        // Re-read rather than patching local state: the server decides what the
        // resulting chain is, and a screen that guesses can disagree with it.
        await loadPriceSources();
        showToast(t('settings.priceSourceSaved'), 'success');
      }
    } catch {
      showToast(t('settings.priceSourceFailed'));
    } finally {
      setSavingOrder(false);
    }
  };

  const loadCatalogue = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/catalogue');
      if (res.ok) setCatalogue(await res.json());
    } catch { /* the row shows a dash rather than a wrong number */ }
  }, []);

  // Re-render every 30s so the countdown actually counts down.
  //
  // A number labelled "in 4h 12m" that is really 20 minutes stale is worse than
  // no countdown -- it looks live and is not. 30s is finer than the minute
  // resolution displayed, so the text is never visibly behind.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setTick(n => n + 1);
      // Re-read the schedule too, not just re-render. The Moxfield poll fires
      // every five minutes, so a cached next-run time goes stale fast; without
      // this the countdown would tick past zero and sit on "due now" forever.
      loadCatalogue();
    }, 30000);
    return () => clearInterval(id);
  }, [loadCatalogue]);


  useEffect(() => {
    loadCatalogue();
    loadMoxfield();
    loadPriceSources();
    (async () => {
      try {
        const res = await fetch('/api/settings/version');
        if (res.ok) setVersion(await res.json());
      } catch { /* About shows the dash */ }
    })();
  }, [loadMoxfield, loadCatalogue, loadPriceSources]);

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
      {/* WHICH SHOP PRICES A CARD.
          Zach: "I would like to get rid of the priority list and it be a
          selection whether I used mana pool or card kingdom but the fallback is
          always scryfall since it's an average." */}
      {priceSources && (
        <Section title={t('settings.secPriceSources')}>
          <Row
            icon={DollarSign}
            label={t('settings.priceShopTitle')}
            detail={priceSources.sources?.[0]?.label || ''}
            expanded={sourceOpen === 'prices'}
            onClick={() => setSourceOpen(sourceOpen === 'prices' ? null : 'prices')}
          />
          {sourceOpen === 'prices' && (
            <div style={{ background: 'var(--surface-2)' }}>
              {(priceSources.choices || []).map((src) => {
                const on = src.id === priceSources.selected;
                return (
                  <button key={src.id} onClick={() => selectPriceSource(src.id)}
                    disabled={savingOrder}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.7rem',
                      width: '100%', textAlign: 'left', border: 0, font: 'inherit',
                      padding: '0.7rem 1rem 0.7rem 2rem', background: 'transparent',
                      color: 'inherit', cursor: savingOrder ? 'default' : 'pointer',
                      borderBottom: '1px solid var(--border-glass)',
                    }}>
                    {/* A filled dot, not a checkbox: exactly one shop applies. */}
                    <span style={{
                      flexShrink: 0, width: 18, height: 18, borderRadius: '50%',
                      border: `2px solid ${on ? 'var(--accent-blue)' : 'var(--text-tertiary)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {on && <span style={{ width: 9, height: 9, borderRadius: '50%',
                                            background: 'var(--accent-blue)' }} />}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: '0.9rem',
                                     fontWeight: on ? 600 : 400 }}>
                        {src.label}
                      </span>
                      {/* Every source says how many prices it holds and when it
                          last ran, so a stale shop is visible rather than
                          quietly wrong. */}
                      <span style={{ display: 'block', fontSize: '0.72rem',
                                     color: 'var(--text-tertiary)' }}>
                        {src.row_count
                          ? t('settings.priceShopRows', { count: fmt(src.row_count) })
                          : t('settings.priceShopNoData')}
                        {src.last_success_at ? ` · ${when(src.last_success_at, t)}` : ''}
                      </span>
                    </span>
                  </button>
                );
              })}
              {/* THE FALLBACK IS STATED, NOT OFFERED. It is a rule, and showing
                  it as a fourth option would imply he could value his whole
                  collection at an average of past sales. */}
              <div style={{ padding: '0.7rem 1rem 0.8rem 2rem', fontSize: '0.74rem',
                            color: 'var(--text-secondary)' }}>
                {t('settings.priceShopFallback')}
              </div>
            </div>
          )}
        </Section>
      )}

      <Section title={t('settings.secDataSources')}>
        {/* EVERY PRICE SHOP IS A DATA SOURCE.
            Zach: "Mana pool should exist as a data source", and later "one thing
            missing is adding card kingdom to the data source section."

            Rendered from the list of shops rather than hand-written per shop.
            The previous version was a Mana Pool block that read the SELECTED
            source, so Card Kingdom vanished from Settings whenever Mana Pool was
            chosen -- a source syncing every 6 hours with nothing on screen
            saying so. Adding a shop later needs no new markup here. */}
        {(priceSources?.choices || []).map((shop) => {
          const nextRun = catalogue?.[`${shop.id}_next_run`];
          return (
            <div key={shop.id}>
              <Row
                icon={Link2}
                label={shop.label}
                detail={shop.row_count
                  ? t('settings.shopSyncs', { count: fmt(shop.row_count) })
                  : t('settings.shopNeverSynced')}
                expanded={sourceOpen === shop.id}
                onClick={() => setSourceOpen(sourceOpen === shop.id ? null : shop.id)}
              />
              {sourceOpen === shop.id && (
                <div style={{ background: 'var(--surface-2)' }}>
                  <Row
                    indent
                    label={t('settings.lastRefreshed')}
                    value={shop.last_success_at ? when(shop.last_success_at, t) : '—'}
                  />
                  {/* THE COUNTDOWN, like every other source. A sync with no
                      visible next run looks like it happens at random. */}
                  <Row
                    indent
                    label={t('settings.automatic')}
                    detail={nextRun
                      ? t('settings.nextRunAt', { time: clockText(nextRun) })
                      : t('settings.shopEvery6h')}
                    value={untilText(nextRun, catalogue?.server_now, t)
                           || t('settings.shopEvery6h')}
                  />
                  {/* A FAILED SYNC IS SAID OUT LOUD. Otherwise a stale price
                      looks like a current one -- the whole reason provenance
                      exists on every figure in this app. */}
                  {shop.last_error && (
                    <Row
                      indent
                      label={t('settings.lastError')}
                      value={shop.last_error}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}

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
              detail={catalogue?.catalogue_next_run
                ? t('settings.nextRunAt', { time: clockText(catalogue.catalogue_next_run) })
                : t('settings.automaticOff')}
              value={catalogue?.running_since
                ? t('settings.refreshing')
                : (untilText(catalogue?.catalogue_next_run, catalogue?.server_now, t)
                   || t('settings.off'))}
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
                  detail={catalogue?.moxfield_next_run
                    ? t('settings.nextRunAt', { time: clockText(catalogue.moxfield_next_run) })
                    : t('settings.moxAutomaticDetail')}
                  value={untilText(catalogue?.moxfield_next_run, catalogue?.server_now, t)
                    || t('settings.off')}
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
          onClick={() => setImportOpen(true)}
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

      {/* IMPORT. Opens the SAME modal the Collection screen uses.
          
          This used to be a hidden file input that called
          onNavigate('import', file). Two things were wrong with that: App's
          Settings is wired to setActiveTab, a plain state setter that takes ONE
          argument, so the file was silently dropped -- and there is no 'import'
          tab for it to switch to anyway. Zach: "the import cards from the
          settings doesn't work either. It pops up the files screen but nothing
          imports." The picker was the file input opening; nothing was ever
          going to happen after it.
          
          Rendering the real modal here rather than repairing the navigation:
          the import flow already exists, works, and has a pre-flight review. A
          second path into it is a second thing to keep correct. */}
      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            // Settings has no collection list of its own to refresh, so this
            // is the toast confirming the write actually landed -- the modal
            // reports its own counts before this fires.
            showToast && showToast(t('settings.importDone'));
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

export default SettingsScreen;
