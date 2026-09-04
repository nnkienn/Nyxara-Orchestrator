import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("local dogfood packaging", () => {
  it("uses the extension manifest as the only extension version source", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const packageScript = readFileSync(new URL("../../../scripts/package-vscode.mjs", import.meta.url), "utf8");
    const dogfoodScript = readFileSync(new URL("../../../scripts/vscode-dogfood.mjs", import.meta.url), "utf8");
    expect(manifest.version).toMatch(/^0\.1\.0-alpha\.\d+$/); expect(manifest.repository).toEqual({ type: "git", url: "https://github.com/nnkienn/Nyxara-Orchestrator.git" }); expect(packageScript).toContain("manifest.version"); expect(dogfoodScript).toContain("manifest.version"); expect(packageScript).not.toContain("0.1.0-alpha."); expect(dogfoodScript).not.toContain("0.1.0-alpha.");
  });

  it("contributes the Nyxara Activity Bar surface as a Webview workspace", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.contributes.viewsContainers.activitybar).toContainEqual(expect.objectContaining({ id: "nyxara", title: "Nyxara" }));
    expect(manifest.contributes.views.nyxara).toEqual([{ id: "nyxara.sidebar", name: "Nyxara", type: "webview" }]);
  });

  it("canonical dogfood command builds, checks, packages, force-installs, reports version, and requests reload", () => {
    const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    const dogfoodScript = readFileSync(new URL("../../../scripts/vscode-dogfood.mjs", import.meta.url), "utf8");
    expect(root.scripts.build).not.toContain("pnpm -r"); expect(root.scripts.build).toContain("apps/cli/tsconfig.json"); expect(root.scripts.build).toContain("apps/vscode/tsconfig.json"); expect(root.scripts["vscode:dogfood"]).toBe("node scripts/vscode-dogfood.mjs"); expect(root.scripts["vscode:package"]).toContain("vscode:build"); expect(root.scripts["vscode:package"]).toContain("vscode:test"); expect(dogfoodScript).toContain('"--force"'); expect(dogfoodScript).toContain("Installed Nyxara v"); expect(dogfoodScript).toContain("Developer: Reload Window");
    expect(dogfoodScript).toContain('"--list-extensions", "--show-versions"');
    expect(dogfoodScript).not.toContain("--uninstall-extension");
  });
});
