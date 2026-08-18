#!/usr/bin/env node
// PR 6B mutation harness.
//
// For each named mutant: apply a source edit that DELETES or NEUTERS one guard,
// run the invariants suite, record which named tests went RED, then restore the
// pristine source. A mutant that leaves the suite fully GREEN is a SURVIVOR:
// the guard it removed is not load-bearing and has no real test.
//
// Usage:
//   node tools/mutate.js            # run every mutant
//   node tools/mutate.js M22 M23    # run selected mutants
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUITE = path.join(ROOT, 'test/e2e/collection_storage_invariants.test.js');
const MUTANTS = require('./mutants');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function write(rel, content) { fs.writeFileSync(path.join(ROOT, rel), content); }

function runSuite() {
  const proc = spawnSync('node', [SUITE], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const out = `${proc.stdout || ''}${proc.stderr || ''}`;
  const red = [...out.matchAll(/FAIL: (F\d+-TC\d+)/g)].map(m => m[1]);
  const green = [...out.matchAll(/PASS: (F\d+-TC\d+)/g)].map(m => m[1]);
  return { red: [...new Set(red)], green, crashed: proc.status !== 0 && red.length === 0, out };
}

function applyMutant(mutant) {
  const originals = new Map();
  for (const edit of mutant.edits) {
    const src = read(edit.file);
    if (!originals.has(edit.file)) originals.set(edit.file, src);
    const current = originals.has(edit.file) ? read(edit.file) : src;
    const occurrences = current.split(edit.find).length - 1;
    if (occurrences === 0) {
      throw new Error(`${mutant.id}: anchor not found in ${edit.file}:\n${edit.find.slice(0, 120)}`);
    }
    if (occurrences > 1) {
      throw new Error(`${mutant.id}: anchor is AMBIGUOUS (${occurrences} matches) in ${edit.file}:\n${edit.find.slice(0, 120)}`);
    }
    write(edit.file, current.replace(edit.find, edit.replace));
  }
  return originals;
}

function restore(originals) {
  for (const [file, src] of originals) write(file, src);
}

// A mutated tree must never outlive this process. The `finally` inside the loop
// covers a mutant that throws, but NOT a SIGINT/SIGTERM or an uncaught error
// between apply and restore -- and a run killed mid-mutant leaves a deliberately
// broken guard sitting in the working tree, where the next `git diff` reads as a
// real (and very confusing) source change. Track the in-flight mutant globally
// and restore it on the way out, whatever the exit path.
let inFlight = null;

function restoreInFlight() {
  if (inFlight) {
    restore(inFlight);
    inFlight = null;
  }
}

process.on('SIGINT', () => { restoreInFlight(); process.exit(130); });
process.on('SIGTERM', () => { restoreInFlight(); process.exit(143); });
process.on('uncaughtException', (error) => {
  restoreInFlight();
  console.error('harness crashed, tree restored:', error);
  process.exit(1);
});

const selected = process.argv.slice(2);
const list = selected.length ? MUTANTS.filter(m => selected.includes(m.id)) : MUTANTS;

// Sanity: the pristine tree must be fully green, or every result below is noise.
const baseline = runSuite();
if (baseline.red.length > 0 || baseline.crashed) {
  console.error('BASELINE IS NOT GREEN - fix the suite before mutation testing.');
  console.error(baseline.out.slice(-3000));
  process.exit(1);
}
console.log(`baseline GREEN: ${baseline.green.length} cases\n`);

const survivors = [];
const expected = [];
const killed = [];

for (const mutant of list) {
  let originals;
  try {
    originals = applyMutant(mutant);
    inFlight = originals;
    const result = runSuite();
    if (result.red.length > 0) {
      killed.push({ id: mutant.id, by: result.red });
      console.log(`KILLED   ${mutant.id.padEnd(5)} ${mutant.desc}`);
      console.log(`         RED: ${result.red.join(', ')}`);
    } else {
      // A mutant flagged `equivalent` or `unreachable` is EXPECTED to survive:
      // its analysis is recorded in mutants.js and says no behavior test can
      // distinguish it. Reporting those as failures would train the next
      // reader to ignore the harness's output, which is worse than not having
      // the harness. Genuine survivors are the only thing that fails the run.
      if (mutant.equivalent || mutant.unreachable) {
        expected.push(mutant.id);
        console.log(`SURVIVED ${mutant.id.padEnd(5)} ${mutant.desc}   (expected: documented as ${mutant.equivalent ? 'equivalent' : 'unreachable'})`);
      } else {
        survivors.push(mutant.id);
        console.log(`SURVIVED ${mutant.id.padEnd(5)} ${mutant.desc}   <-- guard is NOT load-bearing`);
      }
    }
  } catch (error) {
    console.log(`ERROR    ${mutant.id.padEnd(5)} ${error.message}`);
    survivors.push(mutant.id);
  } finally {
    if (originals) restore(originals);
    inFlight = null;
  }
}

// Restoring must return the tree to green, or a later mutant ran against a
// dirty tree and the whole report is untrustworthy.
const after = runSuite();
console.log(`\npost-restore ${after.red.length === 0 ? 'GREEN' : 'RED (TREE IS DIRTY!)'}: ${after.green.length} cases`);

console.log(`\n=== MUTATION SUMMARY ===`);
console.log(`PROVEN load-bearing (killed):        ${killed.length}`);
console.log(`PRESENT but not proven (documented): ${expected.length}${expected.length ? ` -> ${expected.join(', ')}` : ''}`);
console.log(`survived (REAL GAP):                 ${survivors.length}${survivors.length ? ` -> ${survivors.join(', ')}` : ''}`);
console.log(`\nA documented survivor is defence in depth, NOT a tested guard. Do not`);
console.log(`describe anything in the PRESENT row as "tested" -- see tools/README.md.`);
process.exit(survivors.length === 0 && after.red.length === 0 ? 0 : 1);
