// ONE DECK CARD, USED BY BOTH SCREENS.
//
// Zach: "the cards should be setup identical on the dashboard and card list.
// Right now don't look exactly the same."
//
// They did not look the same because they were two parallel implementations --
// the dashboard had its own markup and its own .dash-deck-* CSS, the deck list
// had .deck-row-*. Each fix had to be made twice, and the second one drifted:
// the dashboard lost the Moxfield badge entirely, and the two used different
// art heights and font sizes.
//
// This is the same bug as cmc-vs-mv on the curve and the row-vs-tooltip odds:
// ONE question answered in TWO places. The fix is the same -- delete the
// duplicate. Both screens render this component; the only difference is that
// the dashboard wraps it in a horizontally scrolling strip.

import { Check } from 'lucide-react';

// Progress ring. `size` is the only knob: both screens use the same one.
function Ring({ pct, size = 42 }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const off = c - (c * Math.min(100, Math.max(0, pct))) / 100;
  return (
    // A CLASS, not only inline styles. The card pins this over the art, and an
    // inline `position: relative` beats any stylesheet rule -- measured once:
    // the selector matched, computed position stayed relative, and the ring
    // sat on the deck name.
    <div className="deck-ring" style={{ width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--surface-3)" strokeWidth="4" fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={r} stroke="var(--accent-green)" strokeWidth="4" fill="none"
          strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset .45s cubic-bezier(.2,.8,.3,1)' }}
        />
      </svg>
    </div>
  );
}

/**
 * A deck as a card: commander art, name, badges, counts, and the built
 * percentage in the bottom-right of the text area.
 *
 * @param deck       the deck, with pct/have/target already resolved by the caller
 * @param t          the translate function (passed in so this file owns no i18n)
 * @param onOpen     called with the deck id
 * @param selecting  multi-select mode: the ring is REPLACED by a checkbox
 * @param selected   whether this card is ticked
 * @param extra      optional node rendered under the counts (the dashboard
 *                   shows cost-to-finish there)
 */
export default function DeckCard({
  deck, t, onOpen, selecting = false, selected = false, extra = null,
}) {
  const pct = deck.pct ?? 0;

  return (
    <button
      type="button"
      className={`deck-row${selected ? ' is-selected' : ''}`}
      onClick={() => onOpen && onOpen(deck.id)}
    >
      <span className="deck-row-art" aria-hidden="true">
        {deck.commander_image_url
          ? <img src={deck.commander_image_url} alt="" loading="lazy" />
          : null}
      </span>

      {/* In select mode the ring is REPLACED by the checkbox rather than
          joined by it -- two indicators on one card is how a glance becomes a
          decision. */}
      {selecting ? (
        <span className="deck-check" data-on={selected ? '1' : '0'}>
          {selected && <Check size={14} strokeWidth={3.5} />}
        </span>
      ) : (
        <Ring pct={pct} />
      )}

      <span className="deck-row-body">
        <span className="deck-row-title">
          <span className="deck-row-name">{deck.name}</span>
          {/* WHERE THIS DECK COMES FROM. Only Moxfield decks are badged:
              labelling every local deck "LOCAL" would add noise to the common
              case to describe the exception. */}
          {deck.moxfield_public_id ? (
            <span className="deck-source-badge" title={t('decks.fromMoxfield')}>
              {t('decks.moxfieldBadge')}
            </span>
          ) : null}
          {/* UPSTREAM DRIFT, found by the background poll. Never applied
              automatically -- a decklist rewriting itself overnight is the
              silent state change Zach has ruled out. */}
          {deck.moxfield_changed ? (
            <span className="deck-drift-badge" title={t('decks.moxfieldChangedHint')}>
              {t('decks.moxfieldChanged')}
            </span>
          ) : null}
        </span>

        <span className="deck-row-meta">
          {/* Count first: "22 of 60 cards" answers "is this deck done", and on
              a narrow card only the first line survives a glance.

              READY TO PLAY MEANS FINISHED, not "nothing missing from a
              one-card list". A deck is ready when the cards it owns reach its
              target size, and not before. */}
          <span className="deck-row-count">
            {deck.have >= deck.target
              ? t('deck.readyToPlay')
              : t('deck.deckProgress', { have: deck.have, want: deck.target })}
          </span>
          <span className="deck-row-price">
            {deck.deckValue > 0
              ? `$${deck.deckValue.toFixed(2)}`
              : t('deck.priceUnknown')}
          </span>
          {extra}
        </span>

        {/* THE PERCENTAGE, bottom-right of the grey text area.
            Zach: "the percent should be in the bottom right of the card in the
            gray area so its readable." The ring over the art shows it too, but
            a number on a dark corner of full-art is not readable at a glance --
            it is the ring's shape you register there, not the digits. */}
        <span className="deck-row-pct">{pct}%</span>
      </span>
    </button>
  );
}
