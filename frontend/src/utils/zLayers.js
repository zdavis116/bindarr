// STACKING ORDER, IN ONE PLACE.
//
// Every fixed-position surface in this app has to declare what it sits above,
// and the only value that actually matters is the pinned mobile nav bar:
//
//   @media (max-width: 768px) { .nav-tabs { position: fixed; z-index: 1000 } }
//
// Two controls were lost to this in a single session -- the new-deck modal at
// z-index 200 and the multi-deck buylist bar at 60 -- both rendered underneath
// the nav, invisible and untappable. Six more modals across the app sat at 999,
// one below the nav, for the same reason: 999 LOOKS like "on top of
// everything", and it is not.
//
// Numbers scattered through JSX cannot be reasoned about. These can.

// The pinned mobile nav bar. Mirrors index.css; fixedSurfaceStacking.test.js
// reads the stylesheet so the two cannot drift apart silently.
export const Z_NAV = 1000;

// A dimming backdrop: above the page and the nav, below its own sheet.
export const Z_BACKDROP = 1100;

// Bars pinned to the bottom of the screen (the multi-deck buylist). Must clear
// the nav bar's height as well as its stacking order -- being visible and being
// reachable are different problems.
export const Z_BOTTOM_BAR = 1200;

// Sheets and modals: the surface the user is meant to be looking at.
export const Z_MODAL = 1500;

// Toasts sit above everything, including a modal, because they report the
// result of what the modal just did.
export const Z_TOAST = 2000;

// Height to clear when pinning something to the bottom on a phone, so a control
// is not merely visible but tappable.
export const NAV_BAR_CLEARANCE = '72px';
