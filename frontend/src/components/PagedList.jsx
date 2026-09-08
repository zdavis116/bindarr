// PAGED APPEND ("infinite scroll").
//
// Zach's design, and it is better than the one it replaces: "Couldn't you
// implement infinite scroll but in a paged sense. Where maybe you load 20 cards
// and when you get to the bottom of the page you load the next 20."
//
// WHY IT IS BETTER, not just simpler. The previous VirtualGrid reserved space
// for unrendered rows with spacer divs sized from an ESTIMATED row height. On
// his phone that estimate was wrong by 13-29px per row and VARIED (a card name
// wrapping to two lines makes a tile taller), so the error accumulated:
//
//     assumed stride 302px   real strides measured 315, 315, 331, 315, 330
//     after  50 rows  ~1000px off   (1.2 screens)
//     after 200 rows  ~4000px off   (4.7 screens)
//
// and the page height itself wobbled between samples (211491 / 211444 /
// 211382 / 211678), which is a scrollbar moving under your thumb. That is
// exactly the "seems a little jittery after awhile" he reported.
//
// This has NO estimated heights and NO spacers, because nothing is ever
// unmounted. The browser lays out what exists; the scroll position of an
// element that is already on the page cannot drift. The whole class of bug is
// gone rather than tuned.
//
// THE TRADE-OFF, stated rather than hidden: the DOM grows as you scroll, so
// scrolling deep costs what rendering that many cards costs. That is bounded by
// use -- you search for a card, you do not scroll to the bottom of 10,000 --
// and it degrades gradually, where a wrong spacer is wrong immediately. If deep
// scrolling ever becomes a real pattern, the fix is to unmount ABOVE the
// viewport, where the height is known because it was measured, not guessed.
import { useState, useEffect, useRef } from 'react';

// Rows to add per page. Zach said 20; 24 divides evenly by 2, 3 and 4 columns
// so a page never ends mid-row on any phone or desktop width.
const PAGE_SIZE = 24;

// How far before the end to start loading, in pixels. Loading exactly AT the
// bottom means the user always sees the end of the list for an instant, which
// reads as the app running out of cards.
const PRELOAD_MARGIN_PX = 600;

export default function PagedList({
  items,
  renderItem,
  pageSize = PAGE_SIZE,
  // Grid columns via CSS auto-fill, or null for a plain vertical list. Passed
  // to CSS rather than computed in JS: the browser already solves this, and
  // computing it here is what made the previous component wrong on a 390px
  // phone after being measured on a 780px desktop.
  minTileWidth = null,
  gap = 0,
}) {
  const [count, setCount] = useState(pageSize);
  const sentinelRef = useRef(null);

  // RESET WHEN THE LIST CHANGES.
  //
  // Filtering to 40 cards while 500 are loaded would otherwise show all 40 at
  // once and, worse, leave the scroll position deep inside a list that no
  // longer goes that far. Keyed on length AND first id: a search that happens
  // to return the same number of cards is still a different list.
  const signature = `${items.length}:${items[0]?.entry_id ?? items[0]?.id ?? ''}`;
  useEffect(() => {
    setCount(pageSize);
  }, [signature, pageSize]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (count >= items.length) return;      // everything is shown

    // IntersectionObserver rather than a scroll handler: the browser reports
    // the sentinel entering view without running JS on every scroll frame,
    // which is what keeps a fast flick smooth.
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) {
        setCount(c => Math.min(c + pageSize, items.length));
      }
    }, { rootMargin: `${PRELOAD_MARGIN_PX}px 0px` });

    io.observe(el);
    return () => io.disconnect();
  }, [count, items.length, pageSize]);

  const slice = items.slice(0, count);

  return (
    <div>
      {minTileWidth ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${minTileWidth}px, 1fr))`,
          gap
        }}>
          {slice.map(item => renderItem(item))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap }}>
          {slice.map(item => renderItem(item))}
        </div>
      )}

      {/* The sentinel sits AFTER the rendered rows. When it scrolls into view
          the next page is appended, which moves it down again. It carries a
          height so it can be intersected at all -- a zero-height element in a
          grid gap is unreliable. */}
      {count < items.length && (
        <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />
      )}
    </div>
  );
}
