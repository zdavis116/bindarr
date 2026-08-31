// PHASE 0 — THE BENCHMARK.
//
// Nothing in the scanner rebuild may be claimed without a number from this
// harness. Every phase is gated on it.
//
// WHY THIS EXISTS. Repeatedly during the patching effort a "fix" was measured
// against input the production path never sees — a 220px thumbnail instead of
// the 1500x2100 the pipeline uses, a staged fixture instead of a real photo,
// positional args on a function taking an options object. Each time the harness
// reported a confident, precise, wrong number. This harness runs REAL PHOTOS
// through the REAL ENTRY POINT and compares against labels derived from
// evidence independent of the pipeline being measured.
//
// GROUND TRUTH. backend/test/fixtures/scan-labels.json. 34 cards labelled by
// agreement between two independent identifiers (ORB and rgbArt) plus, for the
// two they disagreed on, direct visual reading of the photo. 6 scans are
// labelled NO_CARD: detection fails outright on them, which is the ~13% capture
// failure the rebuild's later phases target. They stay in the set on purpose —
// a benchmark containing only easy cards measures nothing.
'use strict';

const fs = require('fs');
const path = require('path');

const LABELS = path.join(__dirname, '../test/fixtures/scan-labels.json');
const SCANS = process.env.SCAN_FIXTURE_DIR || path.join(__dirname, '../test/fixtures/scans');

function pct(n, d) { return d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'; }
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

async function main() {
  if (!fs.existsSync(LABELS)) {
    console.error(`No labels at ${LABELS}`);
    process.exit(1);
  }
  const labels = JSON.parse(fs.readFileSync(LABELS, 'utf8'));
  const files = fs.readdirSync(SCANS).filter((f) => f.endsWith('.jpg')).sort();
  if (!files.length) {
    console.error(`No scans in ${SCANS}. Set SCAN_FIXTURE_DIR.`);
    process.exit(1);
  }

  const scanMatch = require('../src/scanMatch');
  const ocrMod = require('../src/utils/collectorNumberOcr');
  const { parseCollectorStrip } = require('../src/utils/collectorNumberParse');

  const cardScans = [];
  const noCardScans = [];
  for (const f of files) {
    const label = labels[f];
    if (!label) continue;
    (label.name === 'NO_CARD' ? noCardScans : cardScans).push({ f, label });
  }

  let correct = 0;
  let wrong = 0;
  let missed = 0;          // a real card the pipeline failed to identify
  let falsePositive = 0;   // NO_CARD scan the pipeline confidently identified
  let numberRead = 0;
  let numberCorrect = 0;
  const latency = [];
  const failures = [];

  for (const { f, label } of [...cardScans, ...noCardScans]) {
    const buf = fs.readFileSync(path.join(SCANS, f));
    const t0 = Date.now();
    const r = await scanMatch.match(buf, 'mtg', 8, '', {}).catch(() => null);
    const top = r?.candidates?.[0] || null;

    let ocrNumber = null;
    if (r?.detection) {
      const rect = await scanMatch.rectifyCard(buf, {
        width: ocrMod.OCR_W, height: ocrMod.OCR_H, detection: r.detection,
      }).catch(() => null);
      if (rect) {
        ocrNumber = parseCollectorStrip(await ocrMod.readCollectorStrip(rect)).number ?? null;
      }
    }
    latency.push(Date.now() - t0);

    // A detection is what separates "identified" from "guessed". Without one the
    // matcher is scoring noise, which is precisely how 'Two Streams Facility'
    // came back at 0 inliers on a photo containing no card.
    const identified = !!(r?.detection && top);

    if (label.name === 'NO_CARD') {
      if (identified) {
        falsePositive++;
        failures.push(`${f}  FALSE POSITIVE  claimed ${top.name} (inliers ${top.inliers})`);
      }
      continue;
    }

    if (!identified) {
      missed++;
      failures.push(`${f}  MISSED  expected ${label.name}`);
    } else if (top.name === label.name) {
      correct++;
    } else {
      wrong++;
      failures.push(`${f}  WRONG  got ${top.name} (inliers ${top.inliers}) expected ${label.name}`);
    }

    if (ocrNumber != null) {
      numberRead++;
      if (label.number && String(ocrNumber) === String(label.number)) numberCorrect++;
    }
  }

  latency.sort((a, b) => a - b);
  const n = cardScans.length;

  console.log('\n=== SCANNER BENCHMARK ===');
  console.log(`fixtures: ${n} labelled cards + ${noCardScans.length} NO_CARD\n`);
  console.log('IDENTIFICATION');
  console.log(`  correct           ${String(correct).padStart(3)}   ${pct(correct, n)}`);
  console.log(`  WRONG CARD        ${String(wrong).padStart(3)}   ${pct(wrong, n)}   <- the one that matters`);
  console.log(`  missed (no ident) ${String(missed).padStart(3)}   ${pct(missed, n)}`);
  console.log('\nDETECTION');
  console.log(`  false positives   ${String(falsePositive).padStart(3)} / ${noCardScans.length}   identified a card in a photo with none`);
  console.log('\nCOLLECTOR NUMBER');
  console.log(`  read a number     ${String(numberRead).padStart(3)}   ${pct(numberRead, n)}`);
  console.log(`  number correct    ${String(numberCorrect).padStart(3)}   ${pct(numberCorrect, n)}`);
  console.log('\nLATENCY (server only — excludes capture, upload, response)');
  console.log(`  p50 ${quantile(latency, 0.5)}ms   p95 ${quantile(latency, 0.95)}ms   max ${latency[latency.length - 1]}ms`);

  if (failures.length) {
    console.log('\nFAILURES');
    failures.forEach((x) => console.log(`  ${x}`));
  }

  const json = {
    when: new Date().toISOString(),
    cards: n, correct, wrong, missed, falsePositive,
    accuracy: n ? correct / n : 0,
    numberRead, numberCorrect,
    p50: quantile(latency, 0.5), p95: quantile(latency, 0.95),
  };
  fs.writeFileSync('/tmp/scan-bench.json', JSON.stringify(json, null, 2));
  console.log('\nmachine-readable -> /tmp/scan-bench.json');

  await ocrMod.shutdown().catch(() => {});
}

main().catch((e) => { console.error('BENCH FAILED', e.message); process.exit(1); });
