const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const setsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bindarr-setindex-canonical-'));
process.env.SETS_DIR = setsDir;

async function main() {
  const setIndex = require('../src/setIndex');
  const files = [
    path.join(setsDir, 'mtg-abc-orb-desc.bin'),
    path.join(setsDir, 'mtg-abc-orb-kp.bin'),
    path.join(setsDir, 'mtg-abc-orb-meta.json')
  ];
  for (const file of files) fs.writeFileSync(file, file.endsWith('.json') ? '{"set":"abc","lang":"en","cards":[]}' : '');

  // Temporary frontend compatibility may still send pokemon/Japanese. Those
  // values must be canonicalized before the cache/progress/file key is created.
  setIndex.deleteBuild('pokemon', 'mtg-abc', 'Japanese');
  assert.ok(files.every(file => !fs.existsSync(file)), 'legacy game/lang and mtg-prefixed set inputs must target the canonical mtg|abc|en index');
  console.log('setindex-canonical.test.js: legacy inputs canonicalize before key/path creation');
}

main()
  .finally(() => fs.rmSync(setsDir, { recursive: true, force: true }))
  .catch(error => { console.error(error); process.exitCode = 1; });
