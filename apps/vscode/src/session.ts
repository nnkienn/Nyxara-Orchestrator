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
import { redactSensitiveText, type TaskWorkflowRecovery } from "./task-session.js";

function nonNegativeMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export class NyxaraSession {
  readonly core: NyxaraOrchestrator;
  readonly snapshots = new Map<string, WorkflowSnapshot>();
  plan?: PlanResult;
  private recoveredPlan?: ExecutionPlan;
  private activeRecovery?: TaskWorkflowRecovery;
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
  readonly workflowStageEvidence = new Map<string, string>();
  private planningAbortController?: AbortController;
  private recoveryPersistenceWarningLogged = false;

  constructor(private readonly context: { secrets: any }, private readonly output: { appendLine(value: string): void }, providers: string | readonly ProviderConfig[] = "https://api.openai.com/v1", injectedCore?: NyxaraOrchestrator, private readonly readWorkflowSettings?: () => WorkflowSettings) {
    const configuredProviders = typeof providers === "string"
      ? [new OpenAICompatibleProvider({ baseUrl: providers, credentialStore: new VSCodeCredentialStore(context.secrets) })]
      : providers.map((config) => createProvider(config, context.secrets));
    this.core = injectedCore ?? new NyxaraOrchestrator({ providers: configuredProviders });
    this.core.events.on("workflow.status_changed", (event: any) => {
      if (["created", "planning", "executing", "running", "validating", "reviewing", "repairing"].includes(event.to)) this.workflowStageEvidence.set(event.workflowId, event.to);
      this.log(`workflow ${event.workflowId}: ${event.to}`);
    });
    this.core.events.on("workflow.completed", (event: any) => this.log(`workflow ${event.workflowId}: completed`));
    this.core.events.on("workflow.failed", (event: any) => this.log(`workflow ${event.workflowId}: failed (${event.code})`));
    this.core.events.on("workflow.aborted", (event: any) => this.log(`workflow ${event.workflowId}: aborted`));
    this.core.events.on("executor.failed", (event) => {
      if (!this.workflowId || event.workflowId !== this.workflowId) return;
      const phase = ["model_resolution", "generation", "tools", "response"].includes(event.phase ?? "") ? event.phase : "unknown";
      const statusCode = typeof event.statusCode === "number" && Number.isInteger(event.statusCode) && event.statusCode >= 100 && event.statusCode <= 599 ? event.statusCode : undefined;
      this.output.appendLine(`Executor failure: ${JSON.stringify({ phase, ...(statusCode ? { statusCode } : {}) })}`);
    });
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
    delete this.plan;
    delete this.recoveredPlan;
    delete this.activeRecovery;
    delete this.result;
    this.validation.clear();
    this.validationDurations.clear();
    delete this.reviewStatus;
    delete this.reviewFindingCount;
    delete this.repairCycle;
    this.recoveryPersistenceWarningLogged = false;
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

  buildRecovery(): TaskWorkflowRecovery | undefined {
    const snapshot = this.snapshot;
    const plan = this.currentPlan;
    if (!this.workflowId || !plan || snapshot?.status !== "failed" || snapshot.plan?.status !== "approved") return undefined;
    const approval = this.core.getPlanRuntimeState(plan.id);
    if (!approval.approvedAt || !approval.approval) return undefined;
    const workflow = this.core.getWorkflowState(this.workflowId);
    const recoveryText = JSON.stringify({ prompt: workflow.prompt, plan });
    if (redactSensitiveText(recoveryText) !== recoveryText) {
      if (!this.recoveryPersistenceWarningLogged) {
        this.output.appendLine("Executor recovery was not persisted because the approved plan or requirement contains credential-shaped text.");
        this.recoveryPersistenceWarningLogged = true;
      }
      return undefined;
    }
    return {
      plan,
      workflow,
      tasks: snapshot.tasks.map((task) => ({
        taskId: task.taskId,
        ...(task.executionStatus ? { executionStatus: task.executionStatus } : {}),
        ...(task.attempts !== undefined ? { attempts: task.attempts } : {}),
      })),
      taskExecutionStates: this.core.getTaskExecutionStates(plan),
      approvedAt: approval.approvedAt,
      approvedPlanFingerprint: approval.approval.planFingerprint,
      allowRepair: this.workflowSettingsSnapshot?.allowRepair ?? true,
      pipelineConfig: this.workflowPipelineConfig(),
      ...(this.result?.status === "failed" && this.result.workflowId === this.workflowId && this.result.planId === plan.id ? { result: boundedRecoveryResult(this.result) } : {}),
    };
  }

  restoreRecovery(recovery: TaskWorkflowRecovery): void {
    this.core.restoreApprovedExecution({
      workflow: recovery.workflow,
      tasks: recovery.tasks,
      plan: recovery.plan,
      approvedAt: recovery.approvedAt,
      approvedPlanFingerprint: recovery.approvedPlanFingerprint,
      taskExecutionStates: recovery.taskExecutionStates,
      pipelineConfig: recovery.pipelineConfig,
      allowRepair: recovery.allowRepair,
      ...(recovery.result ? { result: recovery.result } : {}),
    });
    this.workflowId = recovery.workflow.id;
    this.prompt = recovery.workflow.prompt;
    this.recoveredPlan = recovery.plan;
    this.activeRecovery = recovery;
    this.refresh();
  }

  private workflowPipelineConfig(): TaskWorkflowRecovery["pipelineConfig"] {
    const settings = this.workflowSettingsSnapshot;
    return {
      ...(settings?.validation ? { validation: settings.validation } : {}),
      ...(settings?.repairLimits ? { repairLimits: settings.repairLimits } : {}),
      ...(settings?.reviewerLimits ? { reviewerLimits: settings.reviewerLimits } : {}),
    };
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

  async retryExecution(input: { readonly workflowId: string; readonly planId: string; readonly taskId: string }): Promise<WorkflowRunOutcome> {
    const retry = this.snapshot?.executionRetry;
    const recovery = this.activeRecovery;
    if (input.workflowId !== this.workflowId || input.planId !== this.currentPlan?.id) throw new Error("That failed Executor attempt is no longer available.");
    if (retry && (retry.planId !== input.planId || retry.taskId !== input.taskId)) throw new Error("That failed Executor attempt is no longer available.");
    if (!retry && (!recovery || recovery.workflow.id !== input.workflowId || recovery.plan.id !== input.planId || recovery.workflow.failedTaskId !== input.taskId)) throw new Error("That failed Executor attempt is no longer available.");
    const previousResult = this.result;
    delete this.result;
    try {
      const outcome = retry
        ? await this.core.retryWorkflowExecution(input)
        : await this.core.recoverApprovedExecution({ ...recovery!, taskExecutionStates: recovery!.taskExecutionStates, pipelineConfig: recovery!.pipelineConfig as any });
      if ("workflowId" in outcome && (outcome.status === "completed" || outcome.status === "failed" || outcome.status === "aborted")) this.result = outcome;
      return outcome;
    } catch (error) {
      if (previousResult) this.result = previousResult;
      else delete this.result;
      throw error;
    } finally {
      this.refresh();
      this.onChange?.();
    }
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
  get currentPlan(): ExecutionPlan | undefined { return this.plan?.plan ?? this.recoveredPlan; }
  resetPresentation(): void {
    const active = this.snapshot?.status;
    if (active && !["completed", "failed", "aborted"].includes(active)) throw new Error("Finish or abort the active workflow before starting a new task.");
    delete this.workflowSettingsSnapshot; delete this.recoveredPlan; delete this.activeRecovery; this.recoveryPersistenceWarningLogged = false;
    delete this.plan; delete this.workflowId; delete this.prompt; delete this.result; this.validation.clear(); this.validationDurations.clear(); delete this.reviewStatus; delete this.reviewFindingCount; delete this.repairCycle; this.snapshots.clear(); this.onChange?.();
  }
}

function boundedRecoveryResult(result: AutonomousWorkflowResult): AutonomousWorkflowResult {
  const boundedIds = (values: readonly string[], maxItems: number, maxLength: number) => values.slice(0, maxItems).map((value) => value.slice(0, maxLength));
  return {
    workflowId: result.workflowId.slice(0, 200),
    planId: result.planId.slice(0, 200),
    status: result.status,
    completedTaskIds: boundedIds(result.completedTaskIds, 200, 200),
    failedTaskIds: boundedIds(result.failedTaskIds, 200, 200),
    blockedTaskIds: boundedIds(result.blockedTaskIds, 200, 200),
    changedFiles: boundedIds(result.changedFiles, 2_000, 4_096),
    totalTasks: Math.min(200, Math.max(0, result.totalTasks)),
    completedTasks: Math.min(200, Math.max(0, result.completedTasks)),
    repairCycles: Math.max(0, result.repairCycles),
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: Math.max(0, result.durationMs),
    ...(result.failure ? { failure: {
      ...(result.failure.taskId ? { taskId: result.failure.taskId.slice(0, 200) } : {}),
      code: result.failure.code.slice(0, 120),
      message: redactSensitiveText(result.failure.message).slice(0, 500),
    } } : {}),
  };
}
