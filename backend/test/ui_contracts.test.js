const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '../../frontend/src/components');
const css = fs.readFileSync(path.join(__dirname, '../../frontend/src/index.css'), 'utf8');
const en = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../frontend/src/locales/en.json'), 'utf8'));

// THREE BUGS SHIPPED TO ZACH IN ONE EVENING, all invisible to build and lint:
//
//   1. useT() returns { locale, setLocale, t }. I wrote `const t = useT()`, so
//      every t('...') call was "t is not a function" and the panel threw on
//      mount -- "Well it errors when I press it".
//   2. className="form-input" with no .form-input rule: the printing dropdown
//      rendered black-on-white inside a dark modal. Worked, unreadable.
//   3. A t() key with no entry in en.json: the button label rendered blank.
//
// Each is a source-level fact, so each is checkable here rather than by Zach.

const components = fs.readdirSync(dir).filter(f => f.endsWith('.jsx'));

// Genuinely unstyled today, in CameraScanner. Real, pre-existing, and not this
// PR's to fix -- listed so the guard still protects every other component
// instead of being switched off.
const KNOWN_UNSTYLED = new Set([
  'modal-backdrop', 'animate-fade-in',   // CameraScanner
  'badge',                               // CheckoutWizardModal
  'empty'                                // CompartmentView
]);

test('UI-TC1: useT() is always destructured', () => {
  // The hook returns an object. Assigning it whole gives a `t` that is not
  // callable, and nothing catches that until the component mounts.
  const offenders = components.filter(f => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    return /const\s+t\s*=\s*useT\(\)/.test(src);
  });
  assert.deepEqual(offenders, [],
    'useT() returns { locale, setLocale, t } -- destructure it');
});

test('UI-TC2: every className has a CSS rule', () => {
  // A class matching no rule looks completely fine in review, which is exactly
  // why it reaches him. Inline-styled elements are unaffected.
  const missing = [];
  for (const f of components) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const used = new Set();
    for (const m of src.matchAll(/className="([^"{]+)"/g)) {
      m[1].split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    }
    for (const c of used) {
      if (KNOWN_UNSTYLED.has(c)) continue;
      // Anywhere in the sheet, not just at the start of a rule: `.card .badge`
      // styles .badge perfectly well.
      if (!new RegExp(`\\.${c.replace(/-/g, '\\-')}(?![\\w-])`).test(css)) {
        missing.push(`${f}: .${c}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'these class names match no CSS rule');
});

test('UI-TC3: every t() key exists in en.json', () => {
  // A missing key renders blank or as the raw key. The Moxfield entry point
  // shipped with no label for exactly this reason.
  const missing = [];
  for (const f of components) {
    // Strip comments first: a comment EXPLAINING a t() call is not a t() call.
    // My own note about the useT bug contains the literal t('...'), and the
    // checker dutifully reported '...' as a missing key.
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const m of src.matchAll(/\bt\('([\w.]+)'/g)) {
      const key = m[1];
      // A counted phrase lives as plural SIBLINGS -- "deck.cardsToBuy.one",
      // ".other" -- and Intl.PluralRules picks one at runtime. A flat lookup
      // calls every one of those missing; 42 of my first 46 "failures" were
      // this.
      const plural = ['zero', 'one', 'two', 'few', 'many', 'other']
        .some(c => `${key}.${c}` in en);
      if (!(key in en) && !plural) missing.push(`${f}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], 'these translation keys are not in en.json');
});
