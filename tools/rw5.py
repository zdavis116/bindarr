import re

p = 'backend/test/e2e/colour_identity_availability.test.js'
s = open(p).read()

def replace_case(src, tag, body):
    start = src.index(f"test('{tag}'")
    nxt = src.index("test('F15-TC", start + 10)
    return src[:start] + body + src[nxt:]

CASES = {
 'F15-TC43': """test('F15-TC43', 'REPRO A: an off-colour card enters and the deck says so',
  async ({ owner }) => {
    // ORIGINALLY: "REPRO A is UNREACHABLE: the command zone cannot be emptied
    // at all" -- written when a green card entering an Izzet deck was the bug.
    //
    // Under the permissive rule that entry is expected. What must NOT happen
    // is the deck going quiet about it, so that is what this now checks. The
    // original bug was never "a green card exists in a deck"; it was "a green
    // card exists in a deck and nothing says so".
    const deckId = await createDeck(owner.token, 'PR6G ReproA', ['ci-cmd-ur']);

    const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(response.status, 200, 'the card enters');

    const deck = await api(owner.token, `/api/decks/${deckId}`);
    const warnings = JSON.stringify(deck.body && deck.body.warnings);
    assert.ok(/OFF_COLOUR/.test(warnings),
      `THE DECK MUST NOT GO QUIET about an off-colour card: ${warnings}`);
    assert.ok(/kodama/i.test(warnings),
      `and it must name the card, not just count it: ${warnings}`);
  });

""",
 'F15-TC53b': """test('F15-TC53b', 'a move that strands the moved card is allowed and reported',
  async ({ owner }) => {
    // Moving a commander off the zone can leave the deck with cards outside
    // the remaining identity -- including the moved card itself. That is now
    // permitted and reported rather than refused.
    const deckId = await createDeck(owner.token, 'PR6G Strand',
      ['ci-partner-r', 'ci-partner-g']);

    const rows = await deckRows(deckId);
    const green = rows.find(r => r.desired_card_id === 'ci-partner-g');

    const response = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-partner-g', desired_finish: 'nonfoil',
        board: 'mainboard', replacing_deck_card_id: green.id
      }
    });

    assert.strictEqual(response.status, 200,
      `the move must be allowed: ${JSON.stringify(response.body)}`);

    // The green card is now in a red-only deck, and the deck must say so --
    // otherwise the move silently makes the deck illegal.
    const deck = await api(owner.token, `/api/decks/${deckId}`);
    assert.ok(/OFF_COLOUR/.test(JSON.stringify(deck.body && deck.body.warnings)),
      'a move that strands a card must be reported');
  });

""",
 'F15-TC55': """test('F15-TC55', 'moving a card ONTO the commander board is allowed and reported',
  async ({ owner }) => {
    // An artifact becoming a commander was refused. It is now accepted and
    // reported as COMMANDER_ILLEGAL, which is the same fact delivered later.
    const deckId = await createDeck(owner.token, 'PR6G ZoneMove', ['ci-cmd-ur']);
    const add = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: { desired_card_id: 'ci-artifact', desired_finish: 'nonfoil' }
    });
    assert.strictEqual(add.status, 200, 'setup: the artifact must save');

    const rows = await deckRows(deckId);
    const artifact = rows.find(r => r.desired_card_id === 'ci-artifact');
    const commander = rows.find(r => r.board === 'commander');

    const move = await api(owner.token, `/api/decks/${deckId}/cards`, {
      method: 'POST',
      body: {
        desired_card_id: 'ci-artifact', desired_finish: 'nonfoil',
        board: 'commander', replacing_deck_card_id: commander.id
      }
    });

    assert.strictEqual(move.status, 200,
      `the zone move must be allowed: ${JSON.stringify(move.body)}`);
    void artifact;

    const deck = await api(owner.token, `/api/decks/${deckId}`);
    assert.ok(/COMMANDER_ILLEGAL/.test(JSON.stringify(deck.body && deck.body.warnings)),
      'an artifact commander must be reported as illegal');
  });

""",
 'F15-TC56': """test('F15-TC56', 'EVERY verb that changes the deck reports what is wrong',
  async ({ owner }) => {
    // ORIGINALLY: "EVERY verb ... ends in a state that satisfies the rules",
    // asserting that add / move / re-pin each REFUSED an illegal result.
    //
    // The invariant flipped with the rule, and the systematic sweep is still
    // the valuable part: no mutation path may leave a deck illegal AND SILENT.
    // That is the property that actually protects Zach -- a refusal he can
    // work around, a silent wrong deck he cannot.
    const verbs = [];

    // ADD an off-colour card.
    {
      const deckId = await createDeck(owner.token, 'PR6G Verb Add', ['ci-cmd-ur']);
      const r = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST',
        body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil' }
      });
      const deck = await api(owner.token, `/api/decks/${deckId}`);
      verbs.push(['add', r.status, JSON.stringify(deck.body && deck.body.warnings)]);
    }

    // RE-PIN an existing entry onto an off-colour printing.
    {
      const deckId = await createDeck(owner.token, 'PR6G Verb Repin', ['ci-cmd-ur']);
      await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST',
        body: { desired_card_id: 'ci-onid', desired_finish: 'nonfoil' }
      });
      const rows = await deckRows(deckId);
      const entry = rows.find(r => r.desired_card_id === 'ci-onid');
      const r = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST',
        body: {
          desired_card_id: 'ci-kodama', desired_finish: 'nonfoil',
          replacing_deck_card_id: entry.id
        }
      });
      const deck = await api(owner.token, `/api/decks/${deckId}`);
      verbs.push(['repin', r.status, JSON.stringify(deck.body && deck.body.warnings)]);
    }

    // MOVE a considering card onto the mainboard.
    {
      const deckId = await createDeck(owner.token, 'PR6G Verb Move', ['ci-cmd-ur']);
      await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST',
        body: { desired_card_id: 'ci-kodama', desired_finish: 'nonfoil', board: 'considering' }
      });
      const rows = await deckRows(deckId);
      const entry = rows.find(r => r.desired_card_id === 'ci-kodama');
      const r = await api(owner.token, `/api/decks/${deckId}/cards`, {
        method: 'POST',
        body: {
          desired_card_id: 'ci-kodama', desired_finish: 'nonfoil',
          board: 'mainboard', replacing_deck_card_id: entry.id
        }
      });
      const deck = await api(owner.token, `/api/decks/${deckId}`);
      verbs.push(['move', r.status, JSON.stringify(deck.body && deck.body.warnings)]);
    }

    for (const [verb, status, warnings] of verbs) {
      assert.strictEqual(status, 200, `verb ${verb}: must not be refused`);
      assert.ok(/OFF_COLOUR/.test(warnings),
        `verb ${verb}: left the deck illegal AND SILENT -- ${warnings}`);
    }
  });

""",
}

for tag, body in CASES.items():
    s = replace_case(s, tag, body)
    print(f'{tag} rewritten')

open(p, 'w').write(s)
