// THE PWA MUST STAY WIRED UP.
//
// Zach: "I would like this to work as a pwa for my phone."
//
// This file exists because the repo ALREADY contained a manifest that had never
// once worked: it was not linked from index.html so no browser read it, it
// pointed at an icons/ directory that did not exist so every icon 404'd, and it
// had no name, start_url or display so it could not have satisfied an install
// prompt even if found. It looked complete in a file listing.
//
// Every assertion here is about a link between two files. That is where this
// class of bug lives -- each piece present, nothing connecting them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';

const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(
  new URL('../../frontend/public/manifest.webmanifest', import.meta.url), 'utf8'));
const vite = readFileSync(new URL('../../frontend/vite.config.js', import.meta.url), 'utf8');
const app = readFileSync(
  new URL('../../frontend/src/App.jsx', import.meta.url), 'utf8');

test('PWA-TC1: the manifest is actually linked from the page', () => {
  // The original failure. A manifest nobody loads is a file, not a feature.
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/,
    'index.html must link the manifest or no browser will ever read it');
  assert.match(html, /<meta name="theme-color"/,
    'and declare a theme colour, or the installed app has a white title bar');
});

test('PWA-TC2: every icon the manifest promises exists on disk', () => {
  // Seven icons were listed; zero existed. An install prompt with a broken
  // icon either does not appear or installs a blank square.
  for (const icon of manifest.icons) {
    const rel = icon.src.replace(/^\//, '');
    const p = new URL(`../../frontend/public/${rel}`, import.meta.url);
    assert.ok(existsSync(p), `${icon.src} is promised by the manifest but missing`);
  }
  assert.ok(manifest.icons.length >= 2, 'at least the 192 and 512 sizes');
});

test('PWA-TC3: the manifest has what an install prompt requires', () => {
  // Chrome refuses to offer installation without all of these. The original
  // manifest had none of them.
  for (const field of ['name', 'short_name', 'start_url', 'display',
                       'background_color', 'theme_color']) {
    assert.ok(manifest[field], `manifest.${field} is required for installability`);
  }
  assert.equal(manifest.display, 'standalone',
    'anything else opens in a browser tab rather than as an app');
  const sizes = manifest.icons.map(i => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'),
    'both sizes are required');
  assert.ok(manifest.icons.some(i => (i.purpose || '').includes('maskable')),
    'Android crops installed icons to the launcher shape; without a maskable '
    + 'icon the artwork loses its corners');
});

test('PWA-TC4: the API is never served from the cache', () => {
  // THE ONE RULE THAT MATTERS HERE. This app's whole contract is that a price
  // is current and says where it came from. Serving a cached /api response
  // would show yesterday's figures as fact -- undoing days of work spent
  // making every number honest about its source and its age.
  // Matched on the literal source text, normalised for whitespace. Two earlier
  // attempts at a hand-escaped pattern failed against CORRECT code, and I
  // briefly "fixed" the config on the strength of a shell-quoting artifact --
  // reading the file directly is what settled it. The pattern in the config is
  // /^\/api\// and it does match /api/health; verified in node.
  const flat = vite.replace(/\s+/g, ' ');
  assert.ok(flat.includes('navigateFallbackDenylist: [/^') && flat.includes('api'),
    'API routes must be excluded from the navigation fallback');
  // Comments stripped first: the slice contains the explanation "EVERY /api
  // CALL MUST REACH THE SERVER", and matching prose as if it were behaviour is
  // the exact false positive that hit EST-TC2 and SYNC-TC5 earlier in this
  // project. Third time for the same mistake.
  const wb = vite.slice(vite.indexOf('runtimeCaching'),
                        vite.indexOf('navigateFallbackDenylist'))
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!wb.includes('/api'),
    'no runtime caching rule may match an API route');
});

test('PWA-TC5: updates are offered, not forced', () => {
  // registerType 'prompt', not 'autoUpdate'. Auto-updating swaps the running
  // bundle mid-session; numbers changing under someone recounting cardboard
  // against the screen is the silent state change this app exists to avoid.
  assert.match(vite, /registerType: 'prompt'/,
    'a new build must not replace the running one without asking');
  assert.match(app, /updateReady/,
    'and the app must surface that a new build is waiting');
  assert.match(app, /applyUpdate/,
    'with a control that actually applies it -- a notice he cannot act on is '
    + 'worse than none, since an installed PWA has no address bar to refresh');
});

test('PWA-TC6: the scan models are not precached', () => {
  // They are tens of megabytes and fetched on demand. Precaching them would
  // make the install download enormous for a feature he may never open on that
  // device.
  assert.match(vite, /globIgnores:.*models/s,
    'the model files must be excluded from the precache manifest');
});

console.log('pwa wiring guards passed');
