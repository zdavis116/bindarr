#!/usr/bin/env node
// PHASE 1b — TURN SHADOW LOGS INTO THE GATE 1b VERDICT.
//
// Reads RGBART_SHADOW lines from a journal/log and answers the only question
// Gate 1b asks: is rgbArt at least as good as ORB on Zach's real scans?
//
// WHAT THIS CAN AND CANNOT CONCLUDE — read before quoting its numbers.
//
// Shadow mode has no ground truth. Nobody tells the server what card was
// actually in front of the camera. So this tool CANNOT report accuracy. What it
// reports is AGREEMENT, plus the independent evidence available per scan:
//
//   - the OCR'd collector number and title, read from the same photo by a
//     completely separate mechanism. Where OCR is confident, it is the closest
//     thing to an umpire we have.
//   - ORB's inlier count, its own confidence signal.
//   - rgbArt's distance and margin.
//
// Where the two agree, both are probably right. Where they disagree, the OCR
// read breaks the tie when it is available. Disagreements with no OCR evidence
// are reported as UNDECIDED and must be resolved by looking at the card —
// they are not silently assigned to either side.
//
// Usage:
//   journalctl -u bindarr-dev --since today | node scripts/shadow-report.js
//   node scripts/shadow-report.js /path/to/log
'use strict';

const fs = require('fs');
const readline = require('readline');

const src = process.argv[2] && process.argv[2] !== '-'
  ? fs.createReadStream(process.argv[2])
  : process.stdin;

const rows = [];
const rl = readline.createInterface({ input: src, crlfDelay: Infinity });

rl.on('line', (line) => {
  const i = line.indexOf('RGBART_SHADOW ');
  if (i < 0) return;
  try { rows.push(JSON.parse(line.slice(i + 'RGBART_SHADOW '.length))); } catch { /* partial */ }
});

const norm = (s) => String(s || '').toLowerCase().replace(/\s*\/\/.*$/, '').trim();

