import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSettingsProjection } from "../src/settings-projection.js";
import { webviewHtml } from "../src/webview-html.js";

const browser = [process.env.NYXARA_LAYOUT_BROWSER, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((candidate) => candidate && existsSync(candidate));
const widths = [320, 340, 360, 480, 720];
const layouts = widths.flatMap((width) => [13, 16].map((fontSize) => ({ width, fontSize })));
const longProvider = `Provider${"EnterpriseAccountWithALongName".repeat(6)}`;
const longModel = `organization/${"very-long-model-identifier-".repeat(10)}latest`;
const execution = { kind: "openai_reasoning", label: "Reasoning", control: "select", values: [{ value: "high", label: `High ${"long execution option label ".repeat(8)}` }], provenance: "provider_discovery" } as const;
const provider = { id: "work", catalogId: "openai", type: "openai", displayName: longProvider, modelId: longModel, baseUrl: `https://example.invalid/${"endpoint".repeat(30)}`, authStrategy: "api_key" } as const;
const projection = buildSettingsProjection({
  version: "layout-test", providers: [provider], defaultProviderId: provider.id, credentialStored: new Map([[provider.id, true]]), testedProviderIds: new Set([provider.id]), modelMode: "advanced",
  roles: (["planner", "executor", "reviewer"] as const).map((role) => ({ role, providerConfigId: provider.id, modelId: longModel, executionOptions: { kind: "openai_reasoning", effort: "high" } })),
  modelCapabilities: new Map([[`${provider.id}\0${longModel}`, { execution }]]),
  modelStates: new Map([[provider.id, { providerConfigId: provider.id, status: "loaded", models: [{ id: longModel, name: `Model ${"long display name ".repeat(12)}`, capabilities: { execution } }] }]]),
  selectedPlanningProfile: "default", planningProfiles: [{ id: "default", name: "Default", outputLanguage: "en", planStyle: "balanced", riskMode: "balanced" }],
  engineeringRules: [], historyRetention: 50, historyCount: 0, workspaceFolders: [{ id: "root-0", label: longProvider }, { id: "root-1", label: "Other" }], selectedWorkspaceRootId: "root-0",
});
const budgetExecution = { kind: "anthropic_thinking", label: "Thinking", control: "toggle_number", enabledLabel: "Enable thinking", budgetLabel: "Budget tokens", minimumBudgetTokens: 1024, maximumBudgetTokens: 32768, provenance: "provider_discovery" } as const;
const budgetProjection = {
  ...projection,
  providers: projection.providers.map((entry) => ({ ...entry, models: [{ id: longModel, name: longModel, capabilities: { execution: budgetExecution } }] })),
  roles: projection.roles.map((role) => ({ ...role, executionCapability: budgetExecution, executionOptions: { kind: "anthropic_thinking", enabled: true, budgetTokens: 2048 } })),
};
const emptyProjection = { ...projection, providers: projection.providers.map((entry) => ({ ...entry, models: [], modelsMessage: `Catalog unavailable: ${"unbroken-helper-text".repeat(20)}` })) };
const scenarios = [
  { name: "settings-home", section: "home", projection },
  { name: "simple", section: "modelsRoles", projection: { ...projection, modelMode: "simple" } },
  { name: "advanced", section: "modelsRoles", projection },
  { name: "manual-id", section: "modelsRoles", projection, manual: true },
  { name: "thinking-budget", section: "modelsRoles", projection: budgetProjection },
  { name: "empty-catalog", section: "modelsRoles", projection: emptyProjection },
  { name: "providers", section: "aiProviders", projection },
  { name: "provider-details", section: "aiProviders", projection: { ...projection, providers: projection.providers.map((entry) => ({ ...entry, endpoint: provider.baseUrl })) }, providerConfigId: provider.id },
  { name: "gateway-add-key", section: "aiProviders", projection: { ...projection, providers: projection.providers.map((entry) => ({ ...entry, displayName: "9Router", endpoint: "http://127.0.0.1:20128/v1", authStrategy: "none", authMethods: ["api_key", "none"], credentialStored: false, status: "Configured", liveStatus: "failed", authentication: "No API key configured. Use Add API Key if this gateway requires authentication.", connectionMessage: "Last connection test failed. Use Test Connection to retry.", lifecycleAction: "Remove Provider" })) }, providerConfigId: provider.id },
  { name: "workspace", section: "workspace", projection },
  { name: "workflow", section: "workflow", projection },
  { name: "advanced-settings", section: "advanced", projection },
].map(({ name, manual, ...settings }) => ({ name, manual, state: { version: "layout-test", configured: true, workspace: { available: true, multiple: true }, providers: [{ id: provider.id, displayName: longProvider, modelId: longModel, isDefault: true }], validation: [], repairCycles: null, settings } }));

interface LayoutResult {
  name: string; width: number; fontSize: number; error?: string; outsideViewport: string[]; outsideContainer: string[]; invisibleControls: string[]; undersizedFields: string[]; scrollingContainers: unknown[];
  ellipsis: Array<{ element: string; ellipsis: boolean; nowrap: boolean }>; helperWraps: boolean;
  gridWidth: number | null; gridTrack: number | null; selectedIds: string[]; settingsColumns: number | null; clippedCards: number;
  apiKeyActions: string[];
}

describe.skipIf(!browser)("Nyxara real-browser sidebar layout", () => {
  let directory: string;
  let results: LayoutResult[] = [];
  let browserErrors: string[] = [];
  let messages: Array<{ type: string }> = [];

  beforeAll(() => {
    const artifacts = process.env.NYXARA_LAYOUT_ARTIFACTS;
    if (artifacts) mkdirSync(artifacts, { recursive: true });
    directory = mkdtempSync(join(artifacts || tmpdir(), "nyxara-sidebar-layout-"));
    const fileUri = (name: string) => pathToFileURL(join(directory, name)).href;
    const scriptUri = pathToFileURL(fileURLToPath(new URL("../media/workspace.js", import.meta.url))).href;
    const styleUri = pathToFileURL(fileURLToPath(new URL("../media/workspace.css", import.meta.url))).href;
    writeFileSync(join(directory, "theme.css"), ':root { --vscode-font-weight: 400; --vscode-font-size: 13px; --vscode-font-family: Arial, sans-serif; --vscode-foreground: #cccccc; --vscode-sideBar-background: #181818; --vscode-input-background: #313131; --vscode-widget-border: #444; --vscode-input-border: #555; --vscode-descriptionForeground: #aaa; --vscode-button-background: #0078d4; --vscode-button-foreground: #fff; }');
    writeFileSync(join(directory, "bootstrap.js"), `document.documentElement.style.setProperty('--vscode-font-size', new URLSearchParams(location.search).get('fontSize') + 'px'); window.layoutScenarios = ${JSON.stringify(scenarios)}; window.layoutErrors = []; window.layoutMessages = []; window.addEventListener('error', event => window.layoutErrors.push(event.message)); window.acquireVsCodeApi = () => ({ postMessage: message => window.layoutMessages.push(message) });`);
    writeFileSync(join(directory, "probe.js"), readFileSync(new URL("./fixtures/sidebar-layout-probe.js", import.meta.url)));
    const frame = webviewHtml("file:", scriptUri, styleUri, "layout-test")
      .replace("</head>", `<link rel="stylesheet" href="${fileUri("theme.css")}"><script nonce="layout-test" src="${fileUri("bootstrap.js")}"></script></head>`)
      .replace("</body>", `<script nonce="layout-test" src="${fileUri("probe.js")}"></script></body>`);
    writeFileSync(join(directory, "frame.html"), frame);
    writeFileSync(join(directory, "index.html"), `<!doctype html><html><body><pre id="layout-results"></pre><script>const frames = []; window.addEventListener('message', event => { if (event.data?.type !== 'sidebarLayoutResults') return; frames.push(event.data); if (frames.length === ${layouts.length}) document.getElementById('layout-results').textContent = encodeURIComponent(JSON.stringify(frames)); });</script>${layouts.map(({ width, fontSize }) => `<iframe title="${width}px sidebar with ${fontSize}px font" style="width:${width}px;height:780px;border:0" src="${fileUri("frame.html")}?fontSize=${fontSize}"></iframe>`).join("")}</body></html>`);
    const run = spawnSync(browser!, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--allow-file-access-from-files", `--user-data-dir=${join(directory, "chrome")}`, "--virtual-time-budget=3000", "--dump-dom", fileUri("index.html")], { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    expect(run.error, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const encoded = run.stdout.match(/<pre id="layout-results">([^<]+)<\/pre>/)?.[1];
    expect(encoded, `Browser did not finish the layout probe: ${run.stderr}`).toBeTruthy();
    const frames = JSON.parse(decodeURIComponent(encoded!)) as Array<{ results: LayoutResult[]; errors: string[]; messages: Array<{ type: string }> }>;
    results = frames.flatMap((frame) => frame.results);
    browserErrors = frames.flatMap((frame) => frame.errors);
    messages = frames.flatMap((frame) => frame.messages);
    writeFileSync(join(directory, "results.json"), JSON.stringify(results, null, 2));
  }, 35000);

  afterAll(() => { if (directory && !process.env.NYXARA_LAYOUT_ARTIFACTS) rmSync(directory, { recursive: true, force: true }); });

  it.each(widths)("fits all Settings controls at %ipx without clipping or horizontal scrolling", (width) => {
    const atWidth = results.filter((result) => result.width === width);
    expect(atWidth).toHaveLength(scenarios.length * 2);
    expect(new Set(atWidth.map((result) => result.fontSize))).toEqual(new Set([13, 16]));
    for (const result of atWidth) {
      expect(result.error, result.name).toBeUndefined();
      expect(result.outsideViewport, result.name).toEqual([]);
      expect(result.outsideContainer, result.name).toEqual([]);
      expect(result.invisibleControls, result.name).toEqual([]);
      expect(result.undersizedFields, result.name).toEqual([]);
      expect(result.scrollingContainers, result.name).toEqual([]);
      expect(result.clippedCards, result.name).toBe(0);
      expect(result.helperWraps, result.name).toBe(true);
      if (result.gridWidth !== null) expect(result.gridTrack!, result.name).toBeLessThanOrEqual(result.gridWidth + 1);
    }
  });

  it("ellipsizes long labels without changing selected model IDs", () => {
    for (const result of results) {
      for (const label of result.ellipsis) expect(label, `${result.name} ${result.width}px`).toMatchObject({ ellipsis: true, nowrap: true });
      if (["simple", "advanced", "thinking-budget"].includes(result.name)) expect(result.selectedIds, result.name).toEqual(Array(result.name === "simple" ? 1 : 3).fill(`model:${longModel}`));
    }
  });

  it("keeps Add API Key visible for an unauthenticated gateway at every sidebar width", () => {
    const gateways = results.filter((result) => result.name === "gateway-add-key");
    expect(gateways).toHaveLength(layouts.length);
    for (const result of gateways) expect(result.apiKeyActions, `${result.width}px ${result.fontSize}px font`).toEqual(["Add API Key"]);
  });

  it("stacks narrow metadata, preserves wide columns, and performs no external actions", () => {
    expect(browserErrors).toEqual([]);
    expect(messages).toEqual(layouts.map(() => ({ type: "ready" })));
    for (const result of results.filter((result) => result.name === "provider-details")) expect(result.settingsColumns, `${result.width}px`).toBe(result.width <= 360 ? 1 : 2);
  });
});
