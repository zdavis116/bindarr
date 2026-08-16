import assert from 'node:assert/strict';
import {
  GAMES, enabledGames, isGameEnabled, showGamePicker, gameOptions,
  setGameEnabled, defaultGame, defaultGameFilter, gameLabel,
} from './games.js';

assert.deepEqual(GAMES, [{ value: 'mtg', label: 'Magic: The Gathering', short: 'MTG' }]);
assert.deepEqual(enabledGames(), ['mtg']);
assert.equal(isGameEnabled('mtg'), true);
assert.equal(isGameEnabled('pokemon'), false);
assert.equal(showGamePicker(), false);
assert.deepEqual(gameOptions(), GAMES);
assert.equal(setGameEnabled('mtg', false), false);
assert.equal(defaultGame(), 'mtg');
assert.equal(defaultGameFilter(), 'mtg');
assert.equal(gameLabel('mtg'), 'Magic: The Gathering');
assert.equal(gameLabel('mtg', true), 'MTG');

console.log('games self-check passed');
