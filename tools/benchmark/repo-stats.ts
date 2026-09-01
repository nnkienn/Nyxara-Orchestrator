import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const sourceExt = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".cs", ".cpp", ".c", ".h"]);
function walk(dir: string, out: string[] = []): string[] { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (["node_modules", ".git", "dist", "coverage"].includes(e.name)) continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; }
function du(p: string): number { if (!fs.existsSync(p)) return 0; let n = 0; try { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); n += e.isDirectory() ? du(q) : fs.statSync(q).size; } } catch {} return n; }
export function collectRepoStats(repoPath: string): Record<string, unknown> {
  const files = fs.existsSync(repoPath) ? walk(repoPath) : []; const relevant = files.filter(f => sourceExt.has(path.extname(f).toLowerCase())); const ext: Record<string, number> = {}; for (const f of files) { const x = path.extname(f).toLowerCase() || "[none]"; ext[x] = (ext[x] ?? 0) + 1; }
  let tracked = 0; try { tracked = Number(execFileSync("git", ["-C", repoPath, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).length); } catch {}
  const packages = files.filter(f => path.basename(f) === "package.json").length;
  const classification = relevant.length < 500 ? "small" : relevant.length <= 5000 ? "medium" : "large";
  return { pathLabel: path.basename(path.resolve(repoPath)), isGitRepository: fs.existsSync(path.join(repoPath, ".git")), trackedFileCount: tracked, sourceFileCount: relevant.length, relevantSourceBytes: relevant.reduce((n, f) => n + fs.statSync(f).size, 0), diskBytes: du(repoPath), nodeModulesBytes: du(path.join(repoPath, "node_modules")), gitBytes: du(path.join(repoPath, ".git")), packageCount: packages, extensionDistribution: ext, classification };
}