rl.on('close', () => {
  if (!rows.length) {
    console.log('No RGBART_SHADOW lines found. Is RGBART_SHADOW=1 set on the service?');
    process.exit(0);
  }

  const skipped = rows.filter(r => r.skipped);
  const scored = rows.filter(r => !r.skipped);
  const bothAnswered = scored.filter(r => r.orb && r.rgb);
  const onlyRgb = scored.filter(r => r.rgb && !r.orb);
  const onlyOrb = scored.filter(r => r.orb && !r.rgb);
  const neither = scored.filter(r => !r.orb && !r.rgb);

  console.log('='.repeat(66));
  console.log('GATE 1b — rgbArt SHADOW REPORT');
  console.log('='.repeat(66));
  console.log(`\n  ${rows.length} scans logged`);
  console.log(`  ${skipped.length} skipped (no detection — neither method got a turn)`);
  console.log(`  ${bothAnswered.length} both answered`);
  console.log(`  ${onlyRgb.length} rgbArt answered, ORB did not`);
  console.log(`  ${onlyOrb.length} ORB answered, rgbArt did not`);
  console.log(`  ${neither.length} neither answered`);

  const agree = bothAnswered.filter(r => norm(r.rgb.name) === norm(r.orb.name));
  const disagree = bothAnswered.filter(r => norm(r.rgb.name) !== norm(r.orb.name));
  console.log(`\n  AGREEMENT: ${agree.length}/${bothAnswered.length}` +
    (bothAnswered.length ? ` (${(100 * agree.length / bothAnswered.length).toFixed(1)}%)` : ''));

  // Adjudicate disagreements with the OCR collector number -- independent
  // evidence from the same photo, produced by unrelated code.
  let rgbWins = 0, orbWins = 0, undecided = 0;
  const undecidedRows = [];
  for (const r of disagree) {
    const num = r.ocrNumber;
    const title = norm(r.ocrTitle);
    let verdict = null;
    if (num) {
      const rgbNum = String(r.rgb.number || '').replace(/^0+/, '');
      const orbNum = String(r.orb.number || '').replace(/^0+/, '');
      const n = String(num).replace(/^0+/, '');
      if (rgbNum === n && orbNum !== n) verdict = 'rgb';
      else if (orbNum === n && rgbNum !== n) verdict = 'orb';
    }
    if (!verdict && title.length > 3) {
      const rgbT = norm(r.rgb.name), orbT = norm(r.orb.name);
      if (rgbT.startsWith(title) && !orbT.startsWith(title)) verdict = 'rgb';
      else if (orbT.startsWith(title) && !rgbT.startsWith(title)) verdict = 'orb';
    }
    if (verdict === 'rgb') rgbWins++;
    else if (verdict === 'orb') orbWins++;
    else { undecided++; undecidedRows.push(r); }
  }

  console.log(`\n  DISAGREEMENTS: ${disagree.length}`);
  console.log(`    rgbArt right (per OCR evidence): ${rgbWins}`);
  console.log(`    ORB right    (per OCR evidence): ${orbWins}`);
  console.log(`    UNDECIDED (no OCR evidence):     ${undecided}  <- must be eyeballed`);

  // Timing and separation.
  const ms = scored.filter(r => r.rgb?.ms != null).map(r => r.rgb.ms).sort((a, b) => a - b);
  if (ms.length) {
    const pc = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p / 100))];
    console.log(`\n  rgbArt time: p50 ${pc(50)}ms  p95 ${pc(95)}ms  max ${ms[ms.length - 1]}ms`);
  }
  const dists = scored.filter(r => r.rgb).map(r => r.rgb.dist).sort((a, b) => a - b);
  if (dists.length) {
    const pc = (p) => dists[Math.min(dists.length - 1, Math.floor(dists.length * p / 100))];
    console.log(`  rgbArt distance to top hit: p50 ${pc(50)}  p95 ${pc(95)}  max ${dists[dists.length - 1]}`);
    console.log('    (Gate 1a measured 26-64 bits on real photos; a p95 far above');
    console.log('     that means the rectified image differs from the index images.)');
  }
  const margins = scored.filter(r => r.rgb?.margin != null).map(r => r.rgb.margin).sort((a, b) => a - b);
  if (margins.length) {
    const pc = (p) => margins[Math.min(margins.length - 1, Math.floor(margins.length * p / 100))];
    console.log(`  margin over runner-up: p5 ${pc(5)}  p50 ${pc(50)}`);
    const tight = margins.filter(m => m < 10).length;
    console.log(`  scans with margin < 10 bits: ${tight} (${(100 * tight / margins.length).toFixed(1)}%)` +
      '  <- these are the ambiguous ones');
  }

  if (undecidedRows.length) {
    console.log('\n  --- UNDECIDED disagreements, resolve by looking at the card ---');
    for (const r of undecidedRows.slice(0, 25)) {
      console.log(`   ORB ${String(r.orb.name).slice(0, 28).padEnd(28)} (inl ${r.orb.inliers})` +
        `  |  rgb ${String(r.rgb.name).slice(0, 28).padEnd(28)} (d ${r.rgb.dist}, m ${r.rgb.margin})` +
        `  ocr:${r.ocrNumber || '-'}/${(r.ocrTitle || '-').slice(0, 14)}`);
    }
  }

  console.log('\n' + '='.repeat(66));
  const enough = bothAnswered.length >= 30;
  if (!enough) {
    console.log(`  NOT ENOUGH DATA — ${bothAnswered.length} comparable scans.`);
    console.log('  Scan at least 30 cards with RGBART_SHADOW=1 before judging.');
  } else if (undecided > disagree.length / 2) {
    console.log('  INCONCLUSIVE — most disagreements have no independent evidence.');
    console.log('  Resolve the list above by hand before calling the gate.');
  } else if (rgbWins >= orbWins) {
    console.log('  GATE 1b: rgbArt >= ORB on the evidence available. PASS candidate.');
    console.log('  Confirm the undecided rows by hand before promoting in Phase 2.');
  } else {
    console.log('  GATE 1b: ORB currently ahead. Do NOT promote rgbArt.');
  }
  console.log('='.repeat(66));
});
