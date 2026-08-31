// NEW DECK — built against the approved mockup (sketches/005-new-deck).
//
// Zach: "the add new deck modal is completely wrong why didn\'t we follow the
// mock for that??"
//
// He was right; I rebuilt the deck LIST and left the create modal untouched, so
// tapping "New deck" dropped out of the new design into the old one.
//
// FORMAT COMES FIRST, and that is the whole structure. Zach, when the mock was
// reviewed: "we should have all formats. Defaulting to commander is fine but if
// I choose a different format then selecting a commander should disappear."
//
// Format decides whether the commander question EXISTS. Asking for a commander
// before knowing the format means showing a control that may not apply, and a
// disabled field still makes you stop and work out why it is there -- so the
// section is HIDDEN, not greyed.

import { useState, useEffect } from 'react';
import { X, Search, Check } from 'lucide-react';
import { useT } from '../utils/i18n';

// [label, defaultSize, needsCommander, singleton, hasSideboard]
const FORMATS = [
  { id: 'Commander / EDH', label: 'Commander', size: 100, commander: true,  rule: 'fmtCommander' },
  { id: 'Standard',        label: 'Standard',  size: 60,  commander: false, rule: 'fmtSixty' },
  { id: 'Modern',          label: 'Modern',    size: 60,  commander: false, rule: 'fmtSixty' },
  { id: 'Pioneer',         label: 'Pioneer',   size: 60,  commander: false, rule: 'fmtSixty' },
  { id: 'Legacy',          label: 'Legacy',    size: 60,  commander: false, rule: 'fmtSixty' },
  { id: 'Vintage',         label: 'Vintage',   size: 60,  commander: false, rule: 'fmtSixty' },
  { id: 'Pauper',          label: 'Pauper',    size: 60,  commander: false, rule: 'fmtSixty' },
  { id: 'Brawl',           label: 'Brawl',     size: 60,  commander: true,  rule: 'fmtBrawl' },
  { id: 'Limited',         label: 'Limited',   size: 40,  commander: false, rule: 'fmtLimited' },
  { id: 'Casual',          label: 'Casual',    size: 0,   commander: false, rule: 'fmtCasual' },
];

const BRACKETS = [1, 2, 3, 4, 5];

