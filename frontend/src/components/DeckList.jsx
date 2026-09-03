// DECK LIST — built against the approved mockup (sketches/003-deck-list).
//
// Zach: "the deck list in the mock was perfect please go to that. Make sure
// there is a search because I don't remember if that was in there but
// everything else should be exactly like the mock."
//
// Search was NOT in the mock; it is added here in the same place Collection
// puts it, so the two screens answer "find me a thing" the same way.
//
// This is a separate component from DeckBuilder rather than a rewrite of its
// list section. DeckBuilder is 4,351 lines and holds the detail view, the
// create modal and export; extracting the list makes both halves legible and
// means a change to one cannot silently reach the other.
//
// SELECTION IS A DELIBERATE MODE. A list where every row carries a checkbox
// makes the common case -- open a deck -- ambiguous. "Select" is entered on
// purpose and the same button leaves it, so there is one way in and one way
// out.

import { useState, useEffect, useMemo, useRef } from 'react';
import { Trash2, Search, X, Plus, Check, ChevronRight, Download } from 'lucide-react';
import { useT } from '../utils/i18n';
import { Z_BOTTOM_BAR, NAV_BAR_CLEARANCE } from '../utils/zLayers';
import { createBuylistSync } from './buylistSync';
import ExportModal from './ExportModal';

// A deck's completion ring. Reads at arm's length, which a percentage in text
// does not -- this list is scanned while holding cards.
function Ring({ pct, size = 42 }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const off = c - (c * Math.min(100, Math.max(0, pct))) / 100;
  return (
    <div style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--surface-3)" strokeWidth="4" fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={r} stroke="var(--accent-green)" strokeWidth="4" fill="none"
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset .45s cubic-bezier(.2,.8,.3,1)' }}
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
        fontSize: '0.66rem', fontWeight: 700, color: 'var(--text-primary)',
      }}>
        {Math.round(pct)}%
      </div>
    </div>
  );
}

