import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "apps/vscode/package.json"), "utf8"));
const vsix = path.join(root, "dist/vscode", `nyxara-vscode-${manifest.version}.vsix`);
const packageResult = spawnSync("npm", ["run", "vscode:package"], { cwd: root, stdio: "inherit" });
if (packageResult.status !== 0) process.exit(packageResult.status ?? 1);
const installResult = spawnSync("code", ["--install-extension", vsix, "--force"], { cwd: root, encoding: "utf8" });
if (installResult.error) {
  console.error(`VSIX is ready at ${vsix}, but the code CLI could not run: ${installResult.error.code ?? installResult.error.message}`);
  process.exit(1);
}
if (installResult.stdout) process.stdout.write(installResult.stdout);
if (installResult.stderr) process.stderr.write(installResult.stderr);
if (installResult.status !== 0) process.exit(installResult.status ?? 1);
const listResult = spawnSync("code", ["--list-extensions", "--show-versions"], { cwd: root, encoding: "utf8" });
if (listResult.status !== 0) {
  if (listResult.stderr) process.stderr.write(listResult.stderr);
  process.exit(listResult.status ?? 1);
}
const extensionId = `${manifest.publisher}.${manifest.name}`.toLowerCase();
const installed = listResult.stdout.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${extensionId}@`));
if (installed !== `${extensionId}@${manifest.version}`) {
  console.error(`Installed extension version could not be verified (expected ${extensionId}@${manifest.version}).`);
  process.exit(1);
}
console.log(`Installed Nyxara v${installed.slice(installed.lastIndexOf("@") + 1)} (Local Dogfood)`);
console.log('Run "Developer: Reload Window" in VS Code.');
