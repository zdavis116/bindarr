// THE NAV BAR IS FOUR DESTINATIONS, AND NOTHING BECAME UNREACHABLE.
//
// The bar went from eight tabs to four. Four of those tabs were not places:
//   - Add Cards  -> an action; now a full-width button on Home
//   - Storage    -> a VIEW of the collection; now in its view toggle
//   - Admin      -> occasional config; now Settings -> About
//   - Notes      -> DELETED (zero rows on dev AND production)
//
// The risk in that change is not the tabs that remain. It is that removing a
// tab silently removes the only way to reach a feature. That has happened four
// times on this project already -- Add All under the nav bar, the Scanned badge
// under the torch, the camera exit below the fold, a search box styled by a
// class that did not exist. Every one rendered, had a correct handler, and
// passed the suite.
//
// Storage is the live case: 15 compartments on dev, 12 in production. Real data
// Zach uses to find physical cards. So these cases check the replacement route
// EXISTS, not merely that the tab is gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');
const app = readFileSync(join(src, 'App.jsx'), 'utf8');
const navItems = readFileSync(join(src, 'navItems.js'), 'utf8');
const collection = readFileSync(join(src, 'components', 'CollectionList.jsx'), 'utf8');

// The nav renders from a SHARED array, so the destinations are the ids in it.
//
// This used to grep App.jsx between <nav> and </nav>. That stopped being true
// when the list moved to navItems.js so the phone's tab bar and the desktop
// rail could not disagree about what exists -- and the test went red while the
// nav was perfectly correct, which is the cry-wolf failure NAV-TC4 already
// warns about below.
//
// It reads navItems.js now, AND asserts App.jsx actually renders from it. The
// second half is the point: reading the array alone would pass happily if
// App.jsx went back to hard-coding its own buttons, which is exactly the drift
// the shared array exists to prevent.
function navDestinations() {
  const start = navItems.indexOf('export const NAV_ITEMS');
  assert.ok(start > 0, 'NAV_ITEMS not found in navItems.js');
  const end = navItems.indexOf('];', start);
  const block = navItems.slice(start, end);
  return [...block.matchAll(/\{ id: '([a-z-]+)'/g)].map(m => m[1]);
}

test('NAV-TC0: the nav renders FROM the shared list, not a hand-written copy', () => {
  assert.ok(app.includes("from './navItems.js'"),
    'App.jsx must import the shared NAV_ITEMS');
  assert.match(app, /NAV_ITEMS\.map\(/,
    'App.jsx must render the bar by mapping NAV_ITEMS. If it ever hard-codes '
    + 'buttons again, the phone bar and the desktop rail can silently disagree '
    + 'about what exists -- and every other case in this file would be '
    + 'measuring a list the app no longer uses.');
});

test('NAV-TC1: exactly four destinations, in the agreed order', () => {
  assert.deepEqual(navDestinations(),
    ['dashboard', 'collection', 'deckbuilder', 'settings'],
    'The bar is Home, Collection, Decks, Settings. Adding a fifth is a product '
    + 'decision, not a refactor -- Zach chose to fold Storage into Collection '
    + 'rather than keep five tabs.');
});

test('NAV-TC2: scanning is NOT a nav tab', () => {
  // Zach: "Actually takes away the need to hit the scan button at the bottom
  // so scan can be removed from nav bar."
  assert.ok(!navDestinations().includes('add-cards'),
    'Scanning is an action reached from Home, not a destination');
});

test('NAV-TC3: admin is not a tab, but is still routed', () => {
  assert.ok(!navDestinations().includes('admin'), 'admin must not occupy a tab');
  // The route has to survive, or Settings -> Administration goes nowhere.
  assert.ok(app.includes("case 'admin':"),
    'the admin route must still exist -- Settings links to it');
});

test('NAV-TC4: STORAGE IS STILL REACHABLE', () => {
  // The load-bearing case. Storage lost its tab; if this fails, 15
  // compartments of real data have no route from a cold start.
  assert.ok(app.includes("case 'storage':"),
    'the storage route must still exist');

  // A general entry point, not only the per-card "where is this?" jump. That
  // one requires having already picked a card, so it cannot be the only way in.
  // Anchored to the BUTTON, not to a comment. The previous version keyed off a
  // "{/* View Toggle */}" marker, so rewording a comment failed the test while
  // Storage was perfectly reachable -- a test that cries wolf gets ignored,
  // which is worse than no test.
  assert.ok(collection.includes("onNavigate('storage')"),
    'Collection must offer a general way into Storage. Without it the only '
    + 'route is a single card\'s "where is this?" action, which a user browsing '
    + 'the collection may never trigger.');

  // ...and it must be a real control the user can press, not a handler defined
  // and never rendered.
  assert.match(collection, /onClick=\{openStorage\}|onClick=\{\(\) => onNavigate\('storage'\)/,
    'the storage entry point must be wired to a button');
});

test('NAV-TC5: notes is gone completely, not just hidden', () => {
  // Zero rows on dev and production. Removed rather than hidden, so nothing
  // renders a screen nobody opens.
  assert.ok(!navDestinations().includes('notes'), 'notes must not be a tab');
  assert.ok(!app.includes("case 'notes':"),
    'the notes route must be removed, not merely unlinked');
  assert.ok(!app.includes('./components/Notes'),
    'Notes must not be imported -- a lazy import kept alive is dead weight in '
    + 'the bundle and misleading to read');
});
