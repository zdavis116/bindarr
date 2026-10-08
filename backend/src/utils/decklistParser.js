// PASTED DECKLISTS.
//
// Zach: "it would be nice if that could just take a pasted in list as well.
// But it needs set code and number to be valid list."
//
// The format is the one Moxfield/Archidekt/MTGO export and every deck site
// offers as "copy list":
//
//     1 Yennett, Cryptic Sovereign (SLD) 2121 *F*
//     1 Aboleth Spawn (CLB) 662
//     1 Aminatou, the Fateshifter (PLST) 2X2-169
//
// Set code and collector number are REQUIRED, per Zach's rule. A line without
// them is rejected and named, never guessed at: `importResolver.byName` exists
// for CSVs but a name alone maps to dozens of printings at wildly different
// values, and this parser's whole contract is that the printing is stated.
//
// The output row shape is deliberately the same one `csvMappers` produces, so
// the pasted rows flow through the EXISTING resolve/preview/commit pipeline in
// routes/importExport.js rather than growing a second import path that can
// drift from the first.

// A collector number is not always digits. Real examples from Zach's own list:
//
//     2121        ordinary
//     2X2-169     PLST reprints carry their ORIGINAL set as a prefix
//     AKH-4       same, with a letter-only prefix
//
// and elsewhere in the catalogue: 123a, 45★, 10b, S-1. Accepting only \d+ would
// silently reject every PLST row, which is 2 of the 7 lines he sent.
const NUMBER = String.raw`[A-Za-z0-9\u2605][A-Za-z0-9\u2605/.\-]*`;

// Trailing flags, MTGO/Moxfield style: *F* foil, *E* etched.
const TAGS = String.raw`(?:\s+\*[A-Za-z]+\*)*`;

const LINE = new RegExp(
  String.raw`^\s*` +
  String.raw`(?<qty>\d+)\s*[xX]?\s+` +          // "1 " or "1x "
  String.raw`(?<name>.+?)\s+` +                 // lazy: stop at the LAST "(SET) num"
  String.raw`\((?<set>[A-Za-z0-9]{2,6})\)\s+` + // (SLD) (PLST) (C19)
  String.raw`(?<num>${NUMBER})` +
  String.raw`(?<tags>${TAGS})\s*$`
);

// Lines a deck export includes that are not cards. Dropped silently: a blank
// line or "Deck"/"Commander" header is not an error the user needs to fix.
const SECTION = /^\s*(deck|commander|sideboard|maybeboard|companion|considering|tokens?)\s*:?\s*$/i;

// "*F*" -> foil. Etched is a SEPARATE finish, not a kind of foil: etched and
// traditional foil are separately priced printings and collapsing them writes
// the wrong row. Same rule csvMappers.finishFromFoilFlag follows.
function finishFromTags(tags) {
  const t = String(tags || '').toLowerCase();
  if (/\*e\*|\*etched\*/.test(t)) return 'etched';
  if (/\*f\*|\*foil\*/.test(t)) return 'foil';
  return 'nonfoil';
}

/**
 * Parse pasted text into import rows.
 *
 * Returns { rows, skipped }:
 *   rows    - in csvMappers' row shape, ready for resolveRows()
 *   skipped - lines that are not parseable as "<qty> <name> (SET) <number>",
 *             each with its 1-based line number and the raw text, so the
 *             preview can NAME them instead of reporting a smaller total.
 *
 * A line that cannot be parsed is NOT silently dropped. The failure mode this
 * avoids: pasting 91 lines, importing 78, and having no idea which 13 went
 * missing or why.
 */
function parseDecklist(text) {
  const rows = [];
  const skipped = [];

  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) continue;                       // blank
    if (SECTION.test(line)) continue;          // "Deck" / "Commander:" headers
    if (/^(\/\/|#)/.test(line)) continue;      // comments

    const m = LINE.exec(line);
    if (!m) {
      skipped.push({ line: i + 1, text: line });
      continue;
    }

    const { qty, name, set, num, tags } = m.groups;
    rows.push({
      name: name.trim(),
      set_code: set.trim(),
      collector_number: num.trim(),
      quantity: parseInt(qty, 10),
      condition: 'Near Mint',
      finish: finishFromTags(tags),
      language: 'English',
      purchase_price: 0,
      game: 'mtg',
      // Kept so a rejection can quote the user's own line back at him rather
      // than a row index he would have to count out by hand.
      source_line: i + 1
    });
  }

  return { rows, skipped };
}

module.exports = { parseDecklist, finishFromTags };
