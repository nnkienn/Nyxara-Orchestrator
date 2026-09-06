import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeErrorMessage, usageSummary } from "../src/projection.js";

describe("extension idle and secret safety", () => {
  it("contains no polling timers, file-system watchers, or background refresh loops", () => {
    const source = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
    for (const forbidden of ["setInterval(", "createFileSystemWatcher(", "fs.watch(", "watchFile("]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source.match(/setTimeout\(/g)).toHaveLength(1);
    expect(source).toContain("DEFAULT_AUTH_TIMEOUT_MS");
  });

  it("bounds provider/auth errors and redacts common credential forms", () => {
    const fakeSecret = "sk-fake-secret-123456789";
    const rendered = safeErrorMessage(new Error(`Authorization: Bearer ${fakeSecret} api_key=${fakeSecret} ${"x".repeat(500)}`));
    expect(rendered.length).toBeLessThanOrEqual(240);
    expect(rendered).not.toContain(fakeSecret);
    expect(rendered).toContain("[redacted]");
  });

  it("redacts OAuth-like tokens and cookies from browser-auth errors", () => {
    const rendered = safeErrorMessage(new Error("access_token=oauth-secret refresh-token=refresh-secret Cookie=session-secret"));
    expect(rendered).not.toContain("oauth-secret");
    expect(rendered).not.toContain("refresh-secret");
    expect(rendered).not.toContain("session-secret");
  });

  it("consumes the authoritative Core usage object without recomputing unavailable values", () => {
    const usage = { totalTokens: null, totalProviderCalls: 7, usageSource: "unavailable", totalDurationMs: null };
    expect(usageSummary({ usage } as any)).toEqual({ tokens: null, modelCalls: 7, usageSource: "Unavailable", durationMs: null });
  });

  it("keeps model and execution truth out of the Webview", () => {
    const source = readFileSync(new URL("../media/workspace.js", import.meta.url), "utf8");
    for (const model of ["gpt-5.1", "claude-opus", "claude-sonnet", "claude-haiku", "gemini-2.5"]) expect(source).not.toContain(model);
    expect(source).not.toMatch(/\[\s*["']low["']\s*,\s*["']medium["']\s*,\s*["']high["']\s*\]/);
    expect(source).toContain("capability.values"); expect(source).toContain("provider.models");
  });
});
