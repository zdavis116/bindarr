// NO UNDEFINED REFERENCES IN COMPONENT CODE.
//
// Zach: "in deck list when I click on a deck nothing happens doesnt load me
// into deck view."
//
// The cause was one word. When DeckCard was extracted into its own component,
// DeckList's call site kept the CARD's prop name:
//
//     onOpen={(id) => (selecting ? toggle(id) : onOpen(id))}
//                                               ^^^^^^ the prop here is
//                                                      named onOpenDeck
//
// `onOpen` exists nowhere in DeckList's scope, so every deck click threw
// "ReferenceError: onOpen is not defined" and did nothing. The build compiled
// happily -- a bare identifier is only an error when the line RUNS -- and no
// existing guard covered it, because all of them read source text rather than
// executing it.
//
// A second live bug fell out of the same check: DeckView's role-save handler
// called setError(), which does not exist in that component, so the one path
// meant to REPORT a failure threw its own ReferenceError instead.
//
// This runs eslint's no-undef over the real source. It is the cheapest
// possible check for the whole class -- typos, renamed props, deleted state
// setters, imports removed while a call site remains.

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');

let passed = 0;
const pass = (id, what) => { passed += 1; console.log(`PASS: ${id} ${what}`); };

// --- UND-TC1 -----------------------------------------------------------------
{
  // Browser globals only, and only the app's own source -- test files use
  // `process`, which is legitimately undefined in a browser env and would be
  // 14 false positives.
  // --ext is REQUIRED. Given a directory, eslint lints .js only and silently
  // skips every .jsx -- so the first version of this guard passed while the
  // exact bug it was written for sat in DeckList.jsx untouched. Mutation
  // testing is what caught that; the guard "passed" either way.
  let out = '';
  try {
    out = execFileSync('npx', [
      '--prefix', 'frontend', 'eslint',
      '--no-eslintrc',
      '--ext', '.js,.jsx',
      '--parser-options=ecmaVersion:2022,sourceType:module,ecmaFeatures:{jsx:true}',
      '--rule', '{"no-undef":"error"}',
      '--env', 'browser,es2022',
      '--format', 'compact',
      'frontend/src/components',
      'frontend/src/utils',
    ], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // eslint exits non-zero when it reports anything, including the
    // rule-not-found noise from the repo's own plugin config.
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }

  const undef = out
    .split('\n')
    .filter((l) => l.includes('no-undef'))
    // Node globals in files that legitimately run under Node.
    .filter((l) => !/'(process|require|module|__dirname)' is not defined/.test(l));

  assert.equal(undef.join('\n'), '',
    'a component referenced something that does not exist in its scope. This '
    + 'compiles and only fails when the line RUNS -- which is how clicking a '
    + 'deck did nothing for a day:\n' + undef.join('\n'));

  pass('UND-TC1', 'no undefined references in components or utils');
}

console.log(`no-undef.test.js: ${passed} cases passed`);
