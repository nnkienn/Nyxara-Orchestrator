import { mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "apps/vscode/package.json"), "utf8"));
const output = path.join(root, "dist/vscode", `nyxara-vscode-${manifest.version}.vsix`);
mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync(path.join(root, "node_modules/.bin/vsce"), ["package", "--no-dependencies", "--skip-license", "--out", output], { cwd: path.join(root, "apps/vscode"), stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Packaged Nyxara v${manifest.version}: ${output}`);
