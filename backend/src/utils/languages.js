// Scryfall language aliases retained for interface compatibility. Card operations
// in the MTG-only backend currently force English regardless of legacy inputs.
const LANGUAGES = [
  { code: 'en', name: 'English', scryfall: 'en' },
  { code: 'ja', name: 'Japanese', scryfall: 'ja' },
  { code: 'de', name: 'German', scryfall: 'de' },
  { code: 'fr', name: 'French', scryfall: 'fr' },
  { code: 'es', name: 'Spanish', scryfall: 'es' },
  { code: 'it', name: 'Italian', scryfall: 'it' },
  { code: 'pt', name: 'Portuguese', scryfall: 'pt' },
  { code: 'ko', name: 'Korean', scryfall: 'ko' },
  { code: 'ru', name: 'Russian', scryfall: 'ru' },
  { code: 'zh-tw', name: 'Chinese (Traditional)', scryfall: 'zht' },
  { code: 'zh-cn', name: 'Chinese (Simplified)', scryfall: 'zhs' },
];

const DEFAULT = LANGUAGES[0];
const byCode = new Map(LANGUAGES.map(l => [l.code, l]));
const byName = new Map(LANGUAGES.map(l => [l.name.toLowerCase(), l]));
const byProvider = new Map(LANGUAGES.map(l => [l.scryfall, l]));

function resolve(input) {
  if (!input) return DEFAULT;
  const lower = String(input).trim().toLowerCase();
  return byCode.get(lower) || byName.get(lower) || byProvider.get(lower) || DEFAULT;
}

const toCode = input => resolve(input).code;
const toName = input => resolve(input).name;
const isEnglish = input => resolve(input).code === 'en';

module.exports = { LANGUAGES, DEFAULT, resolve, toCode, toName, isEnglish };
