const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TEST_DIR = __dirname;
const files = fs.readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.js') && f !== 'run.js')
  .sort();

let totalPassed = 0;
let totalFailed = 0;
let passedSuites = 0;
let failedSuites = 0;

async function runTestFile(file) {
  return new Promise((resolve) => {
    console.log(`\n=========================================`);
    console.log(`RUNNING TEST SUITE: ${file}`);
    console.log(`=========================================`);
    
    const child = spawn('node', [path.join(TEST_DIR, file)]);
    
    let filePassed = 0;
    let fileFailed = 0;
    
    child.stdout.on('data', (data) => {
      const output = data.toString();
      process.stdout.write(output);
      
      // THE TALLY MUST BE HONEST — it is quoted as the verification signal.
      //
      // Two rounds of this bug now. First `F\d` stopped matching at feature 10.
      // Then `F\d+-TC\d+` silently stopped counting any feature or case id
      // containing a LETTER ('F6I-TC1', 'F7-TCG1a'), so eleven PR 6I tests ran
      // and passed while reporting as zero cases. The exit code was right both
      // times; only the number people read was wrong, which is the worst shape
      // for this defect to take — a number nobody distrusts.
      //
      // So the pattern now accepts the id shapes the suites actually use:
      // letters and digits on both sides. Kept deliberately loose, because an
      // UNCOUNTED passing test is a silent under-report, while an
      // over-permissive pattern would at worst count a line that literally
      // says "PASS:".
      const passMatches = output.match(/PASS: F[A-Z0-9]+-TC[A-Za-z0-9]+/g);
      if (passMatches) {
        filePassed += passMatches.length;
      }
    });

    child.stderr.on('data', (data) => {
      const output = data.toString();
      process.stderr.write(output);
      
      // The same shape as the PASS pattern above, and for the same reason: a
      // FAILURE that goes uncounted is strictly worse than an uncounted pass.
      const failMatches = output.match(/FAIL: F[A-Z0-9]+-TC[A-Za-z0-9]+/g);
      if (failMatches) {
        fileFailed += failMatches.length;
      }
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`PASS: ${file} executed successfully.`);
        passedSuites++;
      } else {
        console.error(`FAIL: ${file} exited with code ${code}.`);
        failedSuites++;
        if (fileFailed === 0) {
          fileFailed = 1;
        }
      }
      
      totalPassed += filePassed;
      totalFailed += fileFailed;
      
      resolve();
    });
  });
}

async function main() {
  console.log(`Discovered ${files.length} E2E test files under ${TEST_DIR}.`);
  for (const file of files) {
    await runTestFile(file);
  }
  
  console.log(`\n=========================================`);
  console.log(`E2E TEST RUNNER RESULT SUMMARY:`);
  console.log(`  Passed suites: ${passedSuites} / ${files.length}`);
  console.log(`  Failed suites: ${failedSuites} / ${files.length}`);
  console.log(`  Passed test cases: ${totalPassed}`);
  console.log(`  Failed test cases: ${totalFailed}`);
  console.log(`  Total test cases:  ${totalPassed + totalFailed}`);
  console.log(`=========================================`);
  
  process.exit(failedSuites > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unhandled runner error:', err);
  process.exit(1);
});
