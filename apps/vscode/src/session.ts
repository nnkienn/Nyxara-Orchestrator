import {
  NyxaraOrchestrator,
  type AutonomousWorkflowResult,
  type CreatePlanInput,
  type ExecutionPlan,
  type PlanResult,
  type PlanningRequestSignals,
  type WorkflowRunOutcome,
  type WorkflowSnapshot,
} from "@nyxara/core";
import { OpenAICompatibleProvider } from "@nyxara/providers";
import type { AgentRole } from "@nyxara/core";
import { VSCodeCredentialStore } from "./credentials.js";
import { createProvider, readPersistedExecution, roleExecutionSetting, type ProviderConfig } from "./provider-config.js";
import type { WorkflowSettings } from "./workflow-settings.js";

function nonNegativeMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export class NyxaraSession {
  readonly core: NyxaraOrchestrator;
  readonly snapshots = new Map<string, WorkflowSnapshot>();
  plan?: PlanResult;
  workflowId?: string;
  prompt?: string;
  result?: AutonomousWorkflowResult;
  readonly validation = new Map<string, string>();
  readonly validationDurations = new Map<string, number>();
  reviewStatus?: string;
  reviewFindingCount?: number;
  repairCycle?: number;
  configured = false;
  onChange?: () => void;
  private workflowSettingsSnapshot?: WorkflowSettings;
  private planningAbortController?: AbortController;

  constructor(private readonly context: { secrets: any }, private readonly output: { appendLine(value: string): void }, providers: string | readonly ProviderConfig[] = "https://api.openai.com/v1", injectedCore?: NyxaraOrchestrator, private readonly readWorkflowSettings?: () => WorkflowSettings) {
    const configuredProviders = typeof providers === "string"
      ? [new OpenAICompatibleProvider({ baseUrl: providers, credentialStore: new VSCodeCredentialStore(context.secrets) })]
      : providers.map((config) => createProvider(config, context.secrets));
    this.core = injectedCore ?? new NyxaraOrchestrator({ providers: configuredProviders });
    this.core.events.on("workflow.status_changed", (event: any) => this.log(`workflow ${event.workflowId}: ${event.to}`));
    this.core.events.on("workflow.completed", (event: any) => this.log(`workflow ${event.workflowId}: completed`));
    this.core.events.on("workflow.failed", (event: any) => this.log(`workflow ${event.workflowId}: failed (${event.code})`));
    this.core.events.on("workflow.aborted", (event: any) => this.log(`workflow ${event.workflowId}: aborted`));
    for (const eventName of ["tool.started", "tool.completed", "tool.failed"] as const) this.core.events.on(eventName, (event) => {
      if (event.tool !== "run_command" || !this.workflowId) return;
      const code = "code" in event && ["tool_error", "command_timeout", "command_blocked", "permission_required", "permission_error"].includes(event.code) ? event.code : "unknown";
      this.output.appendLine(`Command tool ${eventName.slice(5)}${eventName === "tool.failed" ? ` (${code})` : ""}`);
    });
    this.core.events.on("validation.failed", (event) => {
      if (!this.workflowId) return;
      const code = ["no_validation_commands", "package_manager_not_found", "validation_failed", "validation_error", "validation_timeout", "invalid_validation_config"].includes(event.errorCode) ? event.errorCode : "validation_error";
      this.output.appendLine(`Validation failed (${code})`);
    });
    this.core.events.on("planner.completed", (event) => {
      const grouping = event.acceptanceCriteriaGrouping;
      if (!this.workflowId || !grouping) return;
      this.output.appendLine(`Planner acceptance criteria grouped without dropping text: ${JSON.stringify({ tasks: nonNegativeMetric(grouping.tasks), originalCriteria: nonNegativeMetric(grouping.originalCriteria), groupedCriteria: nonNegativeMetric(grouping.groupedCriteria) })}`);
    });
    this.core.events.on("provider.generation.completed", (event) => {
      if (event.role !== "planner" || !this.workflowId || event.workflowId !== this.workflowId) return;
      const finishReason = ["stop", "end_turn", "length", "max_tokens", "MAX_TOKENS", "STOP", "content_filter", "tool_calls", "tool_use"].includes(event.finishReason ?? "")
        ? event.finishReason : "unknown";
      this.output.appendLine(`Planner response received: ${JSON.stringify({
        characters: nonNegativeMetric(event.textLength), finishReason,
        providerDurationMs: nonNegativeMetric(event.providerDurationMs),
        contextFiles: nonNegativeMetric(event.contextFiles), contextBytes: nonNegativeMetric(event.contextBytes),
        contextTruncated: typeof event.contextTruncated === "boolean" ? event.contextTruncated : null,
      })}`);
    });
    for (const eventName of ["workflow.task_selected", "workflow.task_started", "workflow.task_completed", "workflow.task_failed", "workflow.task_blocked", "workflow.permission_requested", "workflow.paused", "workflow.resumed"] as const) this.core.events.on(eventName, () => { this.refresh(); this.onChange?.(); });
    for (const eventName of ["validation.step_passed", "validation.step_failed", "validation.step_skipped", "validation.step_timed_out"] as const) this.core.events.on(eventName, (event: any) => { this.validation.set(event.kind, event.status); if (typeof event.durationMs === "number") this.validationDurations.set(event.kind, event.durationMs); this.onChange?.(); });
    this.core.events.on("reviewer.completed", (event: any) => { this.reviewStatus = event.status; if (Number.isInteger(event.findingCount) && event.findingCount >= 0) this.reviewFindingCount = event.findingCount; this.onChange?.(); });
    this.core.events.on("review.validation_passed", (event: any) => { this.reviewStatus = event.status; this.onChange?.(); });
    this.core.events.on("repair.cycle_started", (event: any) => { if (Number.isInteger(event.cycle) && event.cycle > 0) this.repairCycle = event.cycle; this.onChange?.(); });
  }

  upsertProvider(config: ProviderConfig): void {
    const provider = createProvider(config, this.context.secrets);
    if (this.core.listProviders().some((candidate) => candidate.id === config.id)) this.core.replaceProvider(provider);
    else this.core.registerProvider(provider);
  }

  removeProvider(providerConfigId: string): void {
    this.core.unregisterProvider(providerConfigId);
  }

  private log(message: string): void { this.output.appendLine(message); if (this.workflowId) this.refresh(); this.onChange?.(); }
  private refresh(): void { if (this.workflowId) this.snapshots.set(this.workflowId, this.core.getWorkflowSnapshot(this.workflowId)); }

  configureAgents(settings: (key: string) => unknown, availableProviderIds?: ReadonlySet<string>): void {
    const roles: AgentRole[] = ["planner", "executor", "reviewer"];
    let configuredRoles = 0;
    for (const role of roles) {
      const providerValue = settings(`nyxara.${role}.provider`);
      const modelValue = settings(`nyxara.${role}.model`);
      const providerId = typeof providerValue === "string" ? providerValue : "";
      const modelId = typeof modelValue === "string" ? modelValue : "";
      const execution = readPersistedExecution(settings(roleExecutionSetting(role)));
      if (providerId && modelId && !execution.malformed && (!availableProviderIds || availableProviderIds.has(providerId))) {
        this.core.configureAgent({ role, providerId, modelId, executionOptions: execution.executionOptions });
        configuredRoles += 1;
      }
    }
    this.configured = configuredRoles === roles.length;
  }

  async generate(prompt: string, workspaceRoot: string, profileId: string, requestSignals?: PlanningRequestSignals): Promise<PlanResult> {
    const workflowSettings = this.readWorkflowSettings?.();
    const workflow = this.core.startWorkflow({ workspace: workspaceRoot, prompt });
    if (workflowSettings) this.workflowSettingsSnapshot = structuredClone(workflowSettings);
    this.workflowId = workflow.id;
    this.prompt = prompt;
    this.onChange?.();
    this.plan = await this.requestPlan({ workspaceRoot, prompt, workflowId: workflow.id, ...(profileId ? { planningProfileId: profileId } : {}), ...(requestSignals ? { requestSignals } : {}) });
    this.refresh();
    return this.plan;
  }

  async regenerate(prompt: string, workspaceRoot: string, profileId: string): Promise<PlanResult> {
    if (!this.workflowId) return this.generate(prompt, workspaceRoot, profileId);
    this.prompt = prompt;
    this.plan = await this.requestPlan({ workspaceRoot, prompt, workflowId: this.workflowId, ...(profileId ? { planningProfileId: profileId } : {}) });
    this.refresh();
    return this.plan;
  }

  private async requestPlan(input: CreatePlanInput): Promise<PlanResult> {
    const controller = new AbortController();
    this.planningAbortController = controller;
    try {
      const result = await this.core.createPlan({ ...input, signal: controller.signal });
      controller.signal.throwIfAborted();
      return result;
    } finally {
      if (this.planningAbortController === controller) delete this.planningAbortController;
    }
  }

  async approveAndRun(): Promise<WorkflowRunOutcome> {
    if (!this.workflowId || !this.plan) throw new Error("Generate a plan first");
    this.core.approvePlan(this.workflowId, this.plan.plan.id);
    const outcome = await this.core.runApprovedPlan({ ...this.workflowSettingsSnapshot, workflowId: this.workflowId, planId: this.plan.plan.id });
    if ("workflowId" in outcome && (outcome.status === "completed" || outcome.status === "failed" || outcome.status === "aborted")) this.result = outcome;
    this.refresh();
    this.onChange?.();
    return outcome;
  }

  rejectPlan(): void {
    if (!this.workflowId || !this.plan) throw new Error("Generate a plan first");
    this.core.rejectPlan(this.workflowId, this.plan.plan.id);
    this.refresh();
    this.onChange?.();
  }

  async continue(outcome: WorkflowRunOutcome): Promise<AutonomousWorkflowResult | WorkflowRunOutcome> {
    if (outcome.status === "waiting_for_permission") return outcome;
    if (outcome.status === "paused") return outcome;
    this.refresh();
    return outcome;
  }

  pause(): void { if (this.workflowId) this.core.pauseWorkflow(this.workflowId); this.refresh(); this.onChange?.(); }
  async resume(): Promise<WorkflowRunOutcome> { if (!this.workflowId) throw new Error("No workflow"); const outcome = await this.core.resumeWorkflow(this.workflowId); if ("workflowId" in outcome && (outcome.status === "completed" || outcome.status === "failed" || outcome.status === "aborted")) this.result = outcome; this.refresh(); this.onChange?.(); return outcome; }
  abort(): void { if (this.workflowId) this.core.abortWorkflow(this.workflowId); this.planningAbortController?.abort(); this.refresh(); this.onChange?.(); }
  resolvePermission(id: string, decision: "allow" | "deny"): Promise<WorkflowRunOutcome> {
    if (!this.workflowId) throw new Error("No workflow");
    return this.core.resolveWorkflowPermission({ workflowId: this.workflowId, permissionRequestId: id, decision }).then((outcome) => { if ("workflowId" in outcome && (outcome.status === "completed" || outcome.status === "failed" || outcome.status === "aborted")) this.result = outcome; this.refresh(); this.onChange?.(); return outcome; });
  }
  get snapshot(): WorkflowSnapshot | undefined { return this.workflowId ? this.core.getWorkflowSnapshot(this.workflowId) : undefined; }
  get currentPlan(): ExecutionPlan | undefined { return this.plan?.plan; }
  resetPresentation(): void {
    const active = this.snapshot?.status;
    if (active && !["completed", "failed", "aborted"].includes(active)) throw new Error("Finish or abort the active workflow before starting a new task.");
    delete this.workflowSettingsSnapshot;
    delete this.plan; delete this.workflowId; delete this.prompt; delete this.result; this.validation.clear(); this.validationDurations.clear(); delete this.reviewStatus; delete this.reviewFindingCount; delete this.repairCycle; this.snapshots.clear(); this.onChange?.();
  }
}
