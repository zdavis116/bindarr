import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { GAMES, enabledGames, defaultGame, defaultGameFilter, gameOptions, showGamePicker } = await import('./games.js');
const { getPrintings } = await import('./cardOptions.js');

assert.deepEqual(GAMES, [{ value: 'mtg', label: 'Magic: The Gathering', short: 'MTG' }]);
assert.deepEqual(enabledGames(), ['mtg']);
assert.deepEqual(gameOptions().map(({ value }) => value), ['mtg']);
assert.equal(defaultGame(), 'mtg');
assert.equal(defaultGameFilter(), 'mtg');
assert.equal(showGamePicker(), false);
// PR 6E: the picker now offers the CANONICAL MTG finishes the backend stores,
// so what the UI submits is exactly what deck identity matches on.
assert.deepEqual(getPrintings(), [
  { value: 'nonfoil', label: 'Nonfoil' },
  { value: 'foil', label: 'Foil' },
  { value: 'etched', label: 'Etched' },
]);

// Product boundary: provider, alternate-game and printed-card-language controls
// must not silently return. Interface translation is intentionally out of scope.
const productFiles = [
  'components/Settings.jsx',
  'components/CardSearch.jsx',
  'components/CameraScanner.jsx',
  'utils/deckText.js',
  'components/Dashboard.jsx',
  'components/CollectionList.jsx',
  'components/AdminPanel.jsx',
  'components/CreateContainerModal.jsx',
  'components/SetBrowserModal.jsx',
  'components/DeckBuilder.jsx',
  'components/SortFilterBuilder.jsx',
  'components/SharedCollection.jsx',
];
// 'Holofoil' as a FINISH VALUE joins the list in PR 6E. It was the leftover
// pre-fork finish that made every foil add fail with a 500, and the regex
// previously only caught 'Reverse Holofoil' -- so the exact value causing the
// outage was allowed through the guard that existed to catch it.
//
// Matched as a quoted string literal, not a bare word: `price_holofoil` is a
// legitimate card_cache column name (Scryfall's usd_foil) that must stay.
const forbidden = /pok[eé]mon|pokemontcg|tcgdex|showGamePicker|gameOptions|cardLanguage|LANGUAGE_NAMES|searchLang|languageFilter|language-asc|specLanguage|activeCard\.language|autoLanguage|ptcgl|['"](Reverse )?Holofoil['"]|['"]1st Edition['"]/i;
const productFiles2 = ['utils/cardPrinting.js', 'utils/cardOptions.js', 'utils/resolveCardPrice.js', 'utils/cardSort.js'];
for (const relative of [...productFiles, ...productFiles2]) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const match = source.match(forbidden);
  if (match) throw new Error(`${relative} contains removed product term "${match[0]}"`);
}

for (const removedUtility of ['utils/languages.js', 'utils/langHelper.js']) {
  assert.equal(fs.existsSync(path.join(root, removedUtility)), false, `${removedUtility} must stay removed`);
}

// /api/sets is MTG-only and no longer returns a game field. Its prefixed IDs
// must still line up with the bare `mtg|<code>` keys returned by set-index builds.
const adminPanelSource = fs.readFileSync(path.join(root, 'components/AdminPanel.jsx'), 'utf8');
assert.match(
  adminPanelSource,
  /const code = s\.id\.startsWith\('mtg-'\) \? s\.id\.slice\(4\) : s\.id;/,
  'AdminPanel must strip mtg- from /api/sets IDs without requiring s.game',
);
assert.match(
  adminPanelSource,
  /map\[`mtg\|\$\{code\}`\] = s\.name;/,
  'AdminPanel must key MTG set names like set-index builds do',
);

const interfaceLanguageHints = {
  de: 'Ändert die Sprache der Benutzeroberfläche in Bindarr.',
  en: 'Changes the interface language used throughout Bindarr.',
  es: 'Cambia el idioma de la interfaz en todo Bindarr.',
  fr: 'Change la langue de l’interface dans tout Bindarr.',
  it: "Cambia la lingua dell'interfaccia in tutto Bindarr.",
  ja: 'Bindarr 全体で使用されるインターフェースの言語を変更します。',
  ko: 'Bindarr 전체에서 사용하는 인터페이스 언어를 변경합니다.',
  'pt-BR': 'Muda o idioma da interface em todo o Bindarr.',
  ru: 'Меняет язык интерфейса во всём Bindarr.',
  'zh-Hans': '更改整个 Bindarr 使用的界面语言。',
  'zh-Hant': '變更整個 Bindarr 使用的介面語言。',
};
for (const [locale, expectedHint] of Object.entries(interfaceLanguageHints)) {
  const messages = JSON.parse(fs.readFileSync(path.join(root, 'locales', `${locale}.json`), 'utf8'));
  assert.equal(
    messages['prefs.languageHint'],
    expectedHint,
    `${locale} prefs.languageHint must describe only the interface locale`,
  );
}

console.log('MTG-only frontend self-check passed');
