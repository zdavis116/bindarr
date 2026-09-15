import { useMemo, useState } from 'react';
import { useT } from '../utils/i18n';
import { probLandsByTurn } from '../utils/handOdds';
import { sourceCounts, castOdds, COLOURS } from '../utils/colourOdds';
// bucketFor lives in utils so it can be unit-tested: node --test cannot
// import .jsx. Re-exported here because other modules already import it
// from this file.
import { bucketFor, curveEntriesFor } from '../utils/curveBuckets';
export { bucketFor };

const COLOUR_LETTERS = {
  White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G',
};

// WHY A CARD SITS WHERE IT DOES, keyed by the note bucketFor returns.
//
// A lookup, not a ternary chain: the chain silently sent any unrecognised note
// to 'nocost', so adding 'mdfc-back' would have printed "No mana cost, so it
// sits at 0" on a six-drop. A missing key here is visible instead.
const NOTE_KEYS = {
  'mdfc-back': 'curve.note.mdfc-back',
  'adventure-half': 'curve.note.adventure-half',
  'split-half': 'curve.note.split-half',
  'second-face': 'curve.note.second-face',
  X: 'curve.note.xspell',
  'no cost': 'curve.note.nocost',
};

// MANA PIPS, as the round symbols every Magic tool uses.
//
// '{1}{W}{U}' written as plain text is read letter by letter; pips are read at
// a glance, which is the whole point of showing the cost here. Taken from the
// approved prototype rather than reinvented.
function ManaCost({ cost }) {
  const symbols = String(cost || '').match(/\{[^}]+\}/g) || [];
  if (!symbols.length) return null;
  return (
    <span className="curve-cost">
      {symbols.map((sym, i) => {
        const body = sym.slice(1, -1);
        // ' // ' between faces survives as a literal in the string; render it
        // so a split cost does not silently look like one cost.
        const key = `${sym}-${i}`;
        const colour = ['W', 'U', 'B', 'R', 'G'].includes(body.toUpperCase())
          ? body.toUpperCase() : null;
        return (
          <i key={key} className={`curve-mp${colour ? ` curve-mp-${colour}` : ''}`}>
            {body}
          </i>
        );
      })}
    </span>
  );
}

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

