// Every module the backend REQUIREs must be a declared dependency.
//
// THE BUG THIS CATCHES, which was live on main: backend/src/cvScan.js does
// `require('onnxruntime-node')` -- it is how the server-side scanner fallback
// runs cornelius and milo -- but onnxruntime-node was never in
// backend/package.json. It resolved only because @huggingface/transformers
// happened to pull it in.
//
// That works on a dev box with a fat node_modules and fails on a fresh
// `npm ci --omit=dev`, which is exactly what the Dockerfile runs. The failure
// would be MODULE_NOT_FOUND at scan time, not at boot, so the app would look
// healthy and the scanner's fallback would be dead.
//
// A transitive dependency is not a contract. The moment transformers changes
// its own deps, ours disappears.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
]);

let passed = 0;
const pass = (what) => { console.log(`PASS: ${what}`); passed++; };

// Walk src/ and collect every bare require() target.
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(SRC);

// Node builtins are not dependencies. `node:`-prefixed ones are unambiguous;
// the bare names still in common use are listed explicitly.
//
// Derived from Node's own module list rather than hand-written where possible:
// my first hand-written list missed `stream/promises` and `async_hooks` and
// reported both as missing dependencies. A guard that cries wolf gets muted,
// which is worse than not having it.
const BUILTIN = new Set(require('node:module').builtinModules);

const missing = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  // Strip comments so a require() inside a commented-out block does not count.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  for (const m of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const name = m[1];
    if (name.startsWith('.') || name.startsWith('/')) continue;      // local
    if (name.startsWith('node:')) continue;                           // builtin
    if (BUILTIN.has(name)) continue;
    // Scoped packages keep two segments: @scope/name.
    const pkgName = name.startsWith('@')
      ? name.split('/').slice(0, 2).join('/')
      : name.split('/')[0];
    if (declared.has(pkgName)) continue;
    if (!missing.has(pkgName)) missing.set(pkgName, []);
    missing.get(pkgName).push(path.relative(ROOT, f));
  }
}

if (missing.size) {
  const lines = [...missing.entries()]
    .map(([name, users]) => `  ${name}  <- ${users.slice(0, 3).join(', ')}`)
    .join('\n');
  assert.fail(
    `${missing.size} module(s) are require()d but not declared in package.json:\n`
    + `${lines}\n\n`
    + 'These resolve today only because some other package happens to install '
    + 'them. `npm ci --omit=dev` in the Dockerfile can drop them, and the '
    + 'failure is MODULE_NOT_FOUND at call time -- the app boots healthy and '
    + 'the feature is dead.');
}
pass('every require()d package is declared in package.json');

console.log(`\ndeclaredDeps.test.js: ${passed} cases passed`);
