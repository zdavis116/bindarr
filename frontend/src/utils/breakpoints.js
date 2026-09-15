// THE DESKTOP BREAKPOINT, in one place.
//
// 1024px is where the shell switches from the phone's top bar + bottom tabs to
// the sidebar rail. Below it there is not room for a 236px rail plus a
// two-pane deck view without squeezing both panes.
//
// Almost everything that changes at this width is layout, and layout belongs
// in CSS -- index.css has the matching `@media (min-width: 1024px)` blocks and
// they are the rule the browser actually obeys. Use this hook ONLY when the
// DOM ORDER has to differ, which CSS cannot do safely:
//
//   - New deck is a header button on desktop, a full-width action under the
//     list on the phone. Different parents, not different styles.
//
// The number lives here so a future change is one edit, not "grep for 1024 and
// hope". If you change it, change index.css in the same commit.
import { useState, useEffect } from 'react';

export const DESKTOP_MIN_WIDTH = 1024;
export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

export function useIsDesktop() {
  // Guarded for SSR/tests where matchMedia may not exist. Defaults to FALSE --
  // the phone layout -- because a phone rendering the desktop shell for a frame
  // is a worse failure than the reverse.
  const get = () => (typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(DESKTOP_QUERY).matches
    : false);

  const [isDesktop, setIsDesktop] = useState(get);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e) => setIsDesktop(e.matches);
    // addEventListener, not the deprecated addListener: Safari has supported
    // it since 14, and Zach reads this app in Safari.
    mq.addEventListener('change', onChange);
    // Re-read on mount: the value captured by useState ran before this
    // effect, and a resize between the two would otherwise be missed.
    setIsDesktop(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}
