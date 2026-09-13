// ONE NAV, TWO ORIENTATIONS.
//
// Zach, on the first desktop mockups: "the nav shouldn't be different on the
// desktop... the nav should be similar."
//
// He was right, and the mistake was worse than a style slip: my desktop rail
// had a different ORDER (deckbuilder first), two extra destinations, and
// invented "Play / Manage" section headings that appear nowhere else in the
// app. Same product, two mental models, depending on window width -- learn one,
// relearn the other.
//
// So the destinations live here, once. The bottom bar and the desktop rail both
// render THIS list, in this order, with these labels and icons. Only the
// orientation differs. A new destination is one entry and appears in both.
//
// STORAGE AND ADD CARDS ARE NOW FIRST-CLASS. They were reachable only by
// drilling in from another screen, which is why the rail "needed" extra items
// the tab bar did not have. Zach pointed out the bottom bar has room to spare --
// so the reason they were missing was never space, it was just never revisited.
import {
  LayoutDashboard, Database, Swords, PlusSquare, Archive,
  Settings as SettingsIcon,
} from 'lucide-react';

// Order matters and is deliberate: the two things he does most often first,
// then the two that feed the collection, then settings last. Both layouts
// read top-to-bottom / left-to-right in this same order.
export const NAV_ITEMS = [
  { id: 'dashboard',   icon: LayoutDashboard, labelKey: 'nav.dashboard' },
  { id: 'collection',  icon: Database,        labelKey: 'nav.collection' },
  { id: 'deckbuilder', icon: Swords,          labelKey: 'nav.deckBuilder' },
  { id: 'add-cards',   icon: PlusSquare,      labelKey: 'nav.addCards' },
  { id: 'storage',     icon: Archive,         labelKey: 'nav.storage' },
  { id: 'settings',    icon: SettingsIcon,    labelKey: 'nav.settings' },
];

// NO ADMIN ENTRY, on either layout. Administration is occasional configuration
// reached from Settings -> About, not a destination. goTab('admin') still works
// and is still linked, so nothing became unreachable -- it just does not spend
// a permanent slot on a screen he uses every day.
