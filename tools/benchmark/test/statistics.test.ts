import { describe, expect, it } from "vitest";
import { stats } from "../statistics.js";
import { analyzeRetention } from "../leak-detector.js";
describe("benchmark statistics", () => {
  it("calculates median, p95 and spread", () => { const s = stats([1, 2, 3, 4, 5]); expect(s.median).toBe(3); expect(s.p95).toBeCloseTo(4.8); expect(s.min).toBe(1); expect(s.max).toBe(5); expect(s.stddev).toBeGreaterThan(0); });
  it("handles empty and small samples", () => { expect(stats([]).count).toBe(0); expect(stats([4]).median).toBe(4); });
  it("classifies retention conservatively", () => { expect(analyzeRetention([100, 100, 100]).classification).toBe("stable"); expect(analyzeRetention([100, 102, 105, 108, 112, 116]).classification).not.toBe("stable"); });
});
