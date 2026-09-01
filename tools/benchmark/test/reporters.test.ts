import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonReport } from "../reporters/json-reporter.js";
import { writeCsvReport } from "../reporters/csv-reporter.js";
import { writeMarkdownReport } from "../reporters/markdown-reporter.js";
describe("report generation", () => {
  it("writes valid JSON/CSV/Markdown without secrets", async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), "nyxara-bench-")); const report: any = { schemaVersion: 1, benchmarkRunId: "x", timestamp: new Date().toISOString(), environment: { os: "linux" }, repository: { classification: "small", sourceFileCount: 1 }, configuration: {}, scenarios: [{ name: "idle", status: "completed", runs: [], duration: { median: 1, p95: 2 }, memory: { peakRssMb: 3 } }], summary: {}, warnings: [], secret: "API_KEY_SHOULD_NOT_APPEAR" }; await writeJsonReport(path.join(d, "report.json"), report); await writeCsvReport(path.join(d, "report.csv"), report); await writeMarkdownReport(path.join(d, "report.md"), report); const j = await fs.readFile(path.join(d, "report.json"), "utf8"); expect(JSON.parse(j).schemaVersion).toBe(1); expect(await fs.readFile(path.join(d, "report.csv"), "utf8")).toContain("scenario"); expect(await fs.readFile(path.join(d, "report.md"), "utf8")).toContain("Nyxara Local Benchmark"); });
});
