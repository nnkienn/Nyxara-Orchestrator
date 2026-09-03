import * as vscode from "vscode";
import { NyxaraSession } from "./session.js";
import { taskStatusGlyph, workflowStage } from "./projection.js";
import { safeErrorMessage } from "./projection.js";

type UiAction = "generate" | "approve" | "regenerate" | "pause" | "resume" | "abort" | "allow" | "deny";

class NyxaraItem extends vscode.TreeItem {
  constructor(label: string, description?: string, command?: any) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (description !== undefined) this.description = description;
    this.command = command;
  }
}

class NyxaraView implements vscode.TreeDataProvider<any> {
  private readonly changed = new vscode.EventEmitter<any>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly session: NyxaraSession, private readonly act: (action: UiAction) => void) {}
  refresh(): void { this.changed.fire(undefined); }
  getTreeItem(element: any): any { return element; }
  getChildren(): any[] {
    const plan = this.session.currentPlan;
    const snapshot = this.session.snapshot;
    const rows: any[] = this.session.configured
      ? [new NyxaraItem("Provider: Configured"), new NyxaraItem("New Task: Generate Plan", undefined, { command: "nyxara.generatePlan", title: "Generate" })]
      : [new NyxaraItem("Provider: Not configured"), new NyxaraItem("Configure Provider", undefined, { command: "nyxara.configureProvider", title: "Configure Provider" })];
    if (!plan) return rows;
    rows.push(new NyxaraItem(`PLAN · ${plan.objective}`));
    for (const task of plan.tasks) {
      const state = snapshot?.tasks.find((item: any) => item.taskId === task.id);
      const icon = taskStatusGlyph(state?.executionStatus);
      rows.push(new NyxaraItem(`${icon} ${task.id} — ${task.title}`, task.dependencies.length ? `Depends on: ${task.dependencies.join(", ")}` : "Depends on: none"));
      rows.push(new NyxaraItem(`  Acceptance: ${task.acceptanceCriteria.join("; ")}`));
    }
    if (snapshot) {
      rows.push(new NyxaraItem(`WORKFLOW · ${workflowStage(snapshot)}`, snapshot.progress ? `${snapshot.progress.completed}/${snapshot.progress.total}` : undefined));
      if (snapshot.pendingPermission) {
        rows.push(new NyxaraItem(`Permission required: ${snapshot.pendingPermission.capability}${snapshot.pendingPermission.resource ? ` (${snapshot.pendingPermission.resource})` : ""}`, snapshot.pendingPermission.reason));
        rows.push(new NyxaraItem("Allow Once", undefined, { command: "nyxara.allowOnce", title: "Allow Once" }));
        rows.push(new NyxaraItem("Deny", undefined, { command: "nyxara.denyPermission", title: "Deny" }));
      }
      if (snapshot.status === "awaiting_plan_approval") {
        rows.push(new NyxaraItem("Approve & Run", undefined, { command: "nyxara.approveAndRun", title: "Approve" }));
        rows.push(new NyxaraItem("Reject Plan", undefined, { command: "nyxara.rejectPlan", title: "Reject" }));
      }
      if (["running", "executing", "validating", "reviewing", "repairing"].includes(snapshot.status)) rows.push(new NyxaraItem("Pause", undefined, { command: "nyxara.pause", title: "Pause" }));
      if (snapshot.status === "paused") rows.push(new NyxaraItem("Resume", undefined, { command: "nyxara.resume", title: "Resume" }));
      if (!["completed", "failed", "aborted"].includes(snapshot.status)) rows.push(new NyxaraItem("Abort", undefined, { command: "nyxara.abort", title: "Abort" }));
      if (snapshot.status === "completed") rows.push(new NyxaraItem("WORKFLOW COMPLETED", `${snapshot.progress?.completed ?? 0} / ${snapshot.progress?.total ?? 0} tasks`));
      if (this.session.result) rows.push(new NyxaraItem(`Changed files: ${this.session.result.changedFiles.length}`, `Repairs: ${this.session.result.repairCycles} · Duration: ${this.session.result.durationMs}ms`));
      if (this.session.validation.size) rows.push(new NyxaraItem(`Validation: ${[...this.session.validation.entries()].map(([kind, status]) => `${kind} ${status}`).join(" · ")}`));
      const usage = this.session.snapshot?.usage;
      if (usage) {
        const source = usage.usageSource === "provider_reported" ? "Provider reported" : usage.usageSource === "estimated" ? "Estimated" : "Unavailable";
        rows.push(new NyxaraItem(`Tokens: ${usage.totalTokens == null ? "-" : Math.round(usage.totalTokens).toLocaleString()} · Model calls: ${usage.totalProviderCalls}`, `Duration: ${usage.totalDurationMs == null ? "-" : `${Math.round(usage.totalDurationMs)}ms`} · ${source}`));
      }
      if (this.session.reviewStatus) rows.push(new NyxaraItem(`Review: ${this.session.reviewStatus}`));
      if (snapshot.error) rows.push(new NyxaraItem(`Error: ${snapshot.error.message}`));
    }
    return rows;
  }
}

