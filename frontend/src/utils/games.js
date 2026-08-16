// Bindarr is an MTG-only application. Keep this tiny compatibility surface while
// views are migrated away from the old multi-game helpers.
export const GAMES = [{ value: 'mtg', label: 'Magic: The Gathering', short: 'MTG' }];

export const enabledGames = () => ['mtg'];
export const isGameEnabled = (game) => String(game || '').toLowerCase() === 'mtg';
export const showGamePicker = () => false;
export const gameOptions = () => GAMES;
export const setGameEnabled = () => false;
export const defaultGame = () => 'mtg';
export const defaultGameFilter = () => 'mtg';
export const gameLabel = (_game, short = false) => (short ? 'MTG' : 'Magic: The Gathering');
