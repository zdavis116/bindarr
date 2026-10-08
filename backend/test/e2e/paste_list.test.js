// PASTE A LIST — the parser and its route wiring.
//
// Zach: "I would like to add a paste a list feature... But it needs set code
// and number to be valid list."
//
// These tests CALL the parser rather than reading its source. A source-text
// assertion here would survive the exact mutations that matter (a regex that
// stops matching PLST numbers still contains the word "collector_number"), and
// this repo has shipped three vacuous guards of that shape already.

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { parseDecklist, finishFromTags } =
  require('../../src/utils/decklistParser');

// Strip comments before asserting on code: a mutation that comments a line out
// still leaves the text in the file, and a naive grep would match it.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function runTests() {
  // ---------------------------------------------------------------------
  // PL-TC1: Zach's actual paste. Every line, exactly as he sent it.
  // ---------------------------------------------------------------------
  try {
    const text = [
      '1 Yennett, Cryptic Sovereign (SLD) 2121 *F*',
      '1 Aboleth Spawn (CLB) 662',
      '1 Adarkar Wastes (DSC) 258',
      '1 Aeon Engine (C19) 52',
      '1 Aerial Extortionist (MKC) 54',
      '1 Aminatou, the Fateshifter (PLST) 2X2-169',
      '1 Approach of the Second Sun (PLST) AKH-4'
    ].join('\n');

    const { rows, skipped } = parseDecklist(text);
    assert.strictEqual(rows.length, 7, 'all seven of his lines must parse');
    assert.strictEqual(skipped.length, 0, 'none of his lines may be skipped');

    // A COMMA IN A CARD NAME MUST NOT TRUNCATE IT.
    assert.strictEqual(rows[0].name, 'Yennett, Cryptic Sovereign');
    assert.strictEqual(rows[0].set_code, 'SLD');
    assert.strictEqual(rows[0].collector_number, '2121');
    assert.strictEqual(rows[0].finish, 'foil', '*F* must mean foil');

    // THE PLST CASE. Two of his seven lines carry a prefixed collector number
    // ("2X2-169", "AKH-4"). A \d+ number pattern rejects both silently.
    const ami = rows.find(r => r.name === 'Aminatou, the Fateshifter');
    assert.strictEqual(ami.collector_number, '2X2-169',
      'a hyphenated PLST number must survive intact');
    const app = rows.find(r => r.name === 'Approach of the Second Sun');
    assert.strictEqual(app.collector_number, 'AKH-4',
      'a letter-prefixed PLST number must survive intact');

    // Everything without a tag is nonfoil, not "unknown".
    assert.strictEqual(rows[1].finish, 'nonfoil');
    console.log('PASS: PL-TC1');
  } catch (err) {
    console.error('FAIL: PL-TC1 -', err.message);
    throw err;
  }

  // ---------------------------------------------------------------------
  // PL-TC2: a line WITHOUT set code and number is rejected, never guessed.
  //
  // Zach's rule: "it needs set code and number to be valid list". The resolver
  // has a byName strategy for CSVs, and letting a pasted bare name fall
  // through to it would write a printing he never specified.
  // ---------------------------------------------------------------------
  try {
    const { rows, skipped } = parseDecklist([
      '1 Aboleth Spawn (CLB) 662',
      'Sol Ring',
      '4 Lightning Bolt',
      '1 Island (DSC) 262'
    ].join('\n'));

    assert.strictEqual(rows.length, 2, 'only the two complete lines may parse');
    assert.strictEqual(skipped.length, 2, 'both bare-name lines must be reported');

    // REPORTED, NOT DROPPED. The line number and the text both have to come
    // back or a 91-line paste that imports 78 is unexplainable.
    assert.deepStrictEqual(skipped.map(s => s.line), [2, 3],
      'skipped lines must carry their own 1-based line numbers');
    assert.strictEqual(skipped[0].text, 'Sol Ring',
      'the offending text must be quoted back verbatim');

    const names = rows.map(r => r.name);
    assert.ok(!names.includes('Sol Ring'),
      'a bare name must NOT be resolved by name');
    assert.ok(!names.includes('Lightning Bolt'),
      'a quantity does not make a nameless-printing line valid');
    console.log('PASS: PL-TC2');
  } catch (err) {
    console.error('FAIL: PL-TC2 -', err.message);
    throw err;
  }

  // ---------------------------------------------------------------------
  // PL-TC3: quantities, finishes and deck-export noise.
  // ---------------------------------------------------------------------
  try {
    const { rows, skipped } = parseDecklist([
      'Deck',
      '',
      '4 Lightning Bolt (2X2) 117',
      '2x Counterspell (MH2) 267 *F*',
      '1 Urza, Lord High Artificer (MH1) 75 *E*',
      '// a comment',
      'Commander:',
      '1 Yennett, Cryptic Sovereign (SLD) 2121'
    ].join('\n'));

    assert.strictEqual(skipped.length, 0,
      'headers, blanks and comments are not errors to report');
    assert.strictEqual(rows.length, 4);

    assert.strictEqual(rows[0].quantity, 4, 'a bare quantity must parse');
    assert.strictEqual(rows[1].quantity, 2, '"2x" must parse as 2');
    assert.strictEqual(rows[1].finish, 'foil');

    // ETCHED IS NOT FOIL. They are separately priced printings; collapsing
    // them writes the wrong row. Same rule csvMappers already follows.
    assert.strictEqual(rows[2].finish, 'etched',
      '*E* must be etched, not foil');
    assert.strictEqual(finishFromTags(' *E* '), 'etched');
    assert.notStrictEqual(finishFromTags(' *E* '), 'foil');
    console.log('PASS: PL-TC3');
  } catch (err) {
    console.error('FAIL: PL-TC3 -', err.message);
    throw err;
  }

  // ---------------------------------------------------------------------
  // PL-TC4: the route reaches the parser, and the paste re-parses on COMMIT.
  //
  // If the client posted rows it parsed itself, the preview and the write
  // could disagree. The route must accept `text` on BOTH phases.
  // ---------------------------------------------------------------------
  try {
    const routeSrc = stripComments(fs.readFileSync(
      path.join(__dirname, '../../src/routes/importExport.js'), 'utf8'));

    assert.match(routeSrc, /require\(['"]\.\.\/utils\/decklistParser['"]\)/,
      'the import route must use the shared parser');
    assert.match(routeSrc, /parseDecklist\(\s*text\s*\)/,
      'the route must parse the posted text');

    // BOTH phases run the same function, so both accept text. Asserted by
    // checking runImport is what each route delegates to, rather than by
    // matching the word "text" somewhere in the file.
    assert.match(routeSrc,
      /router\.post\(\s*['"]\/import\/preview['"].*runImport\(req,\s*res,\s*\{\s*commit:\s*false/s,
      'preview must go through runImport');
    assert.match(routeSrc,
      /router\.post\(\s*['"]\/import['"].*runImport\(req,\s*res,\s*\{\s*commit:\s*true/s,
      'commit must go through runImport');

    // THE ADMISSION BOUNDARY IS NOT WAIVED FOR A PASTE. A pasted line may add
    // a collection row pointing at an existing catalogue card; it may never
    // invent one.
    assert.ok(!/INSERT\s+INTO\s+card_cache/i.test(routeSrc),
      'the import route must never INSERT into card_cache');

    // The UI must send the TEXT on commit, not rows it parsed itself.
    const uiSrc = stripComments(fs.readFileSync(
      path.join(__dirname, '../../../frontend/src/components/ImportModal.jsx'), 'utf8'));
    assert.match(uiSrc, /pasteMode\s*\n?\s*\?\s*\{\s*text:\s*pasteText/,
      'commit must post the pasted text, not client-parsed rows');
    console.log('PASS: PL-TC4');
  } catch (err) {
    console.error('FAIL: PL-TC4 -', err.message);
    throw err;
  }

  // ---------------------------------------------------------------------
  // PL-TC5: every string the paste UI renders exists in EVERY locale.
  //
  // t(key, vars) has no default-string argument, so a missing key renders the
  // raw key to the user. Checking only en.json would ship that to ten locales.
  // ---------------------------------------------------------------------
  try {
    const localeDir = path.join(__dirname, '../../../frontend/src/locales');
    const needed = ['import.pasteInstead', 'import.pasteHint',
      'import.pastePlaceholder', 'import.previewList', 'import.pastedList'];

    const files = fs.readdirSync(localeDir).filter(f => f.endsWith('.json'));
    assert.ok(files.length >= 11, `expected 11+ locales, found ${files.length}`);

    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
      for (const key of needed) {
        assert.ok(Object.prototype.hasOwnProperty.call(data, key),
          `${f} is missing ${key}`);
        assert.ok(String(data[key]).trim().length > 0,
          `${f} has an empty ${key}`);
        // A key that merely echoes itself is a missing translation wearing a
        // disguise -- it renders the dotted key to the user just the same.
        assert.notStrictEqual(data[key], key, `${f}:${key} is just the key`);
      }
    }
    console.log('PASS: PL-TC5');
  } catch (err) {
    console.error('FAIL: PL-TC5 -', err.message);
    throw err;
  }

  console.log('\nAll paste-list tests passed');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
