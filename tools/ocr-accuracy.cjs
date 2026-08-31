// HOW OFTEN IS OCR CONFIDENTLY WRONG ABOUT THE PRINTING?
//
// Zach: "Is there a way we can measure how correct ocr is with the set number
// and code like you said it could say 0082 instead of 0092 and they both could
// be valid cards? I'm just trying to see if there is a way we can avoid using
// orb if we have set number and code."
//
// This is the ONLY question that decides whether ORB can be dropped, and it is
// not "is OCR usually right". A reader that is right 95% of the time and
// SILENTLY WRONG 5% of the time is unusable here, because a wrong printing is a
// real card in his collection that he owns on paper and not in cardboard --
// the recount failure. A reader that simply fails to read is fine: that queues.
//
// So the corpus is split three ways against ground truth:
//
//   AGREES     OCR's set+number == the truth. Free speed if we trust it.
//   NO READ    OCR produced nothing usable. ORB is what saves these.
//   DISAGREES  OCR read something, and it was NOT the card. THE DANGEROUS ONE.
//
// Measured with the REAL production parser (parseCollectorStrip) against the
// REAL rectify+crop path, on Zach's own labelled scans -- not a reimplementation
// and not clean Scryfall renders. An earlier estimate in this project pattern
// -matched raw text and reported ~53% readable; that is exactly the kind of
// approximation that has already burned me twice, so this runs the real thing.
const fs = require('fs');
const path = require('path');

const BASE = '/opt/bindarr-dev/backend/src';
const scanMatch = require(`${BASE}/scanMatch.js`);
const collectorNumberOcr = require(`${BASE}/utils/collectorNumberOcr.js`);
const { parseCollectorStrip } = require(`${BASE}/utils/collectorNumberParse.js`);

const DIR = '/var/lib/bindarr-dev/scandump';

function norm(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/^0+/, '');
}

(async () => {
  const jsons = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  const items = [];
  for (const f of jsons) {
    const jpg = path.join(DIR, f.replace(/\.json$/, '.jpg'));
    if (!fs.existsSync(jpg)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (d?.truth?.number && d?.truth?.set_id) items.push({ jpg, truth: d.truth });
    } catch { /* skip */ }
  }
  console.log(`labelled scans with a known set+number: ${items.length}\n`);

  const out = { agree: 0, noread: 0, numberOnlyAgree: 0, disagree: [], setWrong: 0 };

  for (const it of items) {
    const buf = fs.readFileSync(it.jpg);
    let raw = '';
    try {
      // The production path: detect + rectify to the OCR geometry, then read
      // the collector strip. Same calls the scan route makes.
      // DETECTION COMES FROM scanMatch.match, exactly as the scan route gets
      // it (routes/collection.js:350 -> result.detection). detectCard() takes
      // raw RGBA pixels, not a JPEG buffer -- calling it directly aborts inside
      // opencv-wasm, which is how the first version of this harness reported
      // 100% no-read and nearly had me tell Zach OCR never works.
      const m = await scanMatch.match(buf, 'mtg', 8, '', { recallK: 1, orb: 500 });
      const strip = await scanMatch.rectifyCard(buf, {
        width: collectorNumberOcr.OCR_W,
        height: collectorNumberOcr.OCR_H,
        detection: m?.detection || undefined,
        region: collectorNumberOcr.STRIP,
      });
      if (strip) raw = await collectorNumberOcr.readCollectorStrip(strip, { preCropped: true });
    } catch { /* treated as a no-read below */ }

    const p = parseCollectorStrip(raw || '');

    // COMPARE THE WAY THE RESOLVER DOES, not the way a first glance suggests.
    //
    // The first version of this harness read only p.number and p.set and
    // reported 26% "confidently wrong" -- which would have had me rewrite a
    // parser that was working correctly. The parser deliberately offers
    // ALTERNATIVES rather than rewriting a read it cannot prove wrong:
    //
    //   number='M0233'  numberAlt='233'          (rarity letter glued on)
    //   set='mshen'     setCandidates=[...,'msh'] (language glued on)
    //
    // scanPrintingResolver tries every (setCandidate x number) pair against the
    // catalogue and accepts a tier only when exactly one printing matches. So
    // the honest question is whether the TRUTH is reachable from what OCR
    // produced, not whether the first field happens to equal it.
    const nums = [p.number, p.numberAlt].filter(Boolean).map(norm);
    const sets = (p.setCandidates?.length ? p.setCandidates : [p.set])
      .filter(Boolean).map(norm);
    const wantNum = norm(it.truth.number);
    const wantSet = norm(it.truth.set_id);

    if (!nums.length) { out.noread += 1; continue; }

    const numOk = nums.includes(wantNum);
    const setOk = sets.includes(wantSet);

    if (numOk && setOk) out.agree += 1;
    else if (numOk && !sets.length) out.numberOnlyAgree += 1;
    else {
      if (numOk && sets.length && !setOk) out.setWrong += 1;
      out.disagree.push({
        truth: `${it.truth.set_id}#${it.truth.number}`,
        read: `${sets.join('/') || '?'}#${nums.join('/')}`,
        confident: !!p.confident,
        raw: (raw || '').replace(/\n/g, ' ').slice(0, 60),
      });
    }
  }

  const n = items.length;
  const pc = (x) => `${x} (${(100 * x / n).toFixed(1)}%)`;
  console.log('OCR vs GROUND TRUTH');
  console.log('  set+number both correct :', pc(out.agree));
  console.log('  number right, no set    :', pc(out.numberOnlyAgree));
  console.log('  NO READ (safe: queues)  :', pc(out.noread));
  console.log('  DISAGREES (dangerous)   :', pc(out.disagree.length));
  console.log('    of which number right but SET wrong:', out.setWrong);

  if (out.disagree.length) {
    console.log('\n  every disagreement:');
    for (const d of out.disagree.slice(0, 25)) {
      console.log(`    truth ${d.truth.padEnd(12)} read ${String(d.read).padEnd(12)} confident=${d.confident}  raw="${d.raw}"`);
    }
  }

  const confidentWrong = out.disagree.filter(d => d.confident).length;
  console.log(`\n  CONFIDENTLY WRONG (would be recorded silently): ${confidentWrong}`);

  await collectorNumberOcr.shutdown().catch(() => {});
  process.exit(0);
})();