function NewDeckModal({ open, onClose, onCreate, showToast }) {
  const { t } = useT();

  const [format, setFormat] = useState(FORMATS[0]);
  const [name, setName] = useState('');
  const [bracket, setBracket] = useState(3);
  const [commander, setCommander] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset on open so a cancelled deck does not leak into the next one.
  useEffect(() => {
    if (!open) return;
    setFormat(FORMATS[0]); setName(''); setBracket(3);
    setCommander(null); setQuery(''); setResults([]);
  }, [open]);

  // Commander search, debounced. Only runs for formats that have commanders.
  useEffect(() => {
    if (!open || !format.commander) return;
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/search?name=${encodeURIComponent(q)}&game=mtg&commanders=1`);
        const data = res.ok ? await res.json() : [];
        if (!cancelled) setResults(Array.isArray(data) ? data.slice(0, 8) : []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, open, format.commander]);

  if (!open) return null;

  const pickFormat = (f) => {
    setFormat(f);
    // Changing away from a commander format CLEARS the commander. Keeping it
    // would leave hidden state attached to a deck that cannot use it, with no
    // way to see or change it.
    if (!f.commander) { setCommander(null); setQuery(''); setResults([]); }
  };

  const canCreate = format.commander ? !!commander : true;

  const submit = async () => {
    if (!canCreate || saving) return;
    setSaving(true);
    try {
      await onCreate({
        name: (name.trim() || commander?.name || t('deck.untitled')),
        format: format.id,
        target_size: format.size || null,
        bracket: format.commander ? bracket : null,
        commander_card_id: commander?.id || null,
      });
    } catch (err) {
      showToast(err?.message || t('deck.createFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const label = { fontSize: '0.76rem', fontWeight: 600, color: 'var(--text-secondary)',
                  textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.45rem' };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', flexDirection: 'column',
                  background: 'var(--bg-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: 'calc(0.8rem + env(safe-area-inset-top, 0px)) 1rem 0.8rem',
                    borderBottom: '1px solid var(--border-glass)' }}>
        <button onClick={onClose} aria-label={t('common.cancel')}
                style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', padding: 6, minHeight: 44 }}>
          <X size={20} />
        </button>
        <b style={{ fontSize: '1rem' }}>{t('deck.newDeck')}</b>
        <span style={{ width: 32 }} />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', maxWidth: 680, width: '100%', margin: '0 auto' }}>
        {/* FORMAT FIRST. A scrolling chip row rather than a segmented control:
            segments stop working past about four options on a phone. */}
        <div style={label}>{t('deck.format')}</div>
        <div style={{ display: 'flex', gap: '0.35rem', overflowX: 'auto', paddingBottom: '0.3rem', marginBottom: '0.4rem' }}>
          {FORMATS.map(f => {
            const on = f.id === format.id;
            return (
              <button key={f.id} onClick={() => pickFormat(f)} aria-pressed={on}
                style={{ flexShrink: 0, minHeight: 36, padding: '0 0.85rem', borderRadius: 'var(--radius-sm)',
                         border: `1px solid ${on ? 'var(--accent-blue)' : 'var(--border-glass)'}`,
                         background: on ? 'var(--accent-blue)' : 'var(--surface-1)',
                         color: on ? 'var(--text-on-accent)' : 'var(--text-secondary)',
                         font: 'inherit', fontSize: '0.85rem', fontWeight: on ? 600 : 500,
                         whiteSpace: 'nowrap', cursor: 'pointer' }}>
                {f.label}
              </button>
            );
          })}
        </div>
        {/* Each format states its own rules, so the size is never a surprise. */}
        <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginBottom: '1.2rem' }}>
          {t(`deck.${format.rule}`)}
        </div>

        {/* COMMANDER — only for formats that have one. Hidden, not disabled. */}
        {format.commander && (
          <div style={{ marginBottom: '1.2rem' }}>
            <div style={label}>{t('deck.commander')}</div>
            {commander ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.7rem',
                            background: 'var(--surface-1)', border: '1px solid var(--accent-blue)',
                            borderRadius: 'var(--radius-md)' }}>
                {commander.image_url && (
                  <img src={commander.image_url} alt="" style={{ width: 40, borderRadius: 4, flexShrink: 0 }} />
                )}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: '0.92rem' }}>{commander.name}</span>
                  <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {(commander.set_id || '').toUpperCase()}
                  </span>
                </span>
                <button onClick={() => { setCommander(null); setQuery(''); }}
                        style={{ border: 0, background: 'transparent', color: 'var(--accent-blue)', font: 'inherit', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', minHeight: 44 }}>
                  {t('common.edit')}
                </button>
              </div>
            ) : (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.55rem',
                                background: 'var(--surface-1)', border: '1px solid var(--border-glass)',
                                borderRadius: 'var(--radius-md)', padding: '0 0.85rem', height: 44 }}>
                  <Search size={17} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <input value={query} onChange={e => setQuery(e.target.value)}
                         placeholder={t('deck.commanderSearch')}
                         style={{ border: 0, outline: 'none', background: 'transparent', flex: 1,
                                  color: 'var(--text-primary)', font: 'inherit', fontSize: '0.95rem' }} />
                </label>
                {searching && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: '0.5rem 0.2rem' }}>
                    {t('common.loading')}
                  </div>
                )}
                {results.map(c => (
                  <button key={c.id} onClick={() => { setCommander(c); setResults([]); }}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
                             minHeight: 48, padding: '0.5rem 0.6rem', marginTop: '0.35rem',
                             border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)',
                             background: 'var(--surface-1)', color: 'var(--text-primary)',
                             font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.name}
                      </span>
                      <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                        {(c.set_id || '').toUpperCase()}{c.number ? ` #${c.number}` : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}

        {/* NAME defaults to the commander, so the common case needs no typing. */}
        <div style={label}>{t('deck.deckName')}</div>
        <input value={name} onChange={e => setName(e.target.value)}
               placeholder={commander?.name || t('deck.namePlaceholder')}
               style={{ width: '100%', height: 44, padding: '0 0.85rem', marginBottom: '1.2rem',
                        background: 'var(--surface-1)', border: '1px solid var(--border-glass)',
                        borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
                        font: 'inherit', fontSize: '0.95rem', outline: 'none' }} />

        {/* BRACKET is a Commander concept only. */}
        {format.commander && (
          <>
            <div style={label}>{t('deck.bracket')}</div>
            <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '1.2rem' }}>
              {BRACKETS.map(b => {
                const on = b === bracket;
                return (
                  <button key={b} onClick={() => setBracket(b)} aria-pressed={on}
                    style={{ flex: 1, minHeight: 40, borderRadius: 'var(--radius-sm)',
                             border: `1px solid ${on ? 'var(--accent-blue)' : 'var(--border-glass)'}`,
                             background: on ? 'var(--accent-blue)' : 'var(--surface-1)',
                             color: on ? 'var(--text-on-accent)' : 'var(--text-secondary)',
                             font: 'inherit', fontSize: '0.9rem', fontWeight: on ? 700 : 500, cursor: 'pointer' }}>
                    {b}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* The button says WHY it is disabled rather than just being grey. */}
      <div style={{ padding: '0.85rem 1rem calc(0.85rem + env(safe-area-inset-bottom, 0px))',
                    borderTop: '1px solid var(--border-glass)' }}>
        <div style={{ maxWidth: 680, margin: '0 auto' }}>
          <button onClick={submit} disabled={!canCreate || saving}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
                     width: '100%', minHeight: 48, border: 0, borderRadius: 'var(--radius-md)',
                     background: canCreate ? 'var(--accent-blue)' : 'var(--surface-2)',
                     color: canCreate ? 'var(--text-on-accent)' : 'var(--text-muted)',
                     font: 'inherit', fontSize: '0.98rem', fontWeight: 600,
                     cursor: canCreate && !saving ? 'pointer' : 'not-allowed' }}>
            {canCreate ? <Check size={18} /> : null}
            {saving ? t('common.loading') : canCreate ? t('deck.createDeck') : t('deck.pickCommanderFirst')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default NewDeckModal;