function DeckList({ decks, loading, onOpenDeck, onNewDeck, onDeleteDeck, showToast }) {
  const { t } = useT();

  const [query, setQuery] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [buylist, setBuylist] = useState(null);
  const [buylistLoading, setBuylistLoading] = useState(false);

  // THE SELECTION DRIVES THE LIST, live. Ticking a deck IS the instruction, so
  // a "Build" button would ask Zach to confirm something already on screen.
  // The sequencing that makes live updating safe -- debounce, discarding stale
  // answers, never requesting an empty selection -- lives in buylistSync.js.
  const syncRef = useRef(null);
  if (syncRef.current === null) {
    syncRef.current = createBuylistSync({
      fetchBuylist: async (deckIds) => {
        const res = await fetch('/api/decks/buylist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deck_ids: deckIds }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) throw new Error(payload?.error || 'buylist failed');
        return payload;
      },
      onState: ({ loading: l, buylist: b, error }) => {
        setBuylistLoading(l);
        setBuylist(b);
        if (error) showToast(error.message || t('deck.multiBuylistFailed'), 'error');
      },
    });
  }

  useEffect(() => {
    syncRef.current.select([...selected]);
  }, [selected]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return decks
      .filter(d => !q || (d.name || '').toLowerCase().includes(q) || (d.format || '').toLowerCase().includes(q))
      .map(d => {
        const target = d.target_size || 100;
        // OWNED, not listed. total_cards counts what the list says; owned_cards
        // counts what is actually in the binder and not claimed by another
        // deck. A freshly imported deck is fully listed and entirely unowned,
        // and the ring used to call that 97% complete.
        const have = d.owned_cards ?? 0;
        const listed = d.total_cards || 0;
        return {
          ...d,
          pct: Math.min(100, Math.round((have / target) * 100)),
          have, listed, target,
          missingCost: d.missing_cost || 0,
          deckValue: d.deck_value || 0,
        };
      });
  }, [decks, query]);

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const exitSelect = () => { setSelecting(false); setSelected(new Set()); setBuylist(null); };

  // ONE COPY PER DECK, never deduped. Zach: "if I select 3 decks and even one
  // needs a sol ring there should be 3 sol rings in that list not 1... I'd
  // rather each deck be built ready to go." The server already sums per deck;
  // this only presents that total.
  const items = buylist?.items || [];
  // COUNTS ONLY. The endpoint does not return a price per line, and a
  // fabricated total on a shopping list is worse than no total -- it sends him
  // to a shop with a number that is not true. Pricing the buylist is a real
  // feature; it needs the card_cache price joined server-side, not a guess
  // here.

  // The shared ExportModal does the building and copying, so this screen and
  // the deck view behave identically. Zach: "can we have the functionality be
  // the same as for the missing in the deck view."
  //
  // The endpoint returns `quantity`; the exporter reads `quantity_missing`,
  // because everything on a buylist is by definition missing.
  const exportCards = items.map(i => ({ ...i, quantity_missing: i.quantity }));

  return (
    // Clears the selection bar when it is showing. Smaller now that the bar
    // is two buttons rather than two buttons under three lines of text.
    <div style={{ paddingBottom: selecting && selected.size ? 150 : 0 }}>
      {/* HEADER: title and the one mode switch, as in the mock. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.9rem' }}>
        <h2 style={{ fontSize: '1.6rem', fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>
          {t('deck.decks')}
        </h2>
        <button
          onClick={() => (selecting ? exitSelect() : setSelecting(true))}
          style={{
            border: 0, background: 'transparent', color: 'var(--accent-blue)',
            font: 'inherit', fontSize: '0.92rem', fontWeight: 600, cursor: 'pointer',
            minHeight: 44, padding: '0 0.25rem',
          }}
        >
          {selecting ? t('common.done') : t('collection.select')}
        </button>
      </div>

      {/* SEARCH -- not in the mock, added at Zach's request, in the same place
          Collection puts it so both screens behave alike. */}
      <label style={{
        display: 'flex', alignItems: 'center', gap: '0.55rem',
        background: 'var(--surface-1)', border: '1px solid var(--border-glass)',
        borderRadius: 'var(--radius-md)', padding: '0 0.85rem', height: 44,
        marginBottom: '0.8rem',
      }}>
        <Search size={17} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('deck.searchPlaceholder')}
          style={{ border: 0, outline: 'none', background: 'transparent', flex: 1, color: 'var(--text-primary)', font: 'inherit', fontSize: '0.95rem' }}
        />
        {query && (
          <button onClick={() => setQuery('')} aria-label={t('common.close')}
                  style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
            <X size={15} />
          </button>
        )}
      </label>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-secondary)' }}>
          {t('common.loading')}
        </div>
      ) : shown.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--text-secondary)', background: 'var(--surface-1)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.3rem' }}>
            {decks.length ? t('collection.noMatches') : t('deck.noDecks')}
          </div>
          <div style={{ fontSize: '0.85rem' }}>
            {decks.length ? t('collection.noMatchesHint') : t('deck.noDecksHint')}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
          {shown.map(deck => {
            const sel = selected.has(deck.id);
            return (
              <button
                key={deck.id}
                onClick={() => (selecting ? toggle(deck.id) : onOpenDeck(deck.id))}
                onContextMenu={(e) => {
                  // Long-press on a phone arrives as a context menu. Selection
                  // mode is excluded: a destructive action must not share a
                  // gesture with a bulk-selection flow.
                  if (selecting || !onDeleteDeck) return;
                  e.preventDefault();
                  onDeleteDeck(deck.id, deck.name);
                }}
                aria-pressed={selecting ? sel : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.85rem', width: '100%',
                  textAlign: 'left', font: 'inherit', cursor: 'pointer',
                  padding: '0.85rem 0.9rem', minHeight: 68,
                  borderRadius: 'var(--radius-md)',
                  border: sel ? '2px solid var(--accent-blue)' : '1px solid var(--border-glass)',
                  background: sel ? 'var(--surface-2)' : 'var(--surface-1)',
                  color: 'var(--text-primary)', transition: 'var(--transition-smooth)',
                }}
              >
                {/* In select mode the ring is REPLACED by the checkbox rather
                    than joined by it -- two indicators in one row is how a
                    glance becomes a decision. */}
                {selecting ? (
                  <span style={{
                    width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                    display: 'grid', placeItems: 'center',
                    background: sel ? 'var(--accent-blue)' : 'transparent',
                    border: sel ? 0 : '2px solid var(--surface-3)',
                    color: '#fff',
                  }}>
                    {sel && <Check size={14} strokeWidth={3.5} />}
                  </span>
                ) : (
                  <Ring pct={deck.pct} />
                )}

                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 600, fontSize: '0.98rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {deck.name}
                  </span>
                  <span style={{ display: 'block', fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
                    {/* ONE dollar figure: what the deck is worth. Zach: "I
                        didn't want 2 dollar amounts just the total cost".

                        READY TO PLAY MEANS FINISHED, not "nothing missing from
                        a one-card list". Avatar Aang holds a single owned card
                        and reported Ready to play, because missing was
                        listed - owned = 0. A deck is ready when the cards it
                        owns reach its target size, and not before. */}
                    {deck.deckValue > 0
                      ? `$${deck.deckValue.toFixed(2)}`
                      : t('deck.priceUnknown')}
                    {' · '}
                    {deck.have >= deck.target
                      ? t('deck.readyToPlay')
                      : t('deck.deckProgress', { have: deck.have, want: deck.target })}
                  </span>
                </span>

                {!selecting && (
                  <ChevronRight size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* NEW DECK: a full-width action under the list, as in the mock. */}
      {!selecting && (
        <button
          onClick={onNewDeck}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.45rem',
            width: '100%', marginTop: '0.7rem', minHeight: 48, cursor: 'pointer',
            border: '1px dashed var(--border-glass-hover)', borderRadius: 'var(--radius-md)',
            background: 'transparent', color: 'var(--text-secondary)',
            font: 'inherit', fontSize: '0.92rem', fontWeight: 600,
          }}
        >
          <Plus size={17} />
          {t('deck.newDeck')}
        </button>
      )}

      {/* BUYLIST BAR: appears only while decks are ticked. Pinned to the bottom
          so the total stays visible while scrolling the list it describes. */}
      {selecting && selected.size > 0 && (
        <div style={{
          position: 'fixed', left: 0, right: 0, bottom: 0,
          // ABOVE the pinned nav bar (zIndex 1000, index.css:666), which
          // occupies this exact strip on a phone. At 60 this bar rendered
          // underneath it: invisible, with an untappable export button.
          zIndex: Z_BOTTOM_BAR,
          background: 'var(--surface-2)', borderTop: '1px solid var(--border-glass)',
          // Clear the nav bar's own height as well as the home indicator, so
          // the export button is not merely visible but reachable.
          padding: `0.85rem 1rem calc(0.85rem + ${NAV_BAR_CLEARANCE} + env(safe-area-inset-bottom, 0px))`,
          boxShadow: '0 -8px 24px rgba(0,0,0,.5)',
        }}>
          <div style={{ maxWidth: 680, margin: '0 auto' }}>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
            {/* TWO LABELLED ACTIONS, equal weight. A bare trash icon beside an
                export button is ambiguous, and one of the two destroys work.
                Delete is OUTLINED, not filled: a filled button reads as the
                primary action and it is not. */}
            <button
              onClick={async () => {
                const chosen = decks.filter(d => selected.has(d.id));
                if (!chosen.length) return;
                const names = chosen.map(d => d.name).join(', ');
                if (!window.confirm(t('deck.confirmDeleteMany',
                                      { count: chosen.length, names }))) return;
                for (const d of chosen) {
                  // Sequential, not parallel: each delete is its own write and
                  // a half-applied batch is worse than a slow one.
                  await onDeleteDeck(d.id, d.name);
                }
                setSelected(new Set());
                setSelecting(false);
              }}
              disabled={selected.size === 0}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: '0.4rem', flex: 1, minHeight: 46,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--accent-red)', background: 'transparent',
                color: 'var(--accent-red)', font: 'inherit', fontSize: '0.9rem',
                fontWeight: 600, cursor: selected.size ? 'pointer' : 'not-allowed',
                opacity: selected.size ? 1 : 0.4,
              }}
            >
              <Trash2 size={15} />
              {t('deck.delete')}
            </button>

            <button
              onClick={() => setExportOpen(true)}
              disabled={buylistLoading || !items.length}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.45rem',
                flex: 1, minHeight: 46, border: 0, borderRadius: 'var(--radius-md)',
                background: 'var(--accent-blue)', color: 'var(--text-on-accent)',
                font: 'inherit', fontSize: '0.95rem', fontWeight: 600,
                cursor: buylistLoading || !items.length ? 'not-allowed' : 'pointer',
                opacity: buylistLoading || !items.length ? 0.5 : 1,
              }}
            >
              <Download size={16} />
              {t('deck.export')}
            </button>
            </div>
          </div>
        </div>
      )}
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        cards={exportCards}
        title={t('deck.buylist')}
        showToast={showToast}
      />

    </div>
  );
}

export default DeckList;
