/** Robust statistics over small samples of sale prices. */

export function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

/**
 * Drop manipulated points: anything outside [median/3, median*3] is discarded,
 * then the median is recomputed. One pass is enough for AH data in practice.
 */
export function trimmedMedian(values: number[]): { median: number; p25: number; kept: number } {
  if (values.length === 0) return { median: 0, p25: 0, kept: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const m0 = median(sorted);
  const kept = sorted.filter((v) => v >= m0 / 3 && v <= m0 * 3);
  const use = kept.length >= 2 ? kept : sorted;
  return { median: median(use), p25: percentile(use, 0.25), kept: use.length };
}
