// WINDOWED RENDERING.
//
// Zach: "it currently hangs on loading for 3 secs before loading so that makes
// me worried if I get to 10k cards at some point."
//
// Measured on the deployed build under phone-like conditions (4x CPU
// throttle, ~1.6Mbps):
//     fetch + parse            329ms
//     tap -> rows on screen   3350ms
//     DOM nodes              16,032
//     <img> elements          1,395   of which FOUR were in the viewport
//
// So ~90% of the wait was React building a DOM node for every one of 2,438
// cards. The images were already loading="lazy", so nothing was DOWNLOADED --
// but the browser still creates, styles and lays out every element. That cost
// scales with the collection, which is exactly the 10k worry.
//
// WHAT THIS IS: a pure windowing layer. It renders only the rows near the
// viewport and reserves the space for the rest with two spacer divs, so the
// scrollbar and scroll position behave normally. It does not filter, sort,
// group, select, or transform anything -- the caller still owns the full array
// and every screen that reads it (search, filters, select-all-shown, the value
// total) sees exactly what it saw before.
//
// WHY NOT react-window / react-virtuoso: this needs ~80 lines, has no
// scroll-to-index requirement (Zach: "it will never need to jump ... just
// would be searching for a specific card but never jumping"), and adding a
// dependency to a self-hosted app is a maintenance cost that outlives the
// commit.
//
// WHY estimated heights are safe HERE: rows in both views are uniform by
// construction -- list rows are minHeight 52 with fixed padding, gallery tiles
// are a fixed-width grid with a fixed aspect ratio. A variable-height list
// would need measurement and this component would be the wrong tool.
import { useState, useEffect, useRef, useMemo } from 'react';

// How many extra rows to render above and below the viewport.
//
// Not cosmetic: with 0 the user sees blank space during a fast flick, because
// scroll events fire after paint. Three screens' worth of buffer is the
// difference between "virtualised" and "flickers while scrolling".
const OVERSCAN_ROWS = 8;

export default function VirtualGrid({
  items,
  renderItem,
  rowHeight,
  // Fixed column count, OR a minimum tile width for a responsive grid. The
  // gallery uses `repeat(auto-fill, minmax(150px, 1fr))`, so the real column
  // count depends on the viewport -- 4 on this desktop at 780px, fewer on a
  // phone. Hardcoding it would make every phone render the wrong window:
  // too few columns means rows are taller than assumed and the list ends
  // early; too many means blank space. So it is MEASURED from the container.
  columns,
  minTileWidth,
  gap = 0,
  // Escape hatch for tests and for the "few items" case: below this count the
  // whole list renders, because windowing 12 rows costs more than it saves.
  threshold = 60,
}) {
  const containerRef = useRef(null);
  const [range, setRange] = useState({ start: 0, end: threshold });
  const [cols, setCols] = useState(columns || 1);

  const rowCount = Math.ceil(items.length / cols);
  const rowStride = rowHeight + gap;
  const virtualise = items.length > threshold;

  useEffect(() => {
    if (!virtualise) {
      setRange({ start: 0, end: items.length });
      return;
    }

    // The app scrolls the WINDOW, not an inner div, so that is what is
    // measured. Reading the container's own offset keeps the maths right when
    // filters or the header above it change height.
    const recompute = () => {
      const el = containerRef.current;
      if (!el) return;

      // Column count first: everything below depends on it, and it changes on
      // rotate and on resize.
      const width = el.clientWidth;
      const next = columns || (minTileWidth
        ? Math.max(1, Math.floor((width + gap) / (minTileWidth + gap)))
        : 1);
      setCols(prev => (prev === next ? prev : next));

      const rows = Math.ceil(items.length / next);
      const top = el.getBoundingClientRect().top + window.scrollY;
      const first = Math.floor((window.scrollY - top) / rowStride) - OVERSCAN_ROWS;
      const visibleRows = Math.ceil(window.innerHeight / rowStride) + OVERSCAN_ROWS * 2;
      const startRow = Math.max(0, first);
      const endRow = Math.min(rows, startRow + visibleRows);
      setRange({ start: startRow * next, end: Math.min(items.length, endRow * next) });
    };

    recompute();
    // passive: this listener must never be able to make scrolling janky.
    window.addEventListener('scroll', recompute, { passive: true });
    window.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('scroll', recompute);
      window.removeEventListener('resize', recompute);
    };
  }, [virtualise, items.length, rowStride, columns, minTileWidth, gap]);

  // A filter change can leave the window pointing past the end of a now-shorter
  // list, which would render nothing at all -- a collection that looks empty
  // when it is not. Clamping here rather than in the scroll handler keeps it
  // correct even when no scroll event follows.
  const safe = useMemo(() => {
    const start = Math.min(range.start, Math.max(0, items.length - 1));
    const end = Math.min(Math.max(range.end, start + columns), items.length);
    return { start, end };
  }, [range, items.length, columns]);

  const slice = virtualise ? items.slice(safe.start, safe.end) : items;

  // Spacers reserve the height of the rows that are not rendered, so the
  // scrollbar length and position match the real list. Without them the page
  // would grow and shrink as you scroll.
  const rowsAbove = virtualise ? Math.floor(safe.start / cols) : 0;
  const rowsBelow = virtualise ? Math.max(0, rowCount - Math.ceil(safe.end / cols)) : 0;

  return (
    <div ref={containerRef}>
      {rowsAbove > 0 && <div style={{ height: rowsAbove * rowStride }} aria-hidden="true" />}
      {cols > 1 ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gap
        }}>
          {slice.map(item => renderItem(item))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap }}>
          {slice.map(item => renderItem(item))}
        </div>
      )}
      {rowsBelow > 0 && <div style={{ height: rowsBelow * rowStride }} aria-hidden="true" />}
    </div>
  );
}
