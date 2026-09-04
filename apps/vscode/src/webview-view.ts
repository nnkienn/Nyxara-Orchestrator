import * as vscode from "vscode";
import { createNonce, webviewHtml } from "./webview-html.js";
import { friendlyErrorMessage } from "./projection.js";
import { parseWebviewMessage, type StateMessageType, type WebviewToExtensionMessage } from "./webview-protocol.js";
import type { WorkspaceViewState } from "./workspace-state.js";

export class NyxaraWorkspaceViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: any,
    private readonly state: () => WorkspaceViewState,
    private readonly handle: (message: WebviewToExtensionMessage) => Promise<void>,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const scriptUri = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "workspace.js")).toString();
    const styleUri = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "workspace.css")).toString();
    view.webview.html = webviewHtml(view.webview.cspSource, scriptUri, styleUri, createNonce());
    view.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (!message) { void this.error("Nyxara ignored a malformed sidebar message."); return; }
      void this.handle(message).catch((error: unknown) => this.error(error));
    });
    this.refresh("initialState");
  }

  refresh(type?: StateMessageType): void {
    if (!this.view) return;
    const state = this.state();
    void this.view.webview.postMessage({ type: type ?? updateType(state), state });
  }

  error(error: unknown): Promise<boolean> {
    const message = typeof error === "string" ? friendlyErrorMessage(new Error(error)) : friendlyErrorMessage(error);
    return this.view?.webview.postMessage({ type: "safeError", message }) ?? Promise.resolve(false);
  }
}

function updateType(state: WorkspaceViewState): StateMessageType {
  if (state.performanceView) return "performanceProjection";
  if (state.settings) return "settingsProjection";
  if (state.history?.screen === "history") return "taskHistory";
  if (state.history?.screen === "historical") return "historicalTaskLoaded";
  if (state.completion?.status === "completed") return "workflowCompleted";
  if (state.completion) return "workflowFailed";
  if (state.workflow?.permission) return "permissionRequired";
  if (state.workflow?.status === "repairing") return "repairUpdated";
  if (state.workflow?.status === "reviewing") return "reviewUpdated";
  if (state.workflow?.status === "validating") return "validationUpdated";
  if (state.plan && state.workflow?.status === "awaiting_plan_approval") return "planReady";
  if (state.prompt && !state.plan && state.workflow && ["created", "planning"].includes(state.workflow.status)) return "planningStarted";
  if (state.workflow) return "workflowSnapshot";
  return "providerState";
}
