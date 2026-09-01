import fs from "node:fs";
import process from "node:process";
import { performance } from "node:perf_hooks";
import type { Sample } from "./scenario.types.js";

export interface SampleSink { write(sample: Sample): void | Promise<void>; }
function cpuTimes() { const c = process.cpuUsage(); return { user: c.user / 1000, system: c.system / 1000 }; }
export function readProcessSample(): Omit<Sample, "timestampMs" | "scenario" | "run"> {
  const m = process.memoryUsage(); const c = cpuTimes(); let rss = m.rss;
  if (process.platform === "linux") { try { const line = fs.readFileSync(`/proc/${process.pid}/statm`, "utf8").split(" "); rss = Number(line[1]) * 4096; } catch {} }
  return { rssMb: rss / 1048576, heapUsedMb: m.heapUsed / 1048576, heapTotalMb: m.heapTotal / 1048576, externalMb: m.external / 1048576, arrayBuffersMb: m.arrayBuffers / 1048576, cpuUserMs: c.user, cpuSystemMs: c.system, cpuPercent: null, source: "process_self" };
}
export class ProcessSampler {
  private timer: NodeJS.Timeout | undefined; private running = false; private last = performance.now(); private samples = 0; private lastCpu = cpuTimes();
  constructor(private readonly intervalMs = 500, private readonly sink?: SampleSink) {}
  start(scenario: string, run: number) { if (this.running) return; this.running = true; this.last = performance.now(); this.lastCpu = cpuTimes(); const take = () => { if (!this.running) return; const now = performance.now(); const s = readProcessSample(); const elapsed = now - this.last; const cpu = { user: s.cpuUserMs ?? 0, system: s.cpuSystemMs ?? 0 }; const used = cpu.user + cpu.system - this.lastCpu.user - this.lastCpu.system; const sample: Sample = { timestampMs: now, scenario, run, ...s, cpuPercent: this.samples++ && elapsed > 0 ? (used / elapsed) * 100 : null }; void this.sink?.write(sample); this.last = now; this.lastCpu = cpu; }; take(); this.timer = setInterval(take, Math.max(100, Math.min(2000, this.intervalMs))); }
  stop() { this.running = false; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
