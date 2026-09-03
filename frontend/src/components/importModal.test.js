import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modal = readFileSync(join(here, 'ImportModal.jsx'), 'utf8');
const list = readFileSync(join(here, 'CollectionList.jsx'), 'utf8');
const en = JSON.parse(readFileSync(join(here, '../locales/en.json'), 'utf8'));

// THE IMPORT SCREEN.
//
// Built to sketches/013-import-resolve. The recurring failure on this project
// is a control that renders, has a correct handler, passes its tests -- and is
// unreachable. So these check the PATH to the feature, not just its parts.

test('IMPUI-TC1: the import entry point is reachable', () => {
  // It was a disabled "coming soon" button. A feature nobody can open is the
  // same as a feature that does not exist.
  assert.match(list, /import ImportModal from '\.\/ImportModal'/,
    'the modal must be imported');
  assert.match(list, /\{importOpen && \(\s*<ImportModal/,
    'and RENDERED -- state without a render is the classic unreachable control');
  assert.match(list, /setImportOpen\(true\)/,
    'something must open it');
  assert.doesNotMatch(list, /disabled title=\{t\('collection\.addImportSoon'\)\}/,
    'the menu item must no longer be disabled');
});

test('IMPUI-TC2: nothing is written before the review', () => {
  // Zach: "Review/preview should still sell." An import is a large state
  // change and he has said silent ones are unacceptable.
  const commitAt = modal.indexOf("fetch('/api/import'");
  const reviewAt = modal.indexOf("setPhase('review')");
  assert.ok(reviewAt > 0 && commitAt > 0,
    'both phases must exist');
  assert.match(modal, /const commit = async \(\) => \{/,
    'committing is a separate, explicit action');

  // The preview endpoint is the only one called on file selection.
  const readFn = modal.slice(modal.indexOf('const readFile'),
                             modal.indexOf('const commit'));
  assert.match(readFn, /\/api\/import\/preview/);
  assert.doesNotMatch(readFn, /fetch\('\/api\/import',/,
    'choosing a file must never write');
});

test('IMPUI-TC3: the CSV parser survives quoted commas', () => {
  // ManaBox quotes names containing commas -- "Tony Stark, Iron Man" -- and a
  // naive split(',') turns one card into two broken columns. Card names with
  // commas are the normal case, not an edge one.
  // RUN THE PARSER, do not describe it. My first version of this test
  // checked that the string "inQuotes" appeared and stayed green when I
  // disabled the quote branch entirely -- it was asserting that a variable
  // name existed, not that quoted commas survive.
  const fnSrc = modal.slice(modal.indexOf('function parseCSV'),
                            modal.indexOf('function ImportModal'));
  const parseCSV = new Function(fnSrc + '; return parseCSV;')();

  const csv = [
    'Name,Set code,Quantity',
    '"Tony Stark, Iron Man",MSH,2',
    'Sol Ring,LEA,1',
  ].join('\n') + '\n';

  const rows = parseCSV(csv);
  assert.equal(rows.length, 2, 'two data rows');
  assert.equal(rows[0].Name, 'Tony Stark, Iron Man',
    'a quoted comma must stay inside the field -- a naive split turns one '
    + 'card into two broken columns, and comma names are common');
  assert.equal(rows[0]['Set code'], 'MSH', 'and the next column must not shift');
  assert.equal(rows[0].Quantity, '2');
  assert.equal(rows[1].Name, 'Sol Ring');

  // Doubled quotes are the CSV escape for a literal quote.
  const escaped = parseCSV('Name\n' + '"He said ""hi"""' + '\n');
  assert.equal(escaped[0].Name, 'He said "hi"');
});

test('IMPUI-TC4: a choice is offered only where candidates exist', () => {
  // For a proxy or an unreadable quantity there is nothing to choose between.
  // A dropdown with one bad answer in it is worse than an honest "skipped".
  assert.match(modal, /const candidates = rejection\.candidates \|\| \[\]/,
    'candidates come from the server, not invented client-side');
  assert.match(modal, /candidates\.slice\(0, 4\)\.map/,
    'and are rendered when present');
  assert.match(modal, /onChoose\(\{ skip: true \}\)/,
    'skipping must always be available');
});

test('IMPUI-TC5: the count reflects decisions made on screen', () => {
  // If the button still said "Add 1,187" after resolving three rows, he would
  // have to trust that his taps registered. Silent state changes are the thing
  // he has objected to most.
  assert.match(modal, /const willAdd = \(preview\?\.matched \|\| 0\) \+ rescued/,
    'the total must include rows resolved in the review');
  assert.match(modal, /t\('import\.addN', \{ count: willAdd \}\)/,
    'and the button must show that number');
});

test('IMPUI-TC6: every key the modal renders exists in en.json', () => {
  // A missing key renders the key itself on screen -- "import.readyToAdd"
  // where a sentence should be. Cheap to check, and it has bitten this project
  // before.
  const used = [...modal.matchAll(/t\('([a-zA-Z0-9_.]+)'/g)].map(m => m[1]);
  assert.ok(used.length > 10, 'the modal should use a fair few keys');

  const missing = used.filter(k => !(k in en)
    // Reason keys are built dynamically from the server's reason string.
    && !k.startsWith('import.reason.'));
  assert.deepEqual(missing, [], 'these keys would render as raw text');
});

test('IMPUI-TC7: every rejection reason has a message', () => {
  // The reasons come from the backend enum; a new one added there without a
  // string here would surface as "import.reason.whatever" on screen.
  const reasons = ['not_in_catalogue', 'ambiguous_printing', 'no_identifier',
                   'bad_quantity', 'chosen_card_not_in_catalogue'];
  for (const r of reasons) {
    assert.ok(`import.reason.${r}` in en,
      `import.reason.${r} must have a message`);
  }
});

test('IMPUI-TC8: the modal cannot outgrow the screen', () => {
  // The card sheet took four rounds of Zach's screenshots to get this right.
  // Reusing what those rounds established rather than rediscovering it.
  assert.match(modal, /height: '88vh', maxHeight: '100dvh'/,
    'dvh, because iOS vh is measured with the toolbars retracted');
  assert.match(modal, /minHeight: 0, overflowY: 'auto'/,
    'min-height:0 or the body refuses to shrink and the panel grows');
  assert.match(modal, /env\(safe-area-inset-bottom/,
    'safe-area insets on the overlay');
  assert.doesNotMatch(modal, /position: 'absolute'[\s\S]{0,120}onClick=\{onClose\}/,
    'an absolutely-positioned close button follows the panel off-screen');
});
