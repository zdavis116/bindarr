import { ShoppingCart, AlertTriangle, Copy, ExternalLink } from 'lucide-react';
import { useT } from '../utils/i18n';
import { buylistKey, buylistLines, shortfallExplanation, buylistCoverage } from './missingCards';
import { BRACKET_STYLES, DEFAULT_BRACKET_STYLE } from '../utils/deckText';

// THE MISSING CARDS / BUYLIST PANEL (PR 7).
//
// Why this is its own file: the original plan warned "do not continue growing
// the existing 100+ KB component without extraction" and named
// MissingCardsPanel as a candidate. The buylist IS a missing-cards surface, so
// it is BUILT here rather than added to DeckBuilder.jsx. This is putting the
// new thing in the right place, not a refactor of what already exists — the
// deck screen around it is untouched.
//
// EVERY NUMBER ON THIS PANEL COMES FROM THE SERVER, from
// GET /api/decks/:id/buylist. Nothing is recomputed here. The shortfall is
// calculated after other saved decks' reservations, and that arithmetic exists
// once, on the server (deckIdentity.buylistForDeck). A second implementation
// in the UI would eventually disagree with the red "Missing" badge on the same
// screen, and the user would have no way to know which one to trust.
//
// THE PRINTING IS PART OF THE INSTRUCTION. Each line shows set and collector
// number, and a foil/etched badge, because for a buylist the printing IS the
// decision — it is a price decision. A line reading just "3x Sol Ring" would
// let him (or a shop's mass-entry box) buy a printing he did not choose.
export default function MissingCardsPanel({
  buylist,
  loading,
  onCopy,
  onOpenMassEntry,
  bracketStyle = DEFAULT_BRACKET_STYLE,
  onBracketStyleChange,
}) {
  const { t } = useT();

  // A prop from a caller that has not been updated, or a stale stored value,
  // resolves to the default rather than to a third rendering.
  const style = BRACKET_STYLES.includes(bracketStyle) ? bracketStyle : DEFAULT_BRACKET_STYLE;

  const items = buylistLines(buylist?.items);
  const considering = buylistLines(buylist?.considering);
  const coverage = buylistCoverage(buylist);

  if (loading) {
    return (
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <div className="spinner" style={{ margin: '1rem auto' }}></div>
      </div>
    );
  }

  // NOTHING MISSING IS ITS OWN ANSWER, and a good one. An empty panel would
  // read as "not loaded yet"; saying so plainly is the difference between a
  // blank screen and the news that the deck is complete.
  const nothingToBuy = items.length === 0;

  const finishBadge = (finish) => {
    if (finish === 'foil') return t('deck.finishFoil');
    if (finish === 'etched') return t('deck.finishEtched');
    return null;
  };

  // WHAT IS ON SCREEN IS WHAT GETS COPIED.
  //
  // The set code is shown in the SAME delimiters the copy will use, so there is
  // no surprise between reading the panel and pasting into a shop. The label is
  // otherwise unchanged: the set NAME is shown when the server sent one,
  // because "Commander Masters" is more readable than "CMM" — the delimiters
  // then wrap whichever of the two is displayed, which is what makes the toggle
  // legible at a glance without a second preview line.
  const printingLabel = (item) => {
    const set = String(item.set_id || '').replace(/^mtg-/, '').toUpperCase();
    const [open, close] = style === 'brackets' ? ['[', ']'] : ['(', ')'];
    const parts = [];
    if (item.set_name) parts.push(`${open}${item.set_name}${close}`);
    else if (set) parts.push(`${open}${set}${close}`);
    if (item.number) parts.push(`#${item.number}`);
    return parts.join(' · ');
  };

  const line = (item, { muted = false } = {}) => {
    const explanation = shortfallExplanation(item);
    const badge = finishBadge(item.finish);
    return (
      <div
        key={buylistKey(item)}
        style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: '0.6rem', padding: '0.45rem 0.6rem',
          background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)',
          fontSize: '0.8rem'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <strong style={{ color: muted ? 'var(--text-secondary)' : 'var(--text-strong)' }}>
              {item.quantity}× {item.name}
            </strong>
            {badge && (
              <span style={{
                fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.04em',
                color: 'var(--accent-yellow)', border: '1px solid var(--accent-yellow)',
                borderRadius: 'var(--radius-sm)', padding: '0 4px'
              }}>
                {badge}
              </span>
            )}
          </div>
          {/* The printing, always. See the header comment: this is the part
              that makes the line an instruction rather than a hint. */}
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            {printingLabel(item)}
          </span>
          {/* WHICH SELECTED DECKS WANT THIS LINE, on the multi-deck buylist.
              Without it a combined list is unauditable: he could not tell
              which deck put a card on it, so he could not tell whether
              dropping a deck would change the line. Absent on the per-deck
              buylist, where the answer is obvious. */}
          {Array.isArray(item.decks) && item.decks.length > 0 && (
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              {item.decks.map(d => `${d.name} (${d.quantity})`).join(' · ')}
            </span>
          )}
          {/* THE MOST CONFUSING POSSIBLE LINE, explained: "buy this card you
              can see in your own binder". Without the reason it reads as a
              bug in the app rather than as a fact about his other decks. */}
          {explanation && (
            <span style={{ fontSize: '0.72rem', color: 'var(--accent-yellow)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <AlertTriangle size={11} style={{ flexShrink: 0 }} />
              {t('deck.buylistCommittedElsewhere', {
                owned: explanation.owned,
                committed: explanation.committed
              })}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: '0.95rem', color: 'var(--text-strong)', margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ShoppingCart size={15} style={{ color: 'var(--accent-yellow)' }} />
          {t('deck.buylistTitle')}
        </h3>
        {!nothingToBuy && (
          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {t('deck.buylistSummary', {
              cards: buylist.summary.total_cards,
              lines: buylist.summary.total_lines
            })}
          </span>
        )}
      </div>

      {/* WHAT THIS LIST COVERS. Rendered above the lines and BEFORE the
          nothing-to-buy branch, because "nothing to buy for these three decks"
          is a different and more useful fact than a bare "nothing to buy".
          Only appears on the combined list; the per-deck buylist sits under a
          heading that already names its deck. */}
      {coverage && (
        <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0, wordBreak: 'break-word' }}>
          {t('deck.multiBuylistCovers', { count: coverage.count, names: coverage.names })}
        </p>
      )}

      {nothingToBuy ? (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0 }}>
          {t('deck.nothingToBuy')}
        </p>
      ) : (
        <>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: 0 }}>
            {t('deck.buylistHint')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {items.map(item => line(item))}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {/* HOW THE SET CODE IS WRITTEN, chosen BEFORE copying (PR 7C).
                Brackets are the MTG convention shops parse; parentheses are
                MTG Arena's shape and what an older buylist emitted. Neither is
                "correct" — they are correct for different destinations, so the
                choice is his and the default is the shopping one.

                It sits in the existing button row rather than in a settings
                screen or a modal because it is a property of THIS copy, decided
                at the moment of copying. The lines above already render in the
                chosen delimiters, so the panel is its own preview.

                MOBILE: this is a wrapping flex row of two small buttons with no
                fixed or basis width, so it cannot widen the panel — the
                horizontal-overflow failure PR 6I fixed. */}
            <div
              role="group"
              aria-label={t('deck.buylistBracketStyle')}
              style={{
                display: 'flex', alignItems: 'center', gap: '3px',
                background: 'var(--surface-2)', padding: '2px',
                borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)'
              }}
            >
              {BRACKET_STYLES.map(option => (
                <button
                  key={option}
                  type="button"
                  className={`btn ${style === option ? 'btn-primary' : 'btn-secondary'}`}
                  aria-pressed={style === option}
                  style={{ padding: '0.25rem 0.55rem', fontSize: '0.75rem' }}
                  onClick={() => onBracketStyleChange?.(option)}
                  title={t(option === 'brackets' ? 'deck.buylistBracketsHint' : 'deck.buylistParenthesesHint')}
                >
                  {option === 'brackets' ? '[SET]' : '(SET)'}
                </button>
              ))}
            </div>
            <button className="btn btn-secondary" onClick={onCopy} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <Copy size={14} /> {t('deck.copyClipboard')}
            </button>
            <button className="btn btn-primary" onClick={onOpenMassEntry} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <ExternalLink size={14} /> {t('deck.copyOpenTcg')}
            </button>
          </div>
        </>
      )}

      {/* CONSIDERING IS SHOWN, SEPARATELY AND NEUTRALLY, AND IS NOT ON THE
          BUYLIST. A considering card is one he is thinking about; it never
          reserves and is not part of the deck, so it is not something to buy
          today. Hiding it entirely would lose information he asked to keep;
          mixing it into the list above would put money against a decision he
          has not made. Hence its own section, below, with no buttons. */}
      {considering.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border-glass)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 700 }}>
              {t('deck.buylistConsideringTitle')}
            </span>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              {t('deck.buylistConsideringHint')}
            </span>
          </div>
          {considering.map(item => line(item, { muted: true }))}
        </div>
      )}
    </div>
  );
}
