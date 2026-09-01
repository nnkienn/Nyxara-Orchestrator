import { describe, expect, it } from "vitest";
import { processTreeMemory } from "../process-tree.js";
import { discoverExtensionHost } from "../extension-host.js";
describe("process and host profiling", () => {
  it("reports parent process memory without pretending children exist", () => { const m = processTreeMemory(); expect(m.processRssMb).toBeGreaterThan(0); expect(m.processTreeRssMb).toBeGreaterThan(0); expect(Array.isArray(m.childPids)).toBe(true); });
  it("uses explicit unavailable/ambiguous host states", () => { const d = discoverExtensionHost(); expect(["high", "medium", "low", "unavailable"]).toContain(d.confidence); if (d.confidence !== "high") expect(d.pid).toBeNull(); });
});
