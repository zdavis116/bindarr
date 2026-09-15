import { useMemo, useState } from 'react';
import { useT } from '../utils/i18n';
import { probLandsByTurn } from '../utils/handOdds';

// THE CURVE TAB.
//
// One component for both widths. The phone and desktop prototypes behaved
// identically -- only the CHROME differed (a tap-sheet instead of a hover
// tooltip) -- so a second component would be two copies of the same bucketing
// rules waiting to disagree about what a deck's curve is.
//
// WHY STACKED BY ROLE
//
// Every other tool draws a plain histogram, and every Commander-specific
// source says it is not enough for EDH: a 3-drop Rhystic Study and a 3-drop
// vanilla creature are the same bar, and they are not the same card. Roles
// come from Scryfall's Tagger (see backend/src/cardRoles.js), not from
// anything guessed here.

export const ROLES = [
  { id: 'ramp', key: 'curve.roleRamp' },
  { id: 'draw', key: 'curve.roleDraw' },
  { id: 'removal', key: 'curve.roleInteraction' },
  { id: 'threat', key: 'curve.roleThreats' },
  { id: 'other', key: 'curve.roleOther' },
];

const BUCKETS = [0, 1, 2, 3, 4, 5, 6, 7];

// LANDS ARE NOT ON THE CURVE.
//
// Every source agrees, and EDHREC's own published mana_curve omits them. A
// land has no mana value to speak of and 37 of them at zero would swamp the
// chart. MDFCs with a land back are kept: you cast the front.
const isLand = (c) => /(^|\s)land(\s|$|—|-)/i.test(c.type_line || '') &&
  !/\/\//.test(c.type_line || '');

// WHICH BUCKET A CARD SITS IN.
//
// Three cases where the rules-correct mana value is the wrong answer for a
// chart you read to ask "can I cast this on turn N":
//
//   SPLIT CARDS  Fire // Ice has mana value 4 by the rules (CR 202.3f adds both
//                halves). You cast Fire for 2. Bucketed at the CHEAPER half,
//                because 4 would tell you a two-mana play is a four-drop.
//   ADVENTURES   Bonecrusher Giant is a 3-drop creature with a 1-mana spell.
//                Bucketed at the creature -- that is the card you are counting.
//   X SPELLS     X is 0 off the stack (CR 202.3e), so they bucket low. True,
//                and flagged in the tooltip because you will pay more.
export function bucketFor(card) {
  const cost = card.mana_cost || '';
  const type = card.type_line || '';

  // A split card's mana_cost is "{1}{R} // {1}{U}". Adventures print the same
  // way, and their creature half is the FIRST face.
  if (cost.includes('//')) {
    const halves = cost.split('//').map((h) => manaValueOf(h));
    const isAdventure = /adventure/i.test(type);
    const mv = isAdventure ? halves[0] : Math.min(...halves);
    return { mv, note: isAdventure ? 'adv' : '//' };
  }

  const mv = typeof card.cmc === 'number' ? card.cmc : manaValueOf(cost);
  if (/\{X\}/i.test(cost)) return { mv, note: 'X' };
  if (!cost && mv === 0) return { mv: 0, note: 'no cost' };
  return { mv, note: null };
}

// Sum a mana cost string. Hybrid and Phyrexian pips each count 1, matching the
// rules; {2/W} counts 2 because that is its mana value.
function manaValueOf(cost) {
  const symbols = (cost || '').match(/\{[^}]+\}/g) || [];
  let total = 0;
  for (const sym of symbols) {
    const body = sym.slice(1, -1);
    if (/^\d+$/.test(body)) { total += Number(body); continue; }
    if (body === 'X' || body === 'Y' || body === 'Z') continue;   // 0 off the stack
    const generic = body.split('/').find((p) => /^\d+$/.test(p));
    total += generic ? Number(generic) : 1;
  }
  return total;
}

