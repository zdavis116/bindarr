// PARSING A REAL MOXFIELD EXPORT.
//
// Zach pasted his 86-line Iron Man list with set codes and collector numbers,
// and cards went missing. Three separate faults, each of which loses a card
// silently -- the paste succeeds, the deck is short, and nothing says why.
//
// Every case here is a literal line from the file he sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeckLine } from './deckText.js';

test('DT-TC1: a double-faced card resolves to its FRONT face', () => {
  // "1 Tony Stark / The Invincible Iron Man (MSH) 80"
  //
  // This was his COMMANDER -- the one card a Commander deck cannot do without
  // -- and it matched nothing. The catalogue stores modal DFCs under the front
  // face alone ('Tony Stark', msh #80). Moxfield writes one slash, Scryfall's
  // own convention is two, and 931 cards in the catalogue use the latter.
  const single = parseDeckLine('1 Tony Stark / The Invincible Iron Man (MSH) 80');
  assert.equal(single.name, 'Tony Stark');
  assert.equal(single.set, 'MSH');
  assert.equal(single.number, '80');

  const double = parseDeckLine('1 Tony Stark // The Invincible Iron Man (MSH) 80');
  assert.equal(double.name, 'Tony Stark',
    "Scryfall's own ' // ' form must reduce the same way");
});

test('DT-TC2: a set-prefixed collector number is read, not glued to the name', () => {
  // "1 Master Transmuter (PLST) CON-31"
  //
  // The List reprints number cards as CON-31. The matcher only understood
  // digits, so the number came back undefined AND "CON-31" stayed welded to
  // the name -- producing "Master Transmuter CON-31", which matches nothing
  // however good the rest of the pipeline is.
  const p = parseDeckLine('1 Master Transmuter (PLST) CON-31');
  assert.equal(p.name, 'Master Transmuter');
  assert.equal(p.set, 'PLST');
  assert.equal(p.number, 'CON-31');
});

test('DT-TC3: a foil marker does not contaminate the name or number', () => {
  // "1 Archway of Innovation (MH3) 214 *F*"
  const p = parseDeckLine('1 Archway of Innovation (MH3) 214 *F*');
  assert.equal(p.name, 'Archway of Innovation');
  assert.equal(p.number, '214');
  assert.equal(p.finish, 'foil');
});

test('DT-TC4: a comma in the name survives, with a foil marker after it', () => {
  // "1 Rescue, Pepper Potts (MSC) 755 *F*"
  const p = parseDeckLine('1 Rescue, Pepper Potts (MSC) 755 *F*');
  assert.equal(p.name, 'Rescue, Pepper Potts');
  assert.equal(p.finish, 'foil');
});

test('DT-TC5: no parsed name retains a digit from the collector number', () => {
  // The general form of TC2. A name carrying a stray number matches nothing,
  // and the failure is invisible: the line parses, so it is never reported as
  // unreadable -- it just never finds a card.
  const lines = [
    '1 Steel Hellkite (FDN) 681',
    '10 Island (ORI) 259',
    '1 Master Transmuter (PLST) CON-31',
    '1 Iron Man, Bleeding Edge (MSC) 626',
    "1 An Offer You Can't Refuse (FIC) 267",
  ];
  for (const line of lines) {
    const p = parseDeckLine(line);
    assert.ok(p, `failed to parse: ${line}`);
    assert.doesNotMatch(p.name, /\d/,
      `name kept a digit from the collector number: ${JSON.stringify(p.name)}`);
  }
});

test('DT-TC6: quantity is honoured, not assumed to be one', () => {
  assert.equal(parseDeckLine('10 Island (ORI) 259').qty, 10);
  assert.equal(parseDeckLine('6 Mountain (WAR) 260').qty, 6);
});
