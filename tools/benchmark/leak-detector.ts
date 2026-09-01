export type RetentionClassification = "stable" | "possible_retention_growth" | "strong_retention_growth";
export interface RetentionAnalysis { classification: RetentionClassification; slopeMbPerWorkflow: number; totalIncreaseMb: number; values: number[]; }

export function analyzeRetention(values: number[], options: { possibleSlope?: number; strongSlope?: number; possibleIncrease?: number; strongIncrease?: number } = {}): RetentionAnalysis {
  const possibleSlope = options.possibleSlope ?? 0.25; const strongSlope = options.strongSlope ?? 1;
  const possibleIncrease = options.possibleIncrease ?? 5; const strongIncrease = options.strongIncrease ?? 20;
  if (values.length < 2) return { classification: "stable", slopeMbPerWorkflow: 0, totalIncreaseMb: 0, values };
  const start = Math.min(5, Math.floor(values.length / 2));
  const ys = values.slice(start); const xs = ys.map((_, i) => i + start);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length; const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const slope = ys.reduce((a, y, i) => a + (xs[i]! - mx) * (y - my), 0) / (xs.reduce((a, x) => a + (x - mx) ** 2, 0) || 1);
  const increase = ys[ys.length - 1]! - ys[0]!;
  const classification = slope >= strongSlope || increase >= strongIncrease ? "strong_retention_growth" : slope >= possibleSlope || increase >= possibleIncrease ? "possible_retention_growth" : "stable";
  return { classification, slopeMbPerWorkflow: slope, totalIncreaseMb: increase, values };
}