export default function CurveTab({ cards, commander, onOverrideRole, onSelectCard }) {
  // useT() returns the CONTEXT ({ locale, setLocale, t }), not the function.
  // Destructure it -- `const t = useT()` typechecks fine and then throws
  // "a is not a function" at the first call, which is how this first shipped.
  const { t } = useT();
  const [filter, setFilter] = useState(null);   // {bucket, role} | {turn} | null
  const [hotRole, setHotRole] = useState(null);
  const [hover, setHover] = useState(null);   // the card being previewed

  // The spells the chart describes: nonland, and not the considering pile --
  // considering cards are not in the deck yet, so counting them would tell you
  // your curve is fixed by cards you have not added.
  const spells = useMemo(() => (cards || [])
    .filter((c) => c.board !== 'considering' && !isLand(c))
    .map((c) => ({ ...c, ...bucketFor(c), role: c.card_role || 'other' })),
  [cards]);

  const bk = (c) => Math.min(Math.round(c.mv), 7);
  const inBucket = (b, role) => spells.filter((c) => bk(c) === b && (!role || c.role === role));
  const maxCount = Math.max(1, ...BUCKETS.map((b) => inBucket(b).length));

  // THE DECK'S ACTUAL LAND COUNT.
  //
  // Counted from the deck, not assumed: 35 lands and 38 lands are meaningfully
  // different decks and the old chart could not tell them apart. Excludes the
  // considering pile for the same reason the curve does -- those are cards you
  // are thinking about, not cards in the 99.
  const landCount = useMemo(() => (cards || [])
    .filter((c) => c.board !== 'considering' && isLand(c))
    .reduce((n, c) => n + (c.quantity || 1), 0),
  [cards]);

  // The library is everything except your commander: it starts in the command
  // zone, so it is never a card you draw.
  const deckSize = useMemo(() => (cards || [])
    .filter((c) => c.board !== 'considering')
    .reduce((n, c) => n + (c.quantity || 1), 0),
  [cards]);
  const commanderCount = useMemo(() => (cards || [])
    .filter((c) => c.board === 'commander')
    .reduce((n, c) => n + (c.quantity || 1), 0),
  [cards]);
  const librarySize = Math.max(1, deckSize - commanderCount);

  // Castable by turn N, counted two ways because they answer different
  // questions:
  //
  //   castableBy  -- how many cards cost little enough to cast by then. This is
  //                  a fact about the DECK.
  //   landOdds    -- how often you actually have that many lands. This is a
  //                  fact about your MANA BASE.
  //
  // The old version multiplied a made-up 0.7 ramp factor into the turn number
  // and presented the result as if it were castability. It assumed you hit
  // every land drop, and that assumption was invisible. Zach: "if I draw only
  // 1 land by turn 2 I still can't play 2 mana cards."
  const castableBy = (turn) => spells.filter((c) => c.mv <= turn).length;
  const landOdds = (turn) => probLandsByTurn(librarySize, landCount, turn);

  const matches = (c) => {
    if (!filter) return true;
    if (filter.turn != null) return c.mv <= filter.turn;
    return bk(c) === filter.bucket && c.role === filter.role;
  };

  const shown = spells.filter(matches);
  const mvs = spells.map((c) => c.mv).sort((a, b) => a - b);
  const avg = mvs.length ? (mvs.reduce((s, n) => s + n, 0) / mvs.length).toFixed(2) : '0';
  const median = mvs.length ? mvs[Math.floor(mvs.length / 2)] : 0;
  const rampCount = spells.filter((c) => c.role === 'ramp').length;
  const bigCount = spells.filter((c) => c.mv >= 6).length;

  const roleLabel = (id) => t(ROLES.find((r) => r.id === id).key);
  const filterLabel = () => {
    if (!filter) return null;
    if (filter.turn != null) return t('curve.castableByTurn', { turn: filter.turn });
    return `${roleLabel(filter.role)} · ${t('curve.mv')} ${filter.bucket === 7 ? '7+' : filter.bucket}`;
  };

  const commanderBucket = commander ? Math.min(Math.round(bucketFor(commander).mv), 7) : null;

  return (
    <div className="curve-tab">
      {/* THE CHART */}
      <div className="curve-panel">
        <div className="curve-head">
          <b>{t('curve.manaCurve')}</b>
          <span>{t('curve.nonlandCount', { count: spells.length, n: spells.length })}</span>
        </div>

        <div className="curve-chart">
          {BUCKETS.map((b) => {
            const n = inBucket(b).length;
            const h = Math.round((n / maxCount) * 100);
            return (
              <div className="curve-col" key={b}>
                <div className="curve-total">{n || ''}</div>
                <div className="curve-stack" style={{ height: `${h}%` }}>
                  {ROLES.map((r) => {
                    const k = inBucket(b, r.id).length;
                    if (!k) return null;
                    const selected = filter && filter.bucket === b && filter.role === r.id;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className={`curve-seg curve-${r.id}`
                          + (hotRole && hotRole !== r.id ? ' dim' : '')
                          + (selected ? ' sel' : '')}
                        style={{ height: `${(k / n) * 100}%` }}
                        title={`${roleLabel(r.id)} · ${k}`}
                        aria-label={`${roleLabel(r.id)}, ${t('curve.mv')} ${b === 7 ? '7+' : b}, ${k}`}
                        onClick={() => setFilter(selected ? null : { bucket: b, role: r.id })}
                      />
                    );
                  })}
                </div>
                {commanderBucket === b && (
                  <div className="curve-cmdr" style={{ bottom: `calc(${h}% + 6px)` }}>
                    ◈ {t('curve.commander')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="curve-xrow">
          {BUCKETS.map((b) => <div key={b} className="curve-x">{b === 7 ? '7+' : b}</div>)}
        </div>
        <div className="curve-axis">{t('curve.manaValue')}</div>

        <div className="curve-legend">
          {ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`curve-lg${hotRole === r.id ? ' on' : ''}`}
              onClick={() => setHotRole(hotRole === r.id ? null : r.id)}
            >
              <i className={`curve-sw curve-${r.id}`} />
              {roleLabel(r.id)} {spells.filter((c) => c.role === r.id).length}
            </button>
          ))}
        </div>
      </div>

      {/* HEALTH */}
      <div className="curve-panel">
        <div className="curve-head"><b>{t('curve.health')}</b></div>
        <div className="curve-stats">
          <Stat k={t('curve.avgMv')} v={avg} n={t('curve.exclLands')} />
          <Stat k={t('curve.medianMv')} v={median} n={t('curve.typicalBand')} />
          <Stat k={t('curve.roleRamp')} v={rampCount}
                n={rampCount >= 10 ? t('curve.onTarget') : t('curve.thin')} />
          <Stat k={t('curve.sixPlus')} v={bigCount}
                n={bigCount > 10 ? t('curve.mayClog') : t('curve.fine')} />
        </div>
      </div>

      {/* CASTABLE BY TURN.
          The ramp toggle is gone. It scaled the turn number by an invented
          0.7 factor -- a guess presented in the same typeface as a measurement.
          What replaces it is the real odds of having the lands, which is the
          thing that was silently assumed. */}
      <div className="curve-panel">
        <div className="curve-head">
          <b>{t('curve.castableByTurnTitle')}</b>
          <span>{t('curve.landsInDeck', { n: landCount })}</span>
        </div>
        <div className="curve-turns">
          {[1, 2, 3, 4, 5, 6].map((turn) => {
            const n = castableBy(turn);
            const odds = landOdds(turn);
            const on = filter && filter.turn === turn;
            return (
              <button
                key={turn}
                type="button"
                className={`curve-turn${on ? ' on' : ''}`}
                onClick={() => setFilter(on ? null : { turn })}
                title={t('curve.turnOddsTitle', {
                  turn, pct: Math.round(odds * 100), lands: turn })}
              >
                <span className="curve-turn-l">{t('curve.turnN', { n: turn })}</span>
                <span className="curve-turn-bar">
                  <i style={{ width: `${spells.length ? (n / spells.length) * 100 : 0}%` }} />
                </span>
                <span className="curve-turn-n">{n}</span>
                {/* THE ODDS, beside the count, because the count alone implies
                    a certainty it does not have. Amber below 50%: at that
                    point the turn is more likely to be a miss than a hit. */}
                <span className={`curve-turn-odds${odds < 0.5 ? ' low' : ''}`}>
                  {Math.round(odds * 100)}%
                </span>
              </button>
            );
          })}
        </div>
        <p className="curve-assumes">{t('curve.oddsAssume')}</p>
      </div>

      {/* THE LIST the chart filters.
          The filter bar is STICKY: the list runs to 49+ rows, so by the time
          you have scrolled into it the chart and the Clear button are both off
          screen -- measured Clear at y=1279 in a 950px viewport. A filter you
          cannot see and cannot undo is how you end up reading a partial deck
          and thinking it is the whole one. */}
      <div className="curve-panel curve-listpanel">
        {filterLabel() ? (
          <div className="curve-filterbar">
            <span><b>{filterLabel()}</b> · {shown.length}</span>
            <button type="button" onClick={() => setFilter(null)}>{t('curve.clear')}</button>
          </div>
        ) : (
          <div className="curve-listhint">
            {t('curve.allNonland', { count: shown.length, n: shown.length })}
          </div>
        )}
        <div className="curve-list">
          {shown
            .slice()
            .sort((a, b) => a.mv - b.mv || (a.name || '').localeCompare(b.name || ''))
            .map((c) => (
              <button
                key={c.id}
                type="button"
                className="curve-row"
                onClick={() => onSelectCard && onSelectCard(c)}
                // HOVER PREVIEWS, as in the prototype. The list is 49+ rows of
                // names, and a name does not tell you what a card does -- that
                // was the whole point of putting rules text in the tooltip.
                // Pointer events only: on a phone there is no hover and the
                // tap opens the card, which is the same information.
                onMouseEnter={() => setHover(c)}
                onMouseLeave={() => setHover(null)}
                // Keyboard parity: the preview is the only place the rules text
                // appears without opening the card, so tabbing must reach it.
                onFocus={() => setHover(c)}
                onBlur={() => setHover(null)}
              >
                <i className={`curve-dot curve-${c.role}`} />
                <span className="curve-row-name">
                  <b>{c.display_name || c.name}</b>
                  <span className="curve-row-what">{gist(c.oracle_text)}</span>
                </span>
                {c.note && <span className="curve-note-pill">{c.note}</span>}
                <span className="curve-row-mv">{c.mv}</span>
              </button>
            ))}
        </div>
      </div>

      {/* THE HOVER PREVIEW.
          Pinned bottom-left of the viewport, NOT anchored to the hovered row.
          Anchoring it to the row put it over the chart -- and the chart is what
          you are reading when you hover a card to ask what it does. A fixed
          corner also means the eye always knows where the answer will appear,
          instead of tracking a box that moves with every row. */}
      {hover && (
        <div className="curve-tip">
          <b>{hover.display_name || hover.name}</b>
          <div className="curve-tip-type">{hover.type_line}</div>
          <div className="curve-tip-text">
            {hover.oracle_text || t('curve.noRulesText')}
          </div>
          <div className="curve-tip-foot">
            <span style={{ color: `var(--curve-${hover.role}, inherit)` }}>
              {roleLabel(hover.role)}
            </span>
            {' · '}
            {hover.role_is_override
              ? t('curve.whyOverride')
              : hover.role_source_tag
                ? t('curve.whyTag', { tag: hover.role_source_tag })
                : t('curve.whyTypeLine')}
          </div>
        </div>
      )}

      {/* WHERE THE ROLES COME FROM. Stated in the UI rather than left implicit:
          a number you cannot question is one you cannot correct. */}
      <p className="curve-source">
        {t('curve.rolesFrom')}
        {onOverrideRole ? ` ${t('curve.overrideHint')}` : ''}
      </p>
    </div>
  );
}

function Stat({ k, v, n }) {
  return (
    <div className="curve-stat">
      <div className="curve-stat-k">{k}</div>
      <div className="curve-stat-v">{v}</div>
      <div className="curve-stat-n">{n}</div>
    </div>
  );
}

// One line of what a card does, for the list row. The full text lives in the
// card detail pane / sheet; this only has to be enough to recognise the card.
function gist(text) {
  if (!text) return '';
  const first = String(text).split('\n')[0].split(/(?<=\.)\s/)[0];
  return first.length > 64 ? `${first.slice(0, 61)}…` : first;
}