// THE EIGHT CATEGORIES, in the order the stack and the mix bar read.
//
// Approved from sketches/roles8.html, measured on Zach's four real decks. The
// order here is DISPLAY order; the tie-break order that decides which role a
// card gets lives in backend/src/cardRoles.js ROLE_ROOTS and is not the same
// thing -- a wipe outranks removal when classifying, but reads after it here.
export const ROLES = [
  { id: 'threat', key: 'curve.roleThreats' },
  { id: 'ramp', key: 'curve.roleRamp' },
  { id: 'draw', key: 'curve.roleDraw' },
  { id: 'removal', key: 'curve.roleInteraction' },
  { id: 'wipe', key: 'curve.roleWipe' },
  { id: 'counter', key: 'curve.roleCounter' },
  { id: 'tutor', key: 'curve.roleTutor' },
  { id: 'protection', key: 'curve.roleProtection' },
  { id: 'recursion', key: 'curve.roleRecursion' },
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

export default function CurveTab({ cards, commander, onOverrideRole, onSelectCard }) {
  // useT() returns the CONTEXT ({ locale, setLocale, t }), not the function.
  // Destructure it -- `const t = useT()` typechecks fine and then throws
  // "a is not a function" at the first call, which is how this first shipped.
  const { t } = useT();
  const [filter, setFilter] = useState(null);   // {bucket, role} | {turn} | null
  const [hotRole, setHotRole] = useState(null);
  const [hover, setHover] = useState(null);   // the card being previewed
  // WHICH ROW IS EXPANDED.
  //
  // Zach: "On desktop it opens as a DROP DOWN not a modal I want the same
  // action phone. I don't need the whole card detail modal I just want the
  // drop down the desktop has."
  //
  // This is what the APPROVED PROTOTYPE did -- curve.html expands a detail row
  // inside the list. I never built it into the real app: I wired clicks to the
  // side pane on desktop and the full card modal on the phone, neither of
  // which is what he signed off.
  //
  // Identical at both widths, so there is one behaviour to learn.
  const [openCard, setOpenCard] = useState(null);
  // WHICH TURN THE COLOUR ODDS ANSWER FOR. Was hardcoded to 3.
  const [colourTurn, setColourTurn] = useState(3);

  // The spells the chart describes: nonland, and not the considering pile --
  // considering cards are not in the deck yet, so counting them would tell you
  // your curve is fixed by cards you have not added.
  // ONE ENTRY PER CASTABLE FACE, not per card.
  //
  // A modal DFC is two spells you pay for, so Tony Stark appears at 2 AND at
  // 6. Zach: "technically I still need 6 mana to play his flip side."
  //
  // flatMap, because most cards yield one entry and modal DFCs yield two. Each
  // gets its own id suffix so React keys, the expanded dropdown and the
  // hard-to-cast map all address a FACE rather than a card -- otherwise
  // clicking the six-drop would open the two-drop's details.
  const spells = useMemo(() => (cards || [])
    .filter((c) => c.board !== 'considering' && !isLand(c))
    .flatMap((c) => curveEntriesFor(c).map((entry) => ({
      ...c,
      ...entry,
      id: entry.faceIndex ? `${c.id}#${entry.faceIndex}` : c.id,
      cardId: c.id,
      // THE ROW IS A FACE, SO IT IS NAMED AS THE FACE.
      //
      // Zach: "Why does it say Tony stark and not the invincible iron man
      // because that's wrong." Both rows were showing the joined card name,
      // so the six-drop row was labelled with the two-drop's name. The
      // display_name fallback was the culprit -- it carries the full
      // 'A // B' string and was overriding the face name on face 0.
      name: entry.faceName || c.name,
      display_name: entry.faceName || c.display_name || c.name,
      type_line: entry.faceType || c.type_line,
      mana_cost: entry.faceCost || c.mana_cost,
      // ONLY THIS FACE'S TEXT AND ART.
      //
      // The six-drop row was showing the front face's picture and BOTH faces'
      // rules text, because oracle_text is stored joined with === headers and
      // the back face has its own image_url. Zach: "it should say the
      // invincible iron man for the 6 mana one and only have that card
      // description."
      oracle_text: entry.faceText ?? c.oracle_text,
      image_url: entry.faceImage || c.image_url,
      // THE FACE'S OWN ROLE. Zach: "Roost Seek is being considered a threat
      // when its ramp." The back face of an Adventure is a Sorcery, not a
      // creature, so it gets classified on its own terms. Falls back to the
      // card role when the catalogue has not been re-imported yet.
      role: (entry.faceIndex === 1 ? c.back_card_role : c.card_role) || c.card_role || 'other',
      role_source_tag: entry.faceIndex === 1
        ? (c.back_role_source_tag ?? c.role_source_tag)
        : c.role_source_tag,
      role_is_override: entry.faceIndex === 1
        ? c.back_role_is_override
        : c.role_is_override,
    }))),
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

  // COLOUR SOURCES. Memoised because it walks every card, and it only changes
  // when the deck does.
  const colourSources = useMemo(() => sourceCounts(cards), [cards]);

  // ONLY THE COMMANDER'S COLOURS.
  //
  // Zach: "iron man deck can only have red and blue, the other colors don't
  // make sense." He is right, and the cause was counting SOURCES rather than
  // the deck's identity: Command Tower and Exotic Orchard report all five
  // colours in produced_mana, so a two-colour deck showed white, black and
  // green sources it can never use.
  //
  // Commander identity is the rule the deck is actually built under, so it is
  // the right filter. Falls back to whatever the deck produces when there is
  // no commander (a non-EDH deck), rather than showing nothing.
  const deckColours = useMemo(() => {
    const identity = new Set();
    for (const card of cards || []) {
      if (card.board !== 'commander') continue;
      const ci = Array.isArray(card.color_identity)
        ? card.color_identity
        : JSON.parse(card.color_identity || '[]');
      // color_identity is stored as NAMES ('Blue'), not letters.
      for (const name of ci) {
        const letter = COLOUR_LETTERS[name] || (COLOURS.includes(name) ? name : null);
        if (letter) identity.add(letter);
      }
    }
    return identity;
  }, [cards]);

  const liveColours = COLOURS.filter((c) => (
    deckColours.size ? deckColours.has(c) : colourSources[c] > 0
  ));

  // PER-CARD CASTABILITY, for the one card being previewed.
  //
  const matches = (c) => {
    if (!filter) return true;
    if (filter.turn != null) return c.mv <= filter.turn;
    return bk(c) === filter.bucket && c.role === filter.role;
  };

  // CLICKING A ROLE IN THE LEGEND FILTERS THE LIST TOO.
  //
  // Zach: "if I click ramp it highlights in the bar graph but doesn't sort
  // cards below but it should." It only dimmed the chart, which made the
  // legend look like a display toggle rather than a filter -- and left the
  // list showing 49 cards while the chart showed 12.
  const roleMatches = (c) => !hotRole || c.role === hotRole;

  const shown = spells.filter((c) => matches(c) && roleMatches(c));

  // WHICH CARDS ARE HARD TO CAST ON CURVE.
  //
  // THIS IS THE NUMBER THAT HAS TO REACH THE PHONE. There is no hover there,
  // so the tooltip cannot be the only place it lives -- the row itself has to
  // carry it.
  //
  // Only for the SHOWN list, and only while that list is short: each card is
  // ~1500 simulated hands, so doing all 100 on every render would be seconds.
  // Filter the chart first and the flags appear; that is also when you are
  // actually asking the question.
  // CASTABILITY FOR EVERY CARD.
  //
  // Zach: "the castable on turn 1 percentage why doesnt it show on every card".
  // Three reasons it was patchy, all mine: I skipped the whole list above 40
  // rows, only kept cards under 50%, and skipped colourless costs entirely.
  //
  // The cost argument was real but I measured it wrong: the simulation is
  // ~1500 hands per card, and 100 cards is ~15ms in practice, not seconds. So
  // it now runs for every card in the deck, memoised on the deck rather than
  // on the filtered list so filtering does not recompute it.
  //
  // A colourless cost still gets a number -- it is the land odds for its mana
  // value, which is exactly the question "can I cast this on curve".
  const castPercents = useMemo(() => {
    const out = {};
    for (const c of spells) {
      const turn = Math.max(1, Math.round(c.mv || 0));
      const p = castOdds(cards, c, turn, { trials: 1500 });
      if (p != null) out[c.id] = Math.round(p * 100);
    }
    return out;
  }, [spells, cards]);

  // Computed here rather than per row: this simulates thousands of hands, and
  // doing it for all 100 cards on every render would be ~600 simulations. For
  // the single hovered card it is a few milliseconds.
  // THE HOVERED CARD'S ODDS.
  //
  // Reads the SAME castPercents map the rows and the dropdown use. It used to
  // recompute its own value and bail early on colourless costs -- a leftover
  // from when castOdds() returned null for them. I fixed castOdds but not
  // this, so Sol Ring showed a percentage on its row and nothing in the hover
  // or the dropdown. Zach: "on hover and on click... not all cards show
  // castable on turn x why is that?"
  //
  // One source, three places to read it: they cannot disagree again.
  const hoverOdds = useMemo(() => {
    if (!hover) return null;
    const pct = castPercents[hover.id];
    if (pct == null) return null;
    return { turn: Math.max(1, Math.round(hover.mv || 0)), pct };
  }, [hover, castPercents]);

  const mvs = spells.map((c) => c.mv).sort((a, b) => a - b);
  const avg = mvs.length ? (mvs.reduce((s, n) => s + n, 0) / mvs.length).toFixed(2) : '0';
  const median = mvs.length ? mvs[Math.floor(mvs.length / 2)] : 0;
  const rampCount = spells.filter((c) => c.role === 'ramp').length;
  const bigCount = spells.filter((c) => c.mv >= 6).length;

  const roleLabel = (id) => t(ROLES.find((r) => r.id === id).key);

  // WHERE THE HOVER PREVIEW SITS.
  //
  // Measured, not guessed, because two fixed-corner attempts both failed:
  // bottom-left was a screen away from the cursor, and beside-the-list put the
  // box straight over the bars. The rules are:
  //
  //   1. level with the row you are pointing at, so the eye does not travel
  //   2. NEVER above the chart's bottom edge -- the chart is what the preview
  //      is helping you read
  //   3. never past the bottom of the window
  //
  // Written as a CSS variable rather than inline styles so the media query
  // still owns the layout: on a phone .curve-tip is display:none and this
  // value is simply ignored.
  const placeTip = (rowEl) => {
    if (typeof window === 'undefined' || !rowEl) return;
    const row = rowEl.getBoundingClientRect();
    const tip = document.querySelector('.curve-tip');
    const tipH = (tip && tip.getBoundingClientRect().height) || 200;

    // OVER THE LIST, NEVER OVER THE CHART.
    //
    // Three attempts failed before this, all trying to place the box in the
    // LEFT column: bottom-left was a screen away from the cursor, beside-the-
    // list sat straight on the bars, and "below the chart" is impossible on
    // Zach's actual window -- measured 1855x731 with the chart ending at
    // y=687, which leaves 44px.
    //
    // So the box goes over the LIST pane instead. The list starts right of
    // where the chart ends (measured: list x=1356, chart right edge 1320), so
    // this cannot overlap the chart at any height. It costs a few list rows,
    // which you can scroll back to -- the chart is the thing you are reading
    // while you hover, and it stays whole.
    const top = Math.max(8, Math.min(row.top, window.innerHeight - tipH - 12));
    document.documentElement.style.setProperty('--tip-top', `${Math.round(top)}px`);
  };
  const filterLabel = () => {
    if (filter) {
      if (filter.turn != null) return t('curve.castableByTurn', { turn: filter.turn });
      return `${roleLabel(filter.role)} · ${t('curve.mv')} ${filter.bucket === 7 ? '7+' : filter.bucket}`;
    }
    // A legend role is also a filter, so it needs a Clear affordance too --
    // otherwise the list silently shows a subset with nothing saying why.
    if (hotRole) return roleLabel(hotRole);
    return null;
  };

  const clearFilters = () => { setFilter(null); setHotRole(null); };

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

        {/* THE DECK MIX BAR, replacing the old swatch legend.
            With ten categories a legend is a list to read; this is one row
            you glance at. It doubles as the filter control, so there is one
            place to click rather than two that must agree. Roles with zero
            cards are omitted -- ten labels where three are empty buries the
            signal. */}
        <div className="curve-mix">
          {ROLES.map((r) => {
            const n = spells.filter((c) => c.role === r.id).length;
            if (!n) return null;
            const pct = (n / Math.max(1, spells.length)) * 100;
            return (
              <button
                key={r.id}
                type="button"
                className={`curve-${r.id}${hotRole && hotRole !== r.id ? ' dim' : ''}`}
                style={{ width: `${pct}%` }}
                title={`${roleLabel(r.id)}: ${n}`}
                aria-label={`${roleLabel(r.id)}: ${n}`}
                onClick={() => setHotRole(hotRole === r.id ? null : r.id)}
              >
                {/* The count only fits above ~7%; the title carries it either way. */}
                {pct > 7 ? n : ''}
              </button>
            );
          })}
        </div>
        <div className="curve-mixkey">
          {ROLES.map((r) => {
            const n = spells.filter((c) => c.role === r.id).length;
            if (!n) return null;
            return (
              <button
                key={r.id}
                type="button"
                className={hotRole && hotRole !== r.id ? 'dim' : ''}
                onClick={() => setHotRole(hotRole === r.id ? null : r.id)}
              >
                <i className={`curve-${r.id}`} />
                {roleLabel(r.id)} <b>{n}</b>
              </button>
            );
          })}
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

      {/* COLOUR SOURCES.
          The other half of "can I cast this". Land COUNT says you have three
          mana; this says whether they are the right three. Zach: "three lands
          that cannot cast your three-drop is not three mana."

          Only the colours the deck actually plays -- five rows with three
          zeroes would bury the signal. */}
      {liveColours.length > 0 && (
        <div className="curve-panel">
          <div className="curve-head">
            <b>{t('curve.colourSources')}</b>
            <span>{t('curve.byTurnN', { turn: colourTurn })}</span>
          </div>
          <div className="curve-colours">
            {liveColours.map((colour) => {
              const n = colourSources[colour];
              // ODDS OF A SOURCE BY THE SELECTED TURN.
              //
              // Zach: "I asked for the turns selection to filter on color
              // source so I could see percentage of what color I might get on
              // turn 1 not just turn 3." Turn 3 was hardcoded, so the panel
              // answered a question he had not asked.
              //
              // Cards seen by turn N on the play: 7 opening + (N-1) draws.
              const p = probLandsByTurn(librarySize, n, 1, 6 + colourTurn);
              return (
                <div key={colour} className="curve-colour">
                  <i className={`curve-pip curve-pip-${colour}`}>{colour}</i>
                  <span className="curve-colour-n">
                    {t('curve.sourcesN', { n })}
                  </span>
                  <span className="curve-colour-bar">
                    <i style={{ width: `${Math.round(p * 100)}%` }} />
                  </span>
                  <span className={`curve-colour-p${n < 14 ? ' low' : ''}`}>
                    {Math.round(p * 100)}%
                  </span>
                </div>
              );
            })}
          </div>
          {/* TURN PICKER for the colour odds. The turn rows above filter the
              CARD LIST, which is a different question -- this one asks "what
              are my chances of having this colour by then". */}
          <div className="curve-turnpick">
            {[1, 2, 3, 4, 5, 6].map((turn) => (
              <button
                key={turn}
                type="button"
                className={colourTurn === turn ? 'on' : ''}
                onClick={() => setColourTurn(turn)}
              >
                {turn}
              </button>
            ))}
          </div>
          <p className="curve-assumes">{t('curve.colourAssume')}</p>
        </div>
      )}

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
            <button type="button" onClick={clearFilters}>{t('curve.clear')}</button>
          </div>
        ) : (
          <div className="curve-listhint">
            {t('curve.allNonland', { count: shown.length, n: shown.length })}
          </div>
        )}
        <div className="curve-list">
          {shown
            .slice()
            // Cheapest first: the list is read alongside the curve, so it
            // should run the same way the bars do.
            .sort((a, b) => a.mv - b.mv || (a.name || '').localeCompare(b.name || ''))
            .map((c) => (
              <div key={c.id} className="curve-row-wrap">
              <button
                type="button"
                className={`curve-row${openCard === c.id ? ' open' : ''}`}
                aria-expanded={openCard === c.id}
                // CLICK EXPANDS A DROPDOWN IN THE LIST, at BOTH widths.
                // Not the side pane, not the full card modal -- this is what
                // the approved prototype did and what Zach asked for again.
                onClick={() => setOpenCard(openCard === c.id ? null : c.id)}
                // HOVER PREVIEWS, as in the prototype. The list is 49+ rows of
                // names, and a name does not tell you what a card does -- that
                // was the whole point of putting rules text in the tooltip.
                // Pointer events only: on a phone there is no hover and the
                // tap opens the card, which is the same information.
                onMouseEnter={(e) => { setHover(c); placeTip(e.currentTarget); }}
                onMouseLeave={() => setHover(null)}
                // Keyboard parity: the preview is the only place the rules text
                // appears without opening the card, so tabbing must reach it.
                onFocus={(e) => { setHover(c); placeTip(e.currentTarget); }}
                onBlur={() => setHover(null)}
              >
                <i className={`curve-dot curve-${c.role}`} />
                <span className="curve-row-name">
                  <b>{c.display_name || c.name}</b>
                  <span className="curve-row-what">{gist(c.oracle_text)}</span>
                </span>
                {c.note && <span className="curve-note-pill">{c.note}</span>}
                {/* CASTABLE ON CURVE, on every row. Amber under 50% so the
                    awkward ones still stand out without hiding the rest. */}
                {castPercents[c.id] != null && (
                  <span className={`curve-hard-pill${castPercents[c.id] < 50 ? ' low' : ''}`}
                        title={t('curve.castOnTurn', {
                          turn: Math.max(1, Math.round(c.mv || 0)),
                          pct: castPercents[c.id] })}>
                    {castPercents[c.id]}%
                  </span>
                )}
                <span className="curve-row-mv">{c.mv}</span>
              </button>

              {/* THE DROPDOWN. Expands in place, under the row you clicked,
                  identically on desktop and phone. */}
              {openCard === c.id && (
                <div className="curve-detail">
                  {c.image_url && (
                    <img className="curve-detail-img" src={c.image_url}
                         alt="" loading="lazy" />
                  )}
                  <div className="curve-detail-body">
                    <div className="curve-detail-title">
                      <b>{c.display_name || c.name}</b>
                      <ManaCost cost={c.mana_cost} />
                    </div>
                    <div className="curve-detail-type">{c.type_line}</div>
                    <div className="curve-detail-text">
                      {c.oracle_text || t('curve.noRulesText')}
                    </div>
                    <div className="curve-detail-meta">
                      <span style={{ color: `var(--curve-${c.role}, inherit)` }}>
                        {roleLabel(c.role)}
                      </span>
                      {' · '}
                      {c.role_is_override
                        ? t('curve.whyOverride')
                        : c.role_source_tag
                          ? t('curve.whyTag', { tag: c.role_source_tag })
                          : t('curve.whyTypeLine')}
                      {' · '}
                      {t('curve.mv')} {c.mv}
                    </div>
                    {/* CASTABLE ON CURVE. Zach: "when I click on the card and
                        it does the drop down I would expect it to show there
                        as well." It was hover-only, so the phone never saw the
                        reasoning at all. */}
                    {castPercents[c.id] != null && (
                      <div className={`curve-detail-cast${castPercents[c.id] < 50 ? ' low' : ''}`}>
                        {t('curve.castOnTurn', {
                          turn: Math.max(1, Math.round(c.mv || 0)),
                          pct: castPercents[c.id],
                        })}
                      </div>
                    )}
                    {/* The rule-breaks explain themselves where you would
                        question them, not in a footnote. */}
                    {c.note && (
                      <div className="curve-detail-note">
                        {t(NOTE_KEYS[c.note] || 'curve.note.nocost')}
                      </div>
                    )}
                    {/* Open the full card only if you actually want it. */}
                    {onSelectCard && (
                      <button
                        type="button"
                        className="curve-detail-more"
                        onClick={() => onSelectCard({ ...c, id: c.cardId || c.id })}
                      >
                        {t('curve.fullCard')}
                      </button>
                    )}
                  </div>
                </div>
              )}
              </div>
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
          {/* CAN YOU ACTUALLY CAST IT ON CURVE. Simulated for this card's
              exact cost, so double pips and dual lands are both handled, and
              shown for EVERY card -- a colourless cost still has an answer,
              it is just the land count rather than the colours. */}
          {hoverOdds && (
            <div className={`curve-tip-cast${hoverOdds.pct < 50 ? ' low' : ''}`}>
              {t('curve.castOnTurn', {
                turn: hoverOdds.turn, pct: hoverOdds.pct })}
            </div>
          )}
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
