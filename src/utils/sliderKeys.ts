export interface SliderKeyOptions {
  min?: number;
  max?: number;
  /** Arrow-key step. */
  step: number;
  /** PageUp / PageDown step. */
  page: number;
}

/**
 * The value an ARIA slider moves to for `key` (WAI-ARIA APG slider pattern), or
 * null when `key` is not a slider key. Up/Right increase, Down/Left decrease.
 */
export function sliderKeyValue(key: string, value: number, { min = 0, max = 1, step, page }: SliderKeyOptions): number | null {
  let next: number;
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight': next = value + step; break;
    case 'ArrowDown':
    case 'ArrowLeft': next = value - step; break;
    case 'PageUp': next = value + page; break;
    case 'PageDown': next = value - page; break;
    case 'Home': next = min; break;
    case 'End': next = max; break;
    default: return null;
  }
  return Math.min(max, Math.max(min, next));
}
