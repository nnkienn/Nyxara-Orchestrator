import type { NumericStats } from "./scenario.types.js";

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

export function stats(values: number[]): NumericStats {
  values = values.filter(Number.isFinite);
  if (!values.length) return { min: 0, max: 0, mean: 0, median: 0, p95: 0, stddev: 0, count: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { min: Math.min(...values), max: Math.max(...values), mean, median: percentile(values, 0.5), p95: percentile(values, 0.95), stddev: Math.sqrt(variance), count: values.length };
}

export function coefficientOfVariation(values: number[]): number { const s = stats(values); return s.mean === 0 ? 0 : s.stddev / Math.abs(s.mean); }
