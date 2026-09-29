#!/usr/bin/env bash
# Every t() key used anywhere in the frontend must EXIST in en.json.
#
# This app's translate() returns THE KEY ITSELF when a key is missing -- see
# utils/translate.test.js line 21. It does not accept a default string. So
# t('collection.rarities') on a missing key renders the literal text
# "collection.rarities" on screen.
#
# That is a silent, ugly failure that no build and no lint catches. It has
# already happened once: 27 keys in DesktopScanLayout would have rendered as
# their own names across the whole screen.
#
# WAS SCOPED TO ONE FILE and therefore missed every other component. A guard
# that only looks where the last bug was is a guard that catches the last bug.
cd "$(dirname "$0")/.."

node -e "
const fs = require('fs');
const path = require('path');
const en = JSON.parse(fs.readFileSync('frontend/src/locales/en.json', 'utf8'));

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(jsx|js)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
};

let total = 0, missing = [];
for (const f of walk('frontend/src')) {
  if (f.endsWith(path.join('utils', 'i18n.jsx'))) continue;   // defines t(), does not call it
  const src = fs.readFileSync(f, 'utf8');
  // t('key') and t('key', { ... }). Template literals are skipped on purpose:
  // a computed key cannot be checked statically, and pretending otherwise
  // would mean either false alarms or a false sense of coverage.
  const keys = [...src.matchAll(/\bt\(\s*'([^']+)'/g)].map(m => m[1]);
  total += new Set(keys).size;
  for (const k of new Set(keys)) {
    // PLURALS resolve through key.one / key.other (see translate.js), so the
    // bare key is legitimately absent. Checking only for an exact match
    // reported 23 false alarms on working code -- a guard that cries wolf
    // gets switched off, which is worse than not having it.
    const ok = (k in en)
      || (k + '.one') in en || (k + '.other') in en
      || (k + '.zero') in en || (k + '.few') in en || (k + '.many') in en;
    if (!ok) missing.push(\`\${path.relative('frontend/src', f)}: \${k}\`);
  }
}

console.log('t() keys used :', total);
console.log('missing       :', missing.length);
for (const m of missing) console.log('  ' + m);
process.exit(missing.length ? 1 : 0);
"
