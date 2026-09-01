import fs from "node:fs/promises";
import type { BenchmarkReport } from "../scenario.types.js";
import { sanitizeForReport } from "../privacy.js";
export async function writeJsonReport(file: string, report: BenchmarkReport) { await fs.writeFile(file, JSON.stringify(sanitizeForReport(report), null, 2) + "\n"); }
