import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webviewHtml } from "../src/webview-html.js";

const html = webviewHtml("vscode-webview://test", "script.js", "style.css", "nonce123");
const runtime = readFileSync(new URL("../media/workspace.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../media/workspace.css", import.meta.url), "utf8");

describe("Nyxara Webview shell", () => {
  it("renders the persistent header, New Task, History, and Settings actions", () => {
    expect(html).toContain("NYXARA");
    expect(html).toContain('id="new-task"');
    expect(html).toContain('aria-label="New Task"');
    expect(html).toContain('id="history"');
    expect(html).toContain('aria-label="Task History"');
    expect(html).toContain('id="settings"');
    expect(html).toContain('aria-label="Settings"');
  });

  it("renders a persistent bounded multiline composer and provider/model selector", () => {
    expect(html).toContain("<textarea");
    expect(html).toContain('placeholder="What do you want to build?"');
    expect(html).toContain('maxlength="20000"');
    expect(html).toContain('id="model"');
    expect(html).toContain('aria-label="Current provider and model"');
    expect(html).toContain('aria-label="Generate Plan"');
  });

  it("uses a strict nonce CSP with no remote execution surface", () => {
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("script-src 'nonce-nonce123'");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("unsafe-inline");
    expect(html).not.toContain("unsafe-eval");
  });

  it("renders all dynamic data with textContent and never innerHTML", () => {
    expect(runtime).toContain("textContent");
    expect(runtime).not.toContain("innerHTML");
    expect(runtime).not.toContain("insertAdjacentHTML");
    expect(runtime).not.toContain("outerHTML");
  });

  it("uses VS Code theme tokens and supports narrow/high-contrast-compatible layout", () => {
    expect(styles).toContain("var(--vscode-foreground)");
    expect(styles).toContain("var(--vscode-focusBorder)");
    expect(styles).toContain("@media (max-width: 230px)");
    expect(styles).not.toContain("@font-face");
  });

  it("keeps the timeline independently scrollable above the pinned composer", () => {
    expect(styles).toContain("flex-direction: column");
    expect(styles).toContain("flex: 1 1 0");
    expect(styles).toContain("flex: 0 0 auto");
    expect(styles).toContain("overflow-y: auto");
    expect(runtime).toContain("isNearBottom");
  });

  it("keeps the unsupported context action honestly disabled", () => {
    expect(html).toContain('id="context"');
    expect(html).toContain("disabled title=\"Context actions are not available yet\"");
  });
});