export async function workspaceRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) { void vscode.window.showErrorMessage("Open a workspace folder before using Nyxara."); return undefined; }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const picked = await vscode.window.showQuickPick(folders.map((folder: any) => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: "Select the Nyxara workspace root" });
  return picked?.folder.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext, injectedSession?: NyxaraSession): void {
  const output = vscode.window.createOutputChannel("Nyxara");
  const setting = (key: string): string => vscode.workspace.getConfiguration().get(key, "");
  const session = injectedSession ?? new NyxaraSession(context, output, setting("nyxara.openaiCompatible.baseUrl") || "https://api.openai.com/v1");
  const view = new NyxaraView(session, () => view.refresh());
  session.onChange = () => view.refresh();
  context.subscriptions.push(output, vscode.window.registerTreeDataProvider("nyxara.sidebar", view));

  const register = (name: string, handler: () => Promise<void> | void) => context.subscriptions.push(vscode.commands.registerCommand(name, async () => { try { await handler(); view.refresh(); } catch (error) { const message = safeErrorMessage(error); output.appendLine(`${name}: ${message}`); void vscode.window.showErrorMessage(message); } }));
  session.configureAgents(setting);
  register("nyxara.open", () => vscode.commands.executeCommand("workbench.view.extension.nyxara"));
  register("nyxara.configureProvider", async () => {
    const provider = await vscode.window.showQuickPick(["OpenAI-compatible"], { placeHolder: "Provider type" });
    if (!provider) return;
    const configuration = vscode.workspace.getConfiguration();
    const baseUrl = await vscode.window.showInputBox({ prompt: "OpenAI-compatible base URL", value: setting("nyxara.openaiCompatible.baseUrl") || "https://api.openai.com/v1", ignoreFocusOut: true });
    if (!baseUrl?.trim()) return;
    const apiKey = await vscode.window.showInputBox({ prompt: "API key (stored securely in SecretStorage)", password: true, ignoreFocusOut: true });
    if (!apiKey) return;
    const models: Record<string, string> = {};
    for (const role of ["planner", "executor", "reviewer"]) {
      const model = await vscode.window.showInputBox({ prompt: `${role.charAt(0).toUpperCase()}${role.slice(1)} model ID`, value: setting(`nyxara.${role}.model`), ignoreFocusOut: true });
      if (!model?.trim()) return;
      models[role] = model.trim();
    }
    await configuration.update("nyxara.provider", "openai-compatible", true);
    await configuration.update("nyxara.openaiCompatible.baseUrl", baseUrl.trim(), true);
    for (const role of ["planner", "executor", "reviewer"]) {
      await configuration.update(`nyxara.${role}.provider`, "openai-compatible", true);
      await configuration.update(`nyxara.${role}.model`, models[role], true);
    }
    await context.secrets.store("openai-compatible.apiKey", apiKey);
    session.configureAgents(setting);
    void vscode.window.showInformationMessage("Nyxara provider configured. Reload the window if the base URL changed.");
  });
  register("nyxara.testProviderConnection", async () => {
    void vscode.window.showInformationMessage("Nyxara is checking the provider model-listing endpoint. This does not generate text.");
    const models = await session.core.listModels("openai-compatible");
    void vscode.window.showInformationMessage(`Provider connection succeeded. ${models.length} model${models.length === 1 ? "" : "s"} available.`);
  });
  register("nyxara.generatePlan", async () => {
    const root = await workspaceRoot(); if (!root) return;
    const prompt = await vscode.window.showInputBox({ prompt: "What do you want to build?", ignoreFocusOut: true }); if (!prompt?.trim()) return;
    const providers = session.core.listProviders();
    const providerPick = await vscode.window.showQuickPick(providers.map((provider: any) => ({ label: provider.displayName, description: provider.id, provider })), { placeHolder: "Select provider" });
    if (!providerPick) return;
    const models = await session.core.listModels(providerPick.provider.id);
    const modelPick = await vscode.window.showQuickPick(models.map((model: any) => ({ label: model.name, description: model.id, model })), { placeHolder: "Select model" });
    if (!modelPick) return;
    session.core.configureAgent({ role: "planner", providerId: providerPick.provider.id, modelId: modelPick.model.id });
    for (const role of ["executor", "reviewer"] as const) session.core.configureAgent({ role, providerId: setting(`nyxara.${role}.provider`) || providerPick.provider.id, modelId: setting(`nyxara.${role}.model`) || modelPick.model.id });
    const profiles = session.core.listPlanningProfiles();
    const profilePick = await vscode.window.showQuickPick(profiles.map((profile: any) => ({ label: profile.name, description: profile.id, profile })), { placeHolder: "Select planning profile" });
    const profile = profilePick?.profile.id ?? (setting("nyxara.planningProfile") || "default");
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Nyxara: generating plan" }, () => session.generate(prompt, root, profile));
  });
  register("nyxara.regenerate", async () => { const root = await workspaceRoot(); if (!root || !session.prompt) return; if (session.snapshot?.status !== "awaiting_plan_approval") return; await session.regenerate(session.prompt, root, setting("nyxara.planningProfile") || "default"); });
  register("nyxara.approveAndRun", async () => { const outcome = await session.approveAndRun(); if (outcome.status === "waiting_for_permission") void vscode.window.showInformationMessage("Nyxara is waiting for permission."); });
  register("nyxara.rejectPlan", () => { session.rejectPlan(); void vscode.window.showInformationMessage("Plan rejected."); });
  register("nyxara.pause", () => session.pause());
  register("nyxara.resume", async () => { await session.resume(); });
  register("nyxara.abort", () => { session.abort(); void vscode.window.showInformationMessage("Workflow aborted; existing repository changes remain."); });
  register("nyxara.allowOnce", async () => { const pending = session.snapshot?.pendingPermission; if (pending) await session.resolvePermission(pending.id, "allow"); });
  register("nyxara.denyPermission", async () => { const pending = session.snapshot?.pendingPermission; if (pending) await session.resolvePermission(pending.id, "deny"); });
  register("nyxara.setApiKey", async () => { const value = await vscode.window.showInputBox({ prompt: "Provider API key (stored in SecretStorage)", password: true, ignoreFocusOut: true }); if (value) await context.secrets.store("openai-compatible.apiKey", value); });
  output.appendLine("Nyxara extension activated");
}

export function deactivate(): void {}
