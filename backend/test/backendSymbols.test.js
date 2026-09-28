// Every identifier the backend uses must actually be DEFINED.
//
// THE BUG THIS CATCHES, which took the scanner down entirely: deleting
// CLIP+ORB removed backend/src/utils/scanPrintingResolver.js and its import,
// but a call site 650 lines below still used resolveScannedPrinting(). Node
// does not check that at load time -- the route 500'd with
// "Failed to resolve scanned card" on EVERY scan, and the only evidence was a
// ReferenceError buried in journalctl.
//
// `node --check` cannot see this: it is valid syntax. A require() that is
// missing fails at load; an identifier that is missing fails only when the
// line runs, which is why it reached Zach's phone.
//
// This does a real module load of every route file, then a scoped scan for
// bare identifiers that are called but never bound.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
let passed = 0;
const pass = (what) => { console.log(`PASS: ${what}`); passed++; };

// TC1: every file under src/ PARSES and its requires resolve.
//
// A deleted module that is still required fails here, at load, rather than on
// the first request that happens to touch it.
{
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(SRC);

  const broken = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // Resolve every relative require without EXECUTING the module: executing
    // would open databases and bind ports.
    for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = m[1];
      try {
        require.resolve(path.resolve(path.dirname(f), target));
      } catch {
        broken.push(`${path.relative(SRC, f)} -> ${target}`);
      }
    }
  }
  assert.deepStrictEqual(broken, [],
    `these files require modules that do not exist:\n  ${broken.join('\n  ')}\n`
    + 'A deleted module with a surviving require() is a boot failure; with a '
    + 'surviving CALL it is a 500 on one route only.');
  pass('every relative require() resolves to a real file');
}

// TC2: no route file CALLS a module-level helper it never binds.
//
// NARROWED AFTER A FALSE-POSITIVE STORM. The first version scanned for any
// bare lowerCamel call and reported `locations()`, `users()`, `first()` --
// all of them words inside SQL template strings ("...FROM locations(...)"
// never existed; the regex was matching `locations (` in real SQL). A guard
// that reports eight phantom failures gets muted, and a muted guard is worse
// than none.
//
// So: strip template literals and strings FIRST, then check only calls to
// names that look like imported helpers -- the exact shape of the
// resolveScannedPrinting bug.
{
  const routeDir = path.join(SRC, 'routes');
  const offenders = [];
  for (const name of fs.readdirSync(routeDir).filter(f => f.endsWith('.js'))) {
    const file = path.join(routeDir, name);
    const code = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
      // SQL and message text live in these; they are not code.
      .replace(/`(?:\\.|[^`\\])*`/g, '``')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""');

    const bound = new Set();
    for (const re of [
      /(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g,
      /\{([^}]*)\}\s*=/g,
      /function\s*\w*\s*\(([^)]*)\)/g,
      /\(([^)]*)\)\s*=>/g,
      /catch\s*\(\s*([\w$]+)\s*\)/g,
      /\.(?:then|map|filter|forEach|reduce|find|some|every)\(\s*(?:async\s*)?\(?([\w$,\s]*)\)?/g,
    ]) {
      for (const m of code.matchAll(re)) {
        for (const part of (m[1] || '').split(/[,\s:]+/)) {
          const id = part.replace(/[^\w$].*$/, '').trim();
          if (id) bound.add(id);
        }
      }
    }

    // Only names in the shape of an imported helper: camelCase with an inner
    // capital, e.g. resolveScannedPrinting, addCardToCollection. SQL keywords
    // and table names are lowercase and never match.
    for (const m of code.matchAll(/(?:^|[^\w$.])([a-z][\w$]*[A-Z][\w$]*)\s*\(/g)) {
      const id = m[1];
      if (bound.has(id)) continue;
      if (typeof global[id] === 'function') continue;
      offenders.push(`${name}: ${id}()`);
    }
  }
  const unique = [...new Set(offenders)];
  assert.deepStrictEqual(unique, [],
    `these route files call helpers they never bind:\n  ${unique.join('\n  ')}\n`
    + 'This is the resolveScannedPrinting failure: valid syntax, resolvable '
    + 'requires, and a ReferenceError at request time.');
  pass('no route calls an unbound module-level helper');
}

console.log(`\nbackendSymbols.test.js: ${passed} cases passed`);
