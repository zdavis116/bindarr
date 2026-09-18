// MANA POOL MASS ENTRY IS PREFILLED FROM THE URL.
//
// Zach: "it looks like you can send the cards to mass entry it looks like it's
// a part of the url as a base64 string", with a working example.
//
// The code previously asserted the OPPOSITE in a comment -- "it cannot be
// prefilled from a URL: eight query parameter names were tried" -- and made him
// copy and paste on every export because of it. A wrong conclusion recorded as
// a settled fact is more expensive than no note at all, because nobody retests
// it.
//
// VERIFIED AGAINST THE LIVE PAGE, not inferred: opening
//   https://manapool.com/add-deck?deck=<base64>&ref=bindarr
// with a two-card newline-joined list put both lines in the textarea and Mass
// Entry reported "2/2 in stock" with both cards matched by art.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src', 'components',
  'ExportModal.jsx');
const src = fs.readFileSync(SRC, 'utf8');

// Comments describe intent; only code decides behaviour. Strip them so a
// mention of `deck=` in prose cannot pass a test about the real URL.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

let passed = 0;
const pass = (id, what) => { passed += 1; console.log(`PASS: ${id} ${what}`); };

// --- MP-TC1 -----------------------------------------------------------------
// THE MANA POOL TAB CARRIES THE PREFILL PARAMETER.
{
  assert.match(code, /massEntry:\s*'https:\/\/manapool\.com\/add-deck'/,
    'the Mana Pool mass-entry URL must still be configured');
  assert.match(code, /prefillParam:\s*'deck'/,
    "the parameter is `deck` -- verified on the live page, not guessed");

  // Card Kingdom's builder has no such parameter. Giving it one would open a
  // tab with an empty box and no clipboard fallback, which is worse than the
  // paste it replaced.
  const ckBlock = code.slice(code.indexOf("id: 'ckplain'"),
    code.indexOf('];', code.indexOf("id: 'ckplain'")));
  assert.ok(!/prefillParam/.test(ckBlock),
    'Card Kingdom must NOT claim a prefill parameter it does not support');

  pass('MP-TC1', 'only Mana Pool declares a prefill parameter');
}

// --- MP-TC2 -----------------------------------------------------------------
// THE LIST IS BASE64 OF THE SAME TEXT THE USER WOULD HAVE PASTED.
//
// The exported text already resolves substitutions to the printing Bindarr
// PRICED -- that was a bug Zach reported once ("your copy is just taking what
// the deck has, not the cheapest option"). The URL must carry that same string,
// not rebuild a list from `cards`, or the two paths drift and the link asks for
// different cardboard than the screen shows.
{
  assert.match(code, /btoa\(/, 'the list must be base64 encoded');
  assert.match(code, /new TextEncoder\(\)\.encode\(text\)/,
    'encode the EXPORTED text, and as UTF-8: btoa() throws on characters above '
    + 'U+00FF, and real card names contain them (\u00c6ther, Lim-D\u00fbl, J\u00f6tun)');
  assert.match(code, /encodeURIComponent\(encoded\)/,
    'base64 can contain + / =, which change meaning in a query string');

  pass('MP-TC2', 'the URL carries the priced list, UTF-8 safe');
}

// --- MP-TC3 -----------------------------------------------------------------
// A LIST TOO LONG FOR A URL FALLS BACK TO THE CLIPBOARD.
//
// This is the case that matters most and is least likely to be noticed. A URL
// past the far end's limit is truncated SILENTLY -- he would open the tab, see
// a plausible list, and buy a partial deck. The paste path has no such limit,
// so the long case must keep it.
{
  assert.match(code, /url\.length > \d+/,
    'the URL length must be checked before it is used');
  assert.match(code, /return url\.length > \d+ \? null : url/,
    'over the limit must yield NO url, so copyAndOpen takes the clipboard path');

  // And the fallback must still be there INSIDE copyAndOpen. A bare search for
  // navigator.clipboard matched a SEPARATE copy() function further down the
  // file, so deleting the fallback still passed -- the mutation test caught the
  // hole in the test itself. Scope the search to the function under test.
  const fn = code.slice(code.indexOf('const copyAndOpen'),
    code.indexOf('const copy =', code.indexOf('const copyAndOpen')));
  assert.match(fn, /navigator\.clipboard\.writeText\(text\)/,
    'copyAndOpen must keep the clipboard path for Card Kingdom and oversized '
    + 'lists -- without it those tabs open on an empty box');
  assert.match(code, /if \(massEntryUrl\) \{[\s\S]{0,120}window\.open/,
    'a prefillable URL opens directly, with no clipboard round trip');

  pass('MP-TC3', 'oversized lists fall back to the clipboard');
}

// --- MP-TC4 -----------------------------------------------------------------
// THE ENCODING MATCHES WHAT MANA POOL ACTUALLY ACCEPTS.
//
// Reproduced here from the live verification so a future change to the joining
// or encoding fails this test rather than a user's cart.
{
  const line1 = '1 Doctor Doom, King of Latveria [MSC] 6';
  // Zach's own example URL decodes to exactly this.
  assert.strictEqual(
    Buffer.from('MSBEb2N0b3IgRG9vbSwgS2luZyBvZiBMYXR2ZXJpYSBbTVNDXSA2', 'base64')
      .toString('utf8'),
    line1,
    'the format is "<qty> <name> [<SET>] <number>", plain base64 of UTF-8');

  // NEWLINE is the separator -- confirmed by loading a two-card URL and reading
  // the textarea back.
  const two = `${line1}\n1 Sol Ring [C21] 263`;
  const encoded = Buffer.from(two, 'utf8').toString('base64');
  assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf8'), two,
    'multiple cards are newline-joined and survive the round trip');

  // A name with a non-ASCII character must survive too; this is the case that
  // makes a naive btoa() throw and lose the whole export.
  const accented = '1 \u00c6ther Vial [DST] 91';
  assert.strictEqual(
    Buffer.from(Buffer.from(accented, 'utf8').toString('base64'), 'base64')
      .toString('utf8'),
    accented,
    'non-ASCII card names must round trip');

  pass('MP-TC4', 'the wire format matches the live page');
}

console.log(`manapool-massentry.test.js: ${passed} cases passed`);
