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

// PROGRESS AS A BAR WITH A PERCENT PILL BESIDE IT.
//
// Zach: "look at the 2 deck card images... it should look like the mockup but
// keep the moxfield and updated badges."
//
// sketches/desktop.html section 1 draws a 5px full-width track with an amber
// (or green at 100%) fill and a small pill on its right. I had shipped a ring
// with the number inside, which is a different thing entirely -- and the ring
// then needed per-container positioning rules that silently disagreed between
// the deck list and the dashboard. A bar has no corner to sit in.
function Progress({ pct }) {
  const done = pct >= 100;
  return (
    <span className="deck-bar-row">
      <span className="deck-bar">
        <span
          className={`deck-bar-fill${done ? ' is-done' : ''}`}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </span>
      <span className={`deck-pct${done ? ' is-done' : ''}`}>{pct}%</span>
    </span>
  );
}

/**
 * A deck as a card: commander art, name, badges, counts, and a progress ring
 * with the percentage INSIDE it, sitting in the bottom-right of the grey text
 * area.
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
      ) : null}

      {/* THE BADGES SIT ON THE CARD, TOP-RIGHT, over the art.
          Zach: "I want moxfield on the right side of the card as well not
          underneath."
          They are rendered as direct children of the card rather than inside
          the text body ON PURPOSE: .deck-row-body is position:relative (it
          anchors the ring), so a badge pinned from in there lands in the
          corner of the TEXT area, not the card's. Only Moxfield decks are
          badged -- labelling every local deck "LOCAL" would add noise to the
          common case to describe the exception. */}
      {deck.moxfield_public_id ? (
        <span className="deck-source-badge" title={t('decks.fromMoxfield')}>
          {t('decks.moxfieldBadge')}
        </span>
      ) : null}
      {/* UPSTREAM DRIFT, found by the background poll. Never applied
          automatically -- a decklist rewriting itself overnight is the silent
          state change Zach has ruled out. */}
      {deck.moxfield_changed ? (
        <span className="deck-drift-badge" title={t('decks.moxfieldChangedHint')}>
          {t('decks.moxfieldChanged')}
        </span>
      ) : null}

      <span className="deck-row-body">
        <span className="deck-row-title">
          <span className="deck-row-name">{deck.name}</span>
        </span>

        {/* FORMAT AND TARGET SIZE -- "Commander · 100 cards" in the mockup.
            This line says what the deck IS; progress is the bar below it. */}
        <span className="deck-row-sub">
          {[deck.format, t('deck.cardCount', { count: deck.target })]
            .filter(Boolean).join(' · ')}
        </span>

        {!selecting ? <Progress pct={pct} /> : null}

        {/* WHAT IS LEFT TO DO, and what it costs -- the mockup's
            "49 missing · $140.35", or "Complete" when there is nothing. */}
        <span className="deck-row-foot">
          {/* ONE inline run, not text + <b> siblings. Three CSS attempts at
              nowrap failed because the whitespace text node between them is a
              legal break point regardless -- measured the footer at 36px (two
              lines) each time. A single <b> wrapping only the money keeps the
              colour without introducing a second inline box before it. */}
          {deck.have >= deck.target
            ? t('deck.complete')
            : (
              <span className="deck-row-foot-run">
                {`${t('deck.nMissing', { n: deck.target - deck.have })} · `}
                <b className="deck-row-cost">
                  {deck.toFinish > 0
                    ? `$${deck.toFinish.toFixed(2)}`
                    : (deck.deckValue > 0 ? `$${deck.deckValue.toFixed(2)}` : '')}
                </b>
              </span>
            )}
          {extra}
        </span>
      </span>
    </button>
  );
}
