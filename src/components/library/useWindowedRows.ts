// Windowing for the library grid and list (#284): only the rows in (and near) the
// scroll viewport mount, so a folder of thousands of files stays a few dozen DOM nodes.
// Row height is measured from the first rendered row; until then (and under jsdom,
// which has no layout) the estimate and a fallback viewport height are used.

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** Viewport height when the container reports 0 (not laid out yet, or jsdom). */
export const FALLBACK_VIEWPORT_PX = 800;

export interface WindowedRowsOptions {
  /** Item count; with `columns` > 1, items are laid out `columns` per row. */
  count: number;
  columns?: number;
  /** Row height before the first measurement, px (includes any row gap). */
  estimateRowHeight: number;
  /** Vertical gap between rows that `offsetHeight` does not include, px. */
  rowGap?: number;
  /** Extra rows mounted above and below the viewport. */
  overscan?: number;
  scrollRef: RefObject<HTMLElement>;
  /** Space above the first row inside the scroller (sticky header, padding), px. */
  offsetTop?: number;
}

export interface WindowedRows {
  /** First and one-past-last *item* index to render. */
  start: number;
  end: number;
  /** Spacer heights standing in for the rows that are not mounted, px. */
  padTop: number;
  padBottom: number;
  /** Attach to one rendered row (or item) so the real height replaces the estimate. */
  measureRef: (el: HTMLElement | null) => void;
}

/** The visible item range for a scroll position: pure, for tests and the hook. */
export function windowRange(
  { count, columns = 1, rowHeight, overscan = 6, scrollTop, viewportHeight, offsetTop = 0 }: {
    count: number; columns?: number; rowHeight: number; overscan?: number;
    scrollTop: number; viewportHeight: number; offsetTop?: number;
  },
): { start: number; end: number; padTop: number; padBottom: number } {
  const cols = Math.max(1, Math.floor(columns));
  const rows = Math.ceil(count / cols);
  const h = Math.max(1, rowHeight);
  const top = Math.max(0, scrollTop - offsetTop);
  const firstRow = Math.max(0, Math.floor(top / h) - overscan);
  const lastRow = Math.min(rows, Math.ceil((top + viewportHeight) / h) + overscan);
  return {
    start: Math.min(count, firstRow * cols),
    end: Math.min(count, lastRow * cols),
    padTop: firstRow * h,
    padBottom: Math.max(0, rows - lastRow) * h,
  };
}

export function useWindowedRows({
  count, columns = 1, estimateRowHeight, rowGap = 0, overscan = 6, scrollRef, offsetTop = 0,
}: WindowedRowsOptions): WindowedRows {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_PX);
  const [measured, setMeasured] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const read = () => {
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight > 0 ? el.clientHeight : FALLBACK_VIEWPORT_PX);
    };
    read();
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; read(); });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    resize?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      resize?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef]);

  // A shorter list (new filter) must not leave the scroller past its end.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop > 0 && count === 0) el.scrollTop = 0;
  }, [count, scrollRef]);

  const measureRef = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const h = el.offsetHeight;
    if (h > 0) setMeasured((prev) => (prev !== null && Math.abs(prev - (h + rowGap)) < 1 ? prev : h + rowGap));
  }, [rowGap]);

  const range = windowRange({
    count, columns, rowHeight: measured ?? estimateRowHeight, overscan, scrollTop, viewportHeight, offsetTop,
  });
  return { ...range, measureRef };
}

const BREAKPOINTS: [minWidth: number, columns: number][] = [[1024, 5], [768, 4], [640, 3]];

/** Columns of `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5` for the viewport width. */
export function gridColumnsFor(width: number): number {
  for (const [min, cols] of BREAKPOINTS) if (width >= min) return cols;
  return 2;
}

export function useGridColumns(): number {
  const [columns, setColumns] = useState(() => gridColumnsFor(typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setColumns(gridColumnsFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return columns;
}
