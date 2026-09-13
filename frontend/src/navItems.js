// ONE NAV, TWO ORIENTATIONS — AND FOUR ITEMS, NOT SIX.
//
// Zach: "there is 4 nav items on my phone it should be the same on my desktop
// just less confusion."
//
// I got this wrong twice. First the desktop rail had a different order and
// invented section headings. Then I "fixed" it by adding Storage and Add cards
// to BOTH layouts -- which made them agree, but at six items instead of four.
// Agreement was only half the ask; the other half was FEWER THINGS.
//
// His reasoning is better than mine was: "storage and add cards existing just
// in the collection makes sense for me... I would only go there from
// collections so it being tied to just collections makes sense."
//
// Both are things you do TO the collection, not places you go. They belong to
// Collection, reached from its own header buttons -- which is also how the
// phone already works. The desktop Add cards screen is still a full screen
// (he likes it), it is just not a permanent nav slot.
import {
  LayoutDashboard, Database, Swords, Settings as SettingsIcon,
} from 'lucide-react';

// The order is the phone's order. Both layouts read it the same way: bottom bar
// left-to-right, rail top-to-bottom.
export const NAV_ITEMS = [
  { id: 'dashboard',   icon: LayoutDashboard, labelKey: 'nav.dashboard' },
  { id: 'collection',  icon: Database,        labelKey: 'nav.collection' },
  { id: 'deckbuilder', icon: Swords,          labelKey: 'nav.deckBuilder' },
  { id: 'settings',    icon: SettingsIcon,    labelKey: 'nav.settings' },
];

// NOT IN THE NAV, still fully reachable:
//   add-cards  -> from Collection's header, and from the Dashboard
//   storage    -> from Collection's header
//   admin      -> from Settings -> About
// Each is a route that still works; none spends a permanent slot on a screen
// he uses every day.
