import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: { joinPath: (base: any, ...parts: string[]) => ({ toString: () => [base.value, ...parts].join("/") }) },
}), { virtual: true });

import { NyxaraWorkspaceViewProvider } from "../src/webview-view.js";

const baseState = { version: "test", configured: true, workspace: { available: true, multiple: false }, providerLabel: "P · M", advancedRouting: false, providers: [], validation: [], repairCycles: null } as any;

function setup(state = baseState, handle = vi.fn(async () => undefined)) {
  const posted: any[] = [];
  let receive: ((value: unknown) => void) | undefined;
  const webview = {
    options: undefined as any,
    html: "",
    cspSource: "vscode-webview://test",
    asWebviewUri: (uri: any) => uri,
    onDidReceiveMessage: (listener: (value: unknown) => void) => { receive = listener; return { dispose() {} }; },
    postMessage: vi.fn(async (message: unknown) => { posted.push(message); return true; }),
  };
  const provider = new NyxaraWorkspaceViewProvider({ value: "extension" } as any, () => state, handle);
  provider.resolveWebviewView({ webview } as any);
  return { provider, webview, posted, receive: (message: unknown) => receive?.(message), handle };
}

describe("Nyxara Webview controller", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads only local media and reconstructs authoritative state on resolve", () => {
    const h = setup();
    expect(h.webview.options).toMatchObject({ enableScripts: true });
    expect(h.webview.options.localResourceRoots).toHaveLength(1);
    expect(h.webview.html).toContain("Content-Security-Policy");
    expect(h.posted[0]).toEqual({ type: "initialState", state: baseState });
  });

  it("validates messages before forwarding and reports malformed input safely", async () => {
    const h = setup();
    h.receive({ type: "allowPermission", requestId: 42 });
    await Promise.resolve();
    expect(h.handle).not.toHaveBeenCalled();
    expect(h.posted.at(-1)).toEqual({ type: "safeError", message: "Nyxara ignored a malformed sidebar message." });
  });

  it("forwards the exact validated permission request ID", async () => {
    const h = setup();
    h.receive({ type: "allowPermission", requestId: "permission/exact" });
    await Promise.resolve();
    expect(h.handle).toHaveBeenCalledWith({ type: "allowPermission", requestId: "permission/exact" });
  });

  it.each([
    ["planning", "planningStarted"], ["awaiting_plan_approval", "planReady"], ["executing", "workflowSnapshot"], ["validating", "validationUpdated"], ["reviewing", "reviewUpdated"], ["repairing", "repairUpdated"], ["waiting_for_permission", "permissionRequired"], ["completed", "workflowCompleted"], ["failed", "workflowFailed"], ["aborted", "workflowFailed"],
  ])("publishes a typed %s update as %s", (status, expectedType) => {
    const state = { ...baseState, prompt: "task", ...(status === "awaiting_plan_approval" ? { plan: { id: "p" } } : {}), workflow: { id: "w", status, stage: status, active: !["completed", "failed", "aborted"].includes(status), tasks: [], ...(status === "waiting_for_permission" ? { permission: { id: "r", action: "write", reason: "reason" } } : {}) }, ...(["completed", "failed", "aborted"].includes(status) ? { completion: { status } } : {}) };
    const h = setup(state);
    h.provider.refresh();
    expect(h.posted.at(-1)?.type).toBe(expectedType);
  });

  it("sanitizes handler failures before sending them to the Webview", async () => {
    const h = setup(baseState, vi.fn(async () => { throw new Error("Authorization: Bearer sk-fake-secret-123456789"); }));
    h.receive({ type: "approvePlan" });
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.stringify(h.posted.at(-1))).not.toContain("sk-fake-secret");
    expect(h.posted.at(-1)?.message).toContain("[redacted]");
  });
});
