import type {
  GenerateResponse,
  ModelInfo,
  ModelProvider,
  ProviderInfo,
} from "@nyxara/provider-sdk";
import type {
  PendingWorkflowPermission,
  WorkflowSnapshot,
  WorkflowState,
  WorkflowStatus,
} from "@nyxara/shared";
import {
  createDefaultToolRegistry,
  type ToolContext,
  type ToolRegistry,
  type ToolRegistryEvent,
  type PermissionRequest,
} from "@nyxara/tools";
import {
  AgentModelConfigError,
  AgentModelRegistry,
} from "../agents/agent-model-registry.js";
import type { AgentModelConfig, AgentRole } from "../agents/agent.types.js";
import { ContextEngine } from "../context/context-engine.js";
import type {
  BuildContextInput,
  ContextBudget,
  ContextBundle,
  ContextFile,
} from "../context/context.types.js";
import { ApproximateTokenEstimator } from "../context/token-estimator.js";
import {
  selectTaskContext,
  taskContextQuery,
} from "../context/task-context-selector.js";
import { errorCodeOr, errorMessageOr } from "../internal/error-code.js";
import { EventBus } from "../events/event-bus.js";
import type { NyxaraEventMap } from "../events/event.types.js";
import { Executor } from "../executor/executor.js";
import { ExecutorError } from "../executor/executor-error.js";
import { TaskExecutionStore } from "../executor/task-execution-store.js";
import type {
  ExecuteTaskInput,
  ExecuteTaskResult,
  ExecutorLimits,
  TaskExecutionState,
} from "../executor/executor.types.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { Planner } from "../planner/planner.js";
import { PlanningProfileRegistry } from "../planner/planning-profile-registry.js";
import { planningProfileMetadata, type PlanningProfile } from "../planner/planning-profile.js";
import { PlanValidator } from "../planner/plan-validator.js";
import { PlanRuntimeError, PlanRuntimeStore } from "../planner/plan-runtime-store.js";
import type { PlanRuntimeState } from "../planner/plan-runtime-store.js";
import { TaskGraph } from "../planner/task-graph.js";
import type {
  CreatePlanInput,
  ExecutionPlan,
  PlanResult,
  PlannedTask,
} from "../planner/planner.types.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { WorkflowStateError } from "../workflow/workflow.errors.js";
import type {
  WorkflowLimits,
  WorkflowTaskRecord,
  WorkflowTransitionInput,
} from "../workflow/workflow.types.js";
import { ValidationEngine } from "../validation/validation-engine.js";
import { ValidationStore } from "../validation/validation-store.js";
import type {
  ValidateInput,
  ValidationConfig,
  ValidationResult,
} from "../validation/validation.types.js";
import {
  reviewContextBytes,
  ReviewEvidenceBuilder,
  resolveReviewEvidenceBudget,
} from "../review/review-evidence-builder.js";
import { ReviewerError } from "../review/reviewer.errors.js";
import { Reviewer } from "../review/reviewer.js";
import { ReviewStore } from "../review/review-store.js";
import { validateReviewContextRequest } from "../review/review-validator.js";
import type {
  ReviewEvidenceBudget,
  ReviewerLimits,
  ReviewResult,
  ReviewTaskInput,
  ReviewTaskResult,
} from "../review/reviewer.types.js";
import { RepairOrchestrator } from "../repair/repair-orchestrator.js";
import { RepairError } from "../repair/repair.errors.js";
import type {
  RepairLimits,
  RepairOperations,
  RepairResult,
} from "../repair/repair.types.js";
import type {
  ModelGenerateInput,
  NyxaraOrchestratorConfig,
  RepairTaskInput,
  RunTaskPipelineInput,
  StartWorkflowInput,
  TaskPipelineResult,
  AutonomousWorkflowResult,
  WorkflowRunOutcome,
  ResolveWorkflowPermissionInput,
} from "./orchestrator.types.js";
import { aggregateWorkflowUsage, type UsageRecord, type WorkflowUsage } from "@nyxara/shared";
import { deferred, type WorkflowRuntime } from "../workflow/workflow-runtime.js";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { EngineeringRuleRegistry } from "../rules/rule-registry.js";
import { parseEngineeringRule, resolveEngineeringRules, type EngineeringRule, type ResolvedRuleSet } from "../rules/engineering-rule.js";

const TOKEN_ESTIMATOR = new ApproximateTokenEstimator();

export class NyxaraOrchestrator {
  readonly events = new EventBus<NyxaraEventMap>();

  private readonly workflowEngine: WorkflowEngine;
  private readonly providerRegistry = new ProviderRegistry();
  private readonly agentModels: AgentModelRegistry;
  private readonly toolRegistry: ToolRegistry;
  private readonly contextEngine: ContextEngine;
  private readonly planner: Planner;
  private readonly planningProfiles: PlanningProfileRegistry;
  private readonly engineeringRules: EngineeringRuleRegistry;
  private readonly planRuleSets = new Map<string, { planning: ResolvedRuleSet; tasks: ReadonlyMap<string, ResolvedRuleSet> }>();
  private readonly planRuntime = new PlanRuntimeStore();
  private readonly executor: Executor;
  private readonly taskExecutions = new TaskExecutionStore();
  private readonly executorLimits: Partial<ExecutorLimits> | undefined;
  private readonly validationEngine: ValidationEngine;
  private readonly validationStore = new ValidationStore();
  private readonly validationConfig: ValidationConfig | undefined;
  private readonly reviewer: Reviewer;
  private readonly reviewEvidenceBuilder = new ReviewEvidenceBuilder();
  private readonly reviewStore = new ReviewStore();
  private readonly reviewEvidenceBudget: Partial<ReviewEvidenceBudget> | undefined;
  private readonly reviewerLimits: Partial<ReviewerLimits> | undefined;
  private readonly repairOrchestrator: RepairOrchestrator;
  private readonly repairLimits: Partial<RepairLimits> | undefined;
  private readonly plannerContexts = new Map<string, ContextBundle>();
  private readonly workflowRuntimes = new Map<string, WorkflowRuntime>();
  private readonly workflowUsage = new Map<string, WorkflowUsage>();
  private readonly usageRecords = new Map<string, UsageRecord[]>();
  private readonly workflowValidation = new Map<string, ValidationResult[]>();
  private readonly workflowReview = new Map<string, { status: string; calls: number; providerDurationMs: number | null; totalDurationMs: number | null }>();
  private readonly workflowTools = new Map<string, { modelRequested: number; executed: number; successful: number; failed: number; invalid: number; durationMs: number; byName: Record<string, number> }>();
  private readonly workflowTaskTools = new Map<string, Map<string, { modelRequested: number; executed: number; successful: number; failed: number; invalid: number; durationMs: number; byName: Record<string, number> }>>();
  private readonly workflowTargetedExpansions = new Map<string, number>();
  private readonly workflowRepairDuration = new Map<string, number>();
  private readonly finalizedUsage = new Set<string>();

  constructor(config: NyxaraOrchestratorConfig = {}) {
    this.toolRegistry =
      config.toolRegistry ??
      createDefaultToolRegistry({
        observer: (event) => this.emitToolRegistryEvent(event),
      });
    this.workflowEngine = new WorkflowEngine(
      this.events,
      config.workflowLimits ?? {},
    );
    this.contextEngine = new ContextEngine(this.toolRegistry, this.events);
    this.agentModels = new AgentModelRegistry(config.agents ?? []);
    this.planningProfiles = new PlanningProfileRegistry(config.planningProfiles ?? []);
    this.engineeringRules = new EngineeringRuleRegistry(config.engineeringRules ?? []);
    this.planner = new Planner(this.providerRegistry, this.events);
    this.executor = new Executor(
      this.providerRegistry,
      this.toolRegistry,
      this.events,
    );
    this.executorLimits = config.executorLimits;
    this.validationEngine = new ValidationEngine(this.toolRegistry, this.events);
    this.validationConfig = config.validation;
    this.reviewer = new Reviewer(this.providerRegistry, this.events);
    this.reviewEvidenceBudget = config.reviewEvidenceBudget;
    this.reviewerLimits = config.reviewerLimits;
    this.repairLimits = config.repairLimits;
    this.repairOrchestrator = new RepairOrchestrator(this.executor, this.events);
    this.events.on("provider.generation.completed", (event) => {
      if (!event.workflowId || !event.role) return;
      const records = this.usageRecords.get(event.workflowId) ?? [];
      records.push({ role: event.role, providerId: event.providerId, resolvedModelId: event.modelId, ...(event.requestedModelId ? { requestedModelId: event.requestedModelId } : {}), ...(event.taskId ? { taskId: event.taskId } : {}), ...(event.usage?.inputTokens !== undefined ? { inputTokens: event.usage.inputTokens } : {}), ...(event.usage?.outputTokens !== undefined ? { outputTokens: event.usage.outputTokens } : {}), ...(event.usage?.totalTokens !== undefined ? { totalTokens: event.usage.totalTokens } : {}), ...(event.usage?.cost !== undefined ? { providerReportedCost: event.usage.cost } : {}), ...(event.usage?.currency ? { currency: event.usage.currency } : {}), ...(event.providerDurationMs !== undefined ? { providerDurationMs: event.providerDurationMs } : {}), ...(event.contextBytes !== undefined ? { contextBytes: event.contextBytes } : {}), ...(event.contextFiles !== undefined ? { contextFiles: event.contextFiles } : {}), ...(event.contextTruncated !== undefined ? { contextTruncated: event.contextTruncated } : {}), toolCalls: event.toolCallCount });
      if (records.length > 10000) records.splice(0, records.length - 10000);
      this.usageRecords.set(event.workflowId, records);
      this.refreshWorkflowUsage(event.workflowId);
      this.events.emit("usage.updated", { workflowId: event.workflowId });
    });
    this.events.on("executor.completed", (event) => {
      if (!event.workflowId) return;
      const prior = this.workflowTools.get(event.workflowId) ?? { modelRequested: 0, executed: 0, successful: 0, failed: 0, invalid: 0, durationMs: 0, byName: {} };
      prior.modelRequested += event.toolCalls;
      prior.successful += event.successfulToolCalls ?? 0;
      prior.failed += event.failedToolCalls ?? 0;
      prior.invalid += event.invalidToolCalls ?? 0;
      prior.executed += (event.successfulToolCalls ?? 0) + (event.failedToolCalls ?? 0);
      prior.durationMs += event.toolDurationMs ?? 0;
      for (const [name, count] of Object.entries(event.toolCallsByName ?? {})) prior.byName[name] = (prior.byName[name] ?? 0) + count;
      this.workflowTools.set(event.workflowId, prior);
      const tasks = this.workflowTaskTools.get(event.workflowId) ?? new Map();
      const task = tasks.get(event.taskId) ?? { modelRequested: 0, executed: 0, successful: 0, failed: 0, invalid: 0, durationMs: 0, byName: {} };
      task.modelRequested += event.toolCalls; task.successful += event.successfulToolCalls ?? 0; task.failed += event.failedToolCalls ?? 0; task.invalid += event.invalidToolCalls ?? 0; task.executed += (event.successfulToolCalls ?? 0) + (event.failedToolCalls ?? 0);
      task.durationMs += event.toolDurationMs ?? 0;
      for (const [name, count] of Object.entries(event.toolCallsByName ?? {})) task.byName[name] = (task.byName[name] ?? 0) + count;
      tasks.set(event.taskId, task); this.workflowTaskTools.set(event.workflowId, tasks);
    });

    for (const provider of config.providers ?? []) {
      this.registerProvider(provider);
    }
  }

  /**
   * Creates Core-owned workflow state. Status changes from here on are driven by
   * Core APIs such as createPlan and runTaskPipeline; clients never mutate it.
   */
  startWorkflow(input: StartWorkflowInput): WorkflowState {
    return this.workflowEngine.start(input);
  }

  getWorkflowState(workflowId: string): WorkflowState {
    return this.workflowEngine.get(workflowId);
  }

  /** Aggregate summary view of one workflow; never carries evidence payloads. */
  getWorkflowSnapshot(workflowId: string): WorkflowSnapshot {
    const snapshot = this.workflowEngine.snapshot(workflowId);
    const withUsage = this.workflowUsage.get(workflowId);
    if (!snapshot.planId) return withUsage ? Object.freeze({ ...snapshot, usage: withUsage }) : snapshot;
    if (!this.planRuntime.has(snapshot.planId)) return withUsage ? Object.freeze({ ...snapshot, usage: withUsage }) : snapshot;
    const runtime = this.planRuntime.get(snapshot.planId);
    return Object.freeze({
      ...snapshot,
      ...(withUsage ? { usage: withUsage } : {}),
      plan: {
        planId: runtime.planId,
        status: runtime.status,
        taskCount: this.planRuntime.getPlan(runtime.planId).tasks.length,
        ...(runtime.approvedAt ? { approvedAt: runtime.approvedAt } : {}),
      },
    });
  }

  getPlanRuntimeState(planId: string) {
    return this.planRuntime.get(planId);
  }

  getPlan(planId: string): ExecutionPlan {
    return this.planRuntime.getPlan(planId);
  }

  approvePlan(workflowId: string, planId: string) {
    const workflow = this.workflowEngine.get(workflowId);
    const runtime = this.planRuntime.get(planId);
    if (runtime.status === "draft" && workflow.status !== "awaiting_plan_approval") {
      throw new PlanRuntimeError("plan_not_awaiting_approval");
    }
    if (this.planRuntime.workflowId(planId) !== workflowId || workflow.planId !== planId) {
      throw new PlanRuntimeError("plan_workflow_mismatch");
    }
    const approved = this.planRuntime.approve(planId, new Date().toISOString());
    this.workflowEngine.transition(workflowId, "approved", { planId });
    this.events.emit("plan.approved", {
      workflowId,
      planId,
      taskCount: approved.approval?.taskCount ?? 0,
      timestamp: approved.approvedAt ?? new Date().toISOString(),
      status: "approved",
    });
    return approved;
  }

  rejectPlan(workflowId: string, planId: string) {
    const workflow = this.workflowEngine.get(workflowId);
    const runtime = this.planRuntime.get(planId);
    if (this.planRuntime.workflowId(planId) !== workflowId || workflow.planId !== planId) {
      throw new PlanRuntimeError("plan_workflow_mismatch");
    }
    if (workflow.status !== "awaiting_plan_approval") {
      throw new PlanRuntimeError("plan_not_awaiting_approval");
    }
    const rejected = this.planRuntime.reject(planId, new Date().toISOString());
    this.workflowEngine.fail(workflowId, { code: "plan_rejected", message: "Plan rejected by user" });
    this.events.emit("plan.rejected", {
      workflowId,
      planId,
      taskCount: this.planRuntime.getPlan(planId).tasks.length,
      timestamp: rejected.rejectedAt ?? new Date().toISOString(),
      status: "rejected",
    });
    return rejected;
  }

  assertApprovedPlanIntegrity(planId: string, plan: ExecutionPlan): void {
    this.planRuntime.assertIntegrity(planId, plan);
  }

  assertPlanExecutable(plan: ExecutionPlan): void {
    this.planRuntime.assertExecutable(plan);
  }

  replaceDraftPlan(workflowId: string, plan: ExecutionPlan): PlanRuntimeState {
    const workflow = this.workflowEngine.get(workflowId);
    if (workflow.status !== "awaiting_plan_approval") throw new PlanRuntimeError("invalid_plan_state");
    const oldPlanId = workflow.planId;
    if (oldPlanId) {
      const old = this.planRuntime.get(oldPlanId);
      if (old.status !== "draft") throw new PlanRuntimeError("invalid_plan_state");
      this.planRuntime.reject(oldPlanId, new Date().toISOString());
    }
    const runtime = this.planRuntime.register(plan, workflowId);
    this.workflowEngine.setPlan(workflowId, plan.id);
    this.events.emit("plan.draft_replaced", {
      workflowId, planId: plan.id, taskCount: plan.tasks.length,
      timestamp: new Date().toISOString(), status: "draft",
    });
    return runtime;
  }

  listWorkflows(): WorkflowState[] {
    return this.workflowEngine.list();
  }

  abortWorkflow(workflowId: string): WorkflowState {
    const runtime = this.workflowRuntimes.get(workflowId);
    runtime?.abortController.abort();
    runtime?.permissionGate?.resolve("deny");
    runtime?.pauseGate?.release();
    return this.workflowEngine.abort(workflowId);
  }

  pauseWorkflow(workflowId: string): WorkflowState {
    return this.workflowEngine.requestPause(workflowId);
  }

  async resumeWorkflow(workflowId: string): Promise<WorkflowRunOutcome> {
    const runtime = this.requireRuntime(workflowId);
    const state = this.workflowEngine.get(workflowId);
    if (state.status !== "paused") throw new WorkflowStateError("invalid_workflow_transition", `Cannot resume workflow in ${state.status}`);
    this.assertApprovedPlanIntegrity(runtime.planId, runtime.plan);
    await this.assertPausedWorkspaceIntegrity(runtime);
    const outcome = this.waitForRuntimeOutcome(runtime);
    this.workflowEngine.resume(workflowId);
    const gate = runtime.pauseGate;
    delete runtime.pauseGate;
    gate?.release();
    this.advanceApprovedWorkflow(runtime);
    return outcome;
  }

  async resolveWorkflowPermission(input: ResolveWorkflowPermissionInput): Promise<WorkflowRunOutcome> {
    const runtime = this.requireRuntime(input.workflowId);
    const state = this.workflowEngine.get(input.workflowId);
    const pending = state.pendingPermission;
    if (state.status !== "waiting_for_permission" || !pending || !runtime.permissionGate) {
      throw new WorkflowStateError("invalid_workflow_transition", "Workflow is not waiting for permission");
    }
    if (pending.id !== input.permissionRequestId || runtime.permissionGate.requestId !== input.permissionRequestId) {
      throw new WorkflowStateError("invalid_workflow_transition", "Permission request is stale or does not match");
    }
    if (input.decision === "allow") this.assertApprovedPlanIntegrity(runtime.planId, runtime.plan);
    const outcome = this.waitForRuntimeOutcome(runtime);
    this.events.emit(input.decision === "allow" ? "workflow.permission_allowed" : "workflow.permission_denied", {
      workflowId: pending.workflowId, taskId: pending.taskId, permissionRequestId: pending.id,
      capability: pending.capability, ...(pending.resource ? { resource: pending.resource } : {}), decision: input.decision,
    });
    this.workflowEngine.clearPendingPermission(input.workflowId);
    if (input.decision === "allow") this.workflowEngine.resume(input.workflowId);
    else this.workflowEngine.transition(input.workflowId, "failed", { error: { code: "workflow_permission_denied", message: "Permission denied by user" }, failedTaskId: pending.taskId });
    const gate = runtime.permissionGate;
    delete runtime.permissionGate;
    gate.resolve(input.decision);
    if (input.decision === "deny") return outcome;
    this.advanceApprovedWorkflow(runtime);
    return outcome;
  }

  completeWorkflow(workflowId: string): WorkflowState {
    return this.workflowEngine.complete(workflowId);
  }

  failWorkflow(
    workflowId: string,
    error: { readonly code: string; readonly message: string },
  ): WorkflowState {
    return this.workflowEngine.fail(workflowId, error);
  }

  registerProvider(provider: ModelProvider): void {
    this.providerRegistry.register(provider);
    this.events.emit("provider.registered", {
      provider: {
        id: provider.id,
        displayName: provider.displayName,
        capabilities: { ...provider.capabilities() },
      },
    });
  }

  /** Replaces adapter configuration without changing role or workflow semantics. */
  replaceProvider(provider: ModelProvider): void {
    this.providerRegistry.replace(provider);
  }

  /** Removes one provider adapter without changing workflow or role routing. */
  unregisterProvider(providerId: string): boolean {
    return this.providerRegistry.unregister(providerId);
  }

  listProviders(): ProviderInfo[] {
    return this.providerRegistry.list();
  }

  async listModels(providerId: string): Promise<ModelInfo[]> {
    try {
      const models = await this.providerRegistry.get(providerId).listModels();
      this.events.emit("provider.models.completed", { providerId, models });
      return models;
    } catch (error: unknown) {
      this.emitProviderFailure(providerId, "list_models", error);
      throw error;
    }
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResponse> {
    try {
      const response = await this.providerRegistry.get(input.providerId).generate({
        model: input.model,
        prompt: input.prompt,
      });
      this.events.emit("provider.generation.completed", {
        providerId: input.providerId,
        modelId: response.model,
        ...(response.id ? { responseId: response.id } : {}),
        ...(response.finishReason ? { finishReason: response.finishReason } : {}),
        textLength: response.text.length,
        toolCallCount: response.toolCalls?.length ?? 0,
        ...(response.usage ? { usage: response.usage } : {}),
      });
      return response;
    } catch (error: unknown) {
      this.emitProviderFailure(input.providerId, "generate", error);
      throw error;
    }
  }

  listTools(): string[] {
    return this.toolRegistry.list();
  }

  executeTool<TInput, TOutput>(
    name: string,
    input: TInput,
    context: ToolContext,
  ): Promise<TOutput> {
    return this.toolRegistry.execute(name, input, context);
  }

  inspectRepository(input: BuildContextInput): Promise<ContextBundle> {
    return this.contextEngine.build(input);
  }

  configureAgent(configuration: AgentModelConfig): void {
    this.agentModels.set(configuration);
  }

  getAgentModel(role: AgentRole): AgentModelConfig {
    return this.agentModels.get(role);
  }

  listAgentModels(): AgentModelConfig[] {
    return this.agentModels.list();
  }

  registerPlanningProfile(profile: PlanningProfile): PlanningProfile {
    return this.planningProfiles.register(profile);
  }

  getPlanningProfile(id: string): PlanningProfile {
    return this.planningProfiles.get(id);
  }

  listPlanningProfiles(): PlanningProfile[] {
    return this.planningProfiles.list();
  }

  registerEngineeringRule(rule: EngineeringRule): EngineeringRule { return this.engineeringRules.register(rule); }
  getEngineeringRule(id: string): EngineeringRule { return this.engineeringRules.get(id); }
  listEngineeringRules(): EngineeringRule[] { return this.engineeringRules.list(); }

  async createPlan(input: CreatePlanInput): Promise<PlanResult> {
    const workflowId = input.workflowId;
    // Resolve and snapshot once before repository or provider work. Registry
    // mutations cannot produce mixed instructions within this operation.
    const planningProfile = this.planningProfiles.resolve(input.planningProfileId);
    const model = this.agentModels.get("planner");
    const profileMetadata = planningProfileMetadata(planningProfile);
    const workspaceRules = (input.workspaceRules ?? []).map(parseEngineeringRule);
    const planningRules = resolveEngineeringRules(this.engineeringRules.list(), workspaceRules);
    const replacingDraft = workflowId !== undefined
      && this.workflowEngine.get(workflowId).status === "awaiting_plan_approval";
    this.events.emit("planner.profile_resolved", {
      profileId: profileMetadata.id,
      ...(profileMetadata.locale ? { locale: profileMetadata.locale } : {}),
      outputLanguage: profileMetadata.outputLanguage,
      planStyle: profileMetadata.planStyle,
      riskMode: profileMetadata.riskMode,
    });
    this.events.emit("rules.resolved", { ruleCount: planningRules.rules.length, ruleSetFingerprint: planningRules.fingerprint });
    if (!replacingDraft) this.enterWorkflowStatus(workflowId, "planning");

    try {
      const context = await this.contextEngine.build({
        workspaceRoot: input.workspaceRoot,
        prompt: input.prompt,
        ...(input.contextBudget ? { budget: input.contextBudget } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const plan = await this.planner.run({
        input: {
          prompt: input.prompt,
          workspaceRoot: input.workspaceRoot,
          context,
          ...(input.constraints ? { constraints: input.constraints } : {}),
        },
        model,
        planningProfile,
        engineeringRules: planningRules,
        ...(workflowId ? { workflowId } : {}),
      });

      const taskRuleSets = new Map<string, ResolvedRuleSet>();
      for (const task of plan.tasks) {
        const overrides = (input.taskRules?.[task.id] ?? []).map(parseEngineeringRule);
        taskRuleSets.set(task.id, resolveEngineeringRules(this.engineeringRules.list(), workspaceRules, overrides));
      }
      this.planRuleSets.set(plan.id, Object.freeze({ planning: planningRules, tasks: taskRuleSets }));
      if (this.planRuleSets.size > 256) {
        this.planRuleSets.delete(plan.id);
        throw new Error("Engineering rule snapshot store is limited to 256 plans");
      }

      if (workflowId) {
        this.plannerContexts.set(plan.id, context);
        while (this.plannerContexts.size > 20) this.plannerContexts.delete(this.plannerContexts.keys().next().value!);
        if (replacingDraft) {
          this.replaceDraftPlan(workflowId, plan);
        } else {
          this.planRuntime.register(plan, workflowId);
          this.enterWorkflowStatus(workflowId, "awaiting_plan_approval", { planId: plan.id });
          this.events.emit("plan.awaiting_approval", {
            workflowId,
            planId: plan.id,
            taskCount: plan.tasks.length,
            timestamp: new Date().toISOString(),
            status: "draft",
          });
        }
        this.refreshWorkflowUsage(workflowId);
      }
      return {
        plan,
        context,
        model,
        graph: new TaskGraph(plan),
        planningProfile: profileMetadata,
        planningProfileId: profileMetadata.id,
        ruleSetFingerprint: planningRules.fingerprint,
        effectiveRuleIds: Object.freeze(planningRules.rules.map((rule) => rule.id)),
      };
    } catch (error: unknown) {
      // Failed regeneration leaves the prior draft available for approval.
      if (!replacingDraft) this.failWorkflowIfTracked(workflowId, error, "planner_error");
      throw error;
    }
  }

  /** Executes an approved plan sequentially using the existing task pipeline. */
  async runApprovedPlan(input: {
    readonly workflowId: string;
    readonly planId: string;
    readonly signal?: AbortSignal;
    readonly allowRepair?: boolean;
  }): Promise<WorkflowRunOutcome> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const workflow = this.workflowEngine.get(input.workflowId);
    const planRuntimeState = this.planRuntime.get(input.planId);
    const plan = this.planRuntime.getPlan(input.planId);
    if (this.planRuntime.workflowId(input.planId) !== input.workflowId || workflow.planId !== input.planId) {
      throw new PlanRuntimeError("plan_workflow_mismatch");
    }
    if (planRuntimeState.status === "draft") throw new PlanRuntimeError("plan_not_awaiting_approval");
    if (planRuntimeState.status === "rejected") throw new PlanRuntimeError("plan_rejected");
    if (workflow.status !== "approved") throw new PlanRuntimeError("plan_not_awaiting_approval");
    this.assertApprovedPlanIntegrity(input.planId, plan);

    const graph = new TaskGraph(plan);
    if (graph.hasCycle()) throw new PlanRuntimeError("invalid_plan_state", "Plan contains a dependency cycle");
    const runtime: WorkflowRuntime = {
      workflowId: input.workflowId, planId: plan.id, plan, graph,
      completed: new Set(), failed: [], blocked: [], changed: new Set(), repairCycles: 0,
      startedAt, startedMs, allowRepair: input.allowRepair ?? true,
      abortController: new AbortController(), subscribers: new Set(),
      ...(this.plannerContexts.get(plan.id) ? { plannerContext: this.plannerContexts.get(plan.id)! } : {}),
    };
    if (input.signal) {
      if (input.signal.aborted) runtime.abortController.abort();
      else input.signal.addEventListener("abort", () => runtime.abortController.abort(), { once: true });
    }
    this.workflowRuntimes.set(input.workflowId, runtime);
    while (this.workflowRuntimes.size > 20) {
      const oldest = this.workflowRuntimes.keys().next().value as string | undefined;
      if (!oldest) break;
      const candidate = this.workflowRuntimes.get(oldest);
      if (!candidate?.terminalResult) break;
      this.workflowRuntimes.delete(oldest);
    }
    this.workflowEngine.transition(input.workflowId, "running", { planId: plan.id, progress: { completed: 0, total: plan.tasks.length } });
    const outcome = this.waitForRuntimeOutcome(runtime);
    this.advanceApprovedWorkflow(runtime);
    return outcome;
  }

  getTaskExecutionStates(
    plan: ExecutionPlan,
  ): TaskExecutionState[] {
    return this.taskExecutions.list(plan);
  }

  private requireRuntime(workflowId: string): WorkflowRuntime {
    const runtime = this.workflowRuntimes.get(workflowId);
    if (!runtime) throw new WorkflowStateError("workflow_not_found", `Unknown active workflow: ${workflowId}`);
    return runtime;
  }

  private waitForRuntimeOutcome(runtime: WorkflowRuntime): Promise<WorkflowRunOutcome> {
    if (runtime.terminalResult) return Promise.resolve(runtime.terminalResult);
    return new Promise((resolve) => runtime.subscribers.add(resolve));
  }

  private publishRuntimeOutcome(runtime: WorkflowRuntime, outcome: WorkflowRunOutcome): void {
    for (const subscriber of runtime.subscribers) subscriber(outcome);
    runtime.subscribers.clear();
  }

  private finishRuntime(runtime: WorkflowRuntime, status: AutonomousWorkflowResult["status"], failure?: AutonomousWorkflowResult["failure"]): void {
    if (runtime.terminalResult) return;
    const result: AutonomousWorkflowResult = {
      workflowId: runtime.workflowId, planId: runtime.planId, status,
      completedTaskIds: [...runtime.completed], failedTaskIds: [...runtime.failed], blockedTaskIds: [...runtime.blocked],
      changedFiles: [...runtime.changed].sort(), totalTasks: runtime.plan.tasks.length, completedTasks: runtime.completed.size,
      repairCycles: runtime.repairCycles, startedAt: runtime.startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - runtime.startedMs,
      ...(failure ? { failure } : {}),
    };
    const records = this.usageRecords.get(runtime.workflowId) ?? [];
    const context = this.plannerContexts.get(runtime.planId);
    const validations = this.workflowValidation.get(runtime.workflowId) ?? [];
    const validation = validations.length ? { status: validations.every(v => v.status === "passed") ? "passed" as const : "failed" as const, durationMs: validations.reduce((n, v) => n + v.durationMs, 0), steps: validations.flatMap(v => v.steps.map(s => ({ name: s.kind, status: s.status, durationMs: s.durationMs }))) } : undefined;
    const review = this.workflowReview.get(runtime.workflowId);
    const tools = this.workflowTools.get(runtime.workflowId);
    this.workflowUsage.set(runtime.workflowId, aggregateWorkflowUsage(runtime.workflowId, records, { totalDurationMs: result.durationMs, ...(tools ? { toolDurationMs: tools.durationMs } : {}), contextFiles: context?.files.length ?? null, contextBytes: context?.totalBytes ?? null, ...(context ? { contextTruncated: context.truncated } : {}), targetedExpansions: this.workflowTargetedExpansions.get(runtime.workflowId) ?? 0, repairCycles: runtime.repairCycles, repairDurationMs: this.workflowRepairDuration.get(runtime.workflowId) ?? null, ...(validation ? { validationDurationMs: validation.durationMs, validation } : {}), ...(review ? { review } : {}) }));
    const usage = this.workflowUsage.get(runtime.workflowId);
    const finalUsage = usage && tools ? { ...usage, totalToolCalls: tools.executed, toolDurationMs: tools.durationMs, modelRequestedToolCalls: tools.modelRequested, executedToolCalls: tools.executed, successfulToolCalls: tools.successful, failedToolCalls: tools.failed, invalidToolCalls: tools.invalid, toolCallsByName: { ...tools.byName } } : usage;
    const taskTools = this.workflowTaskTools.get(runtime.workflowId);
    const withTaskTools = finalUsage && taskTools ? { ...finalUsage, tasks: finalUsage.tasks.map(task => { const stats = taskTools.get(task.taskId); return stats ? { ...task, toolCalls: stats.executed, toolDurationMs: stats.durationMs, modelRequestedToolCalls: stats.modelRequested, successfulToolCalls: stats.successful, failedToolCalls: stats.failed, invalidToolCalls: stats.invalid, toolCallsByName: { ...stats.byName } } : task; }) } : finalUsage;
    if (withTaskTools) this.workflowUsage.set(runtime.workflowId, withTaskTools);
    runtime.terminalResult = withTaskTools ? { ...result, usage: withTaskTools } : result;
    this.finalizedUsage.add(runtime.workflowId);
    this.trimUsageHistory();
    this.events.emit("usage.finalized", { workflowId: runtime.workflowId });
    this.publishRuntimeOutcome(runtime, runtime.terminalResult);
  }

  private trimUsageHistory(): void {
    while (this.workflowUsage.size > 20) {
      const oldest = [...this.workflowUsage.keys()].find(id => this.finalizedUsage.has(id));
      if (!oldest) return;
      this.workflowUsage.delete(oldest); this.usageRecords.delete(oldest); this.workflowValidation.delete(oldest); this.workflowReview.delete(oldest); this.workflowTools.delete(oldest); this.workflowTaskTools.delete(oldest); this.workflowTargetedExpansions.delete(oldest); this.workflowRepairDuration.delete(oldest); this.finalizedUsage.delete(oldest);
    }
  }

  private refreshWorkflowUsage(workflowId: string): void {
    const state = this.workflowEngine.get(workflowId);
    const context = state.planId ? this.plannerContexts.get(state.planId) : undefined;
    const validations = this.workflowValidation.get(workflowId) ?? [];
    const validation = validations.length ? {
      status: validations.every(v => v.status === "passed") ? "passed" as const : "failed" as const,
      durationMs: validations.reduce((total, value) => total + value.durationMs, 0),
      steps: validations.flatMap(value => value.steps.map(step => ({ name: step.kind, status: step.status, durationMs: step.durationMs }))),
    } : undefined;
    this.workflowUsage.set(workflowId, aggregateWorkflowUsage(workflowId, this.usageRecords.get(workflowId) ?? [], {
      contextFiles: context?.files.length ?? null, contextBytes: context?.totalBytes ?? null,
      ...(context ? { contextTruncated: context.truncated } : {}),
      targetedExpansions: this.workflowTargetedExpansions.get(workflowId) ?? 0,
      ...(validation ? { validation } : {}),
      ...(this.workflowReview.get(workflowId) ? { review: this.workflowReview.get(workflowId)! } : {}),
    }));
  }

  private advanceApprovedWorkflow(runtime: WorkflowRuntime): void {
    if (runtime.advancing) return;
    runtime.advancing = (async () => {
      const workflow = this.workflowEngine.get(runtime.workflowId);
      while (runtime.completed.size + runtime.failed.length + runtime.blocked.length < runtime.plan.tasks.length) {
        if (runtime.abortController.signal.aborted || this.workflowEngine.get(runtime.workflowId).status === "aborted") {
          if (this.workflowEngine.get(runtime.workflowId).status !== "aborted") this.workflowEngine.abort(runtime.workflowId);
          this.finishRuntime(runtime, "aborted", { code: "aborted", message: "Workflow aborted" }); return;
        }
        const state = this.workflowEngine.get(runtime.workflowId);
        // A pause requested while the scheduler is between tasks must be
        // observed before selecting another task. This is the cooperative
        // boundary that guarantees no new work starts after the request.
        if (state.pauseRequested && state.status !== "paused") {
          this.workflowEngine.pause(runtime.workflowId);
          const gate = deferred<void>();
          runtime.pauseGate = { promise: gate.promise, release: gate.resolve };
          const fingerprint = await this.workspaceFingerprint(workflow.workspace);
          if (fingerprint) runtime.pausedWorkspaceFingerprint = fingerprint;
          else delete runtime.pausedWorkspaceFingerprint;
          this.publishRuntimeOutcome(runtime, { status: "paused", snapshot: this.getWorkflowSnapshot(runtime.workflowId) });
          await gate.promise;
          continue;
        }
        if (state.status === "paused") {
          const gate = deferred<void>(); runtime.pauseGate = { promise: gate.promise, release: gate.resolve };
          const fingerprint = await this.workspaceFingerprint(workflow.workspace);
          if (fingerprint) runtime.pausedWorkspaceFingerprint = fingerprint;
          else delete runtime.pausedWorkspaceFingerprint;
          this.publishRuntimeOutcome(runtime, { status: "paused", snapshot: this.getWorkflowSnapshot(runtime.workflowId) });
          await gate.promise; continue;
        }
        const ready = runtime.graph.getReadyTasks(runtime.completed).filter((task) => !runtime.failed.includes(task.id) && !runtime.blocked.includes(task.id));
        const task = ready[0];
        if (!task) {
          const remaining = runtime.plan.tasks.filter((t) => !runtime.completed.has(t.id) && !runtime.failed.includes(t.id) && !runtime.blocked.includes(t.id));
          remaining.forEach((t) => { runtime.blocked.push(t.id); this.workflowEngine.recordTask(runtime.workflowId, { taskId: t.id, executionStatus: "blocked" }); this.events.emit("workflow.task_blocked", { workflowId: runtime.workflowId, planId: runtime.planId, taskId: t.id }); });
          this.workflowEngine.fail(runtime.workflowId, { code: "invalid_task_graph", message: "No ready task remains" });
          this.finishRuntime(runtime, "failed", { code: "invalid_task_graph", message: "No ready task remains" }); return;
        }
        this.workflowEngine.taskStarted(runtime.workflowId, task.id, 1);
        this.workflowEngine.transition(runtime.workflowId, "running", { currentTaskId: task.id, progress: { completed: runtime.completed.size, total: runtime.plan.tasks.length } });
        this.events.emit("workflow.task_selected", { workflowId: runtime.workflowId, planId: runtime.planId, taskId: task.id, completedCount: runtime.completed.size, total: runtime.plan.tasks.length });
        let result: TaskPipelineResult;
        try {
          result = await this.runTaskPipeline({ workflowId: runtime.workflowId, requirement: workflow.prompt, plan: runtime.plan, taskId: task.id, workspaceRoot: workflow.workspace, ...(runtime.plannerContext ? { plannerContext: runtime.plannerContext } : {}), allowRepair: runtime.allowRepair, signal: runtime.abortController.signal, resolvePermission: (request) => this.awaitWorkflowPermission(runtime, task.id, request) });
        } catch (error: unknown) {
          if (runtime.abortController.signal.aborted || errorCodeOr(error, "") === "executor_aborted" || errorCodeOr(error, "") === "reviewer_aborted") { if (this.workflowEngine.get(runtime.workflowId).status !== "aborted") this.workflowEngine.abort(runtime.workflowId); this.finishRuntime(runtime, "aborted", { taskId: task.id, code: "aborted", message: "Workflow aborted" }); return; }
          const code = errorCodeOr(error, "task_pipeline_error"); const message = errorMessageOr(error, "Task pipeline failed");
          runtime.failed.push(task.id); this.workflowEngine.taskFailed(runtime.workflowId, task.id, code, 1); if (this.workflowEngine.get(runtime.workflowId).status !== "failed") this.workflowEngine.fail(runtime.workflowId, { code, message });
          this.finishRuntime(runtime, "failed", { taskId: task.id, code, message }); return;
        }
        for (const file of result.execution.changedFiles) runtime.changed.add(canonicalChangedPath(workflow.workspace, file));
        if (result.repair) { runtime.repairCycles += result.repair.cycles; for (const file of result.repair.changedFiles) runtime.changed.add(canonicalChangedPath(workflow.workspace, file)); }
        if (result.repair?.status === "aborted") { if (this.workflowEngine.get(runtime.workflowId).status !== "aborted") this.workflowEngine.abort(runtime.workflowId); this.finishRuntime(runtime, "aborted", { taskId: task.id, code: "aborted", message: "Workflow aborted" }); return; }
        if (result.status !== "passed") { runtime.failed.push(task.id); for (const dependent of runtime.graph.getDependents(task.id, true)) if (!runtime.blocked.includes(dependent.id) && !runtime.completed.has(dependent.id) && !runtime.failed.includes(dependent.id)) { runtime.blocked.push(dependent.id); this.workflowEngine.recordTask(runtime.workflowId, { taskId: dependent.id, executionStatus: "blocked" }); this.events.emit("workflow.task_blocked", { workflowId: runtime.workflowId, planId: runtime.planId, taskId: dependent.id }); } const code = result.repair?.status ?? "task_failed"; this.workflowEngine.taskFailed(runtime.workflowId, task.id, code, 1); this.workflowEngine.transition(runtime.workflowId, "failed", { failedTaskId: task.id, blockedTaskIds: runtime.blocked, error: { code, message: "Task failed" }, progress: { completed: runtime.completed.size, total: runtime.plan.tasks.length } }); this.finishRuntime(runtime, "failed", { taskId: task.id, code, message: "Task failed" }); return; }
        runtime.completed.add(task.id); this.workflowEngine.taskCompleted(runtime.workflowId, task.id, 1); this.workflowEngine.transition(runtime.workflowId, "running", { currentTaskId: null, progress: { completed: runtime.completed.size, total: runtime.plan.tasks.length } });
        if (this.workflowEngine.get(runtime.workflowId).pauseRequested) { this.workflowEngine.transition(runtime.workflowId, "paused", { pauseRequested: false }); this.events.emit("workflow.paused", { workflowId: runtime.workflowId }); }
      }
      this.workflowEngine.transition(runtime.workflowId, "completed", { currentTaskId: null, progress: { completed: runtime.completed.size, total: runtime.plan.tasks.length } });
      this.finishRuntime(runtime, "completed");
    })().finally(() => { delete runtime.advancing; });
  }

  private async awaitWorkflowPermission(runtime: WorkflowRuntime, taskId: string, request: PermissionRequest): Promise<"allow" | "deny"> {
    const pending: PendingWorkflowPermission = { id: randomUUID(), workflowId: runtime.workflowId, planId: runtime.planId, taskId, capability: request.capability, ...(request.resource ? { resource: request.resource } : {}), requestedAt: new Date().toISOString() };
    this.workflowEngine.setPendingPermission(runtime.workflowId, pending);
    this.workflowEngine.transition(runtime.workflowId, "waiting_for_permission", { currentTaskId: taskId });
    runtime.permissionGate = { requestId: pending.id, resolve: () => undefined };
    const gate = deferred<"allow" | "deny">(); runtime.permissionGate = { requestId: pending.id, resolve: gate.resolve };
    this.workflowEngine.emitPermissionRequested(pending);
    this.publishRuntimeOutcome(runtime, { status: "waiting_for_permission", snapshot: this.getWorkflowSnapshot(runtime.workflowId), permission: pending });
    return gate.promise;
  }

  private async pauseAtBoundary(workflowId: string): Promise<void> {
    const runtime = this.workflowRuntimes.get(workflowId);
    if (!runtime || !this.workflowEngine.get(workflowId).pauseRequested) return;
    this.workflowEngine.pause(workflowId);
    const gate = deferred<void>();
    runtime.pauseGate = { promise: gate.promise, release: gate.resolve };
    const fingerprint = await this.workspaceFingerprint(this.workflowEngine.get(workflowId).workspace);
    if (fingerprint) runtime.pausedWorkspaceFingerprint = fingerprint;
    else delete runtime.pausedWorkspaceFingerprint;
    this.publishRuntimeOutcome(runtime, { status: "paused", snapshot: this.getWorkflowSnapshot(workflowId) });
    await gate.promise;
  }

  private async workspaceFingerprint(workspace: string): Promise<string | undefined> {
    try { const status = await this.toolRegistry.execute<any, any>("git_status", {}, { workspaceRoot: workspace }); const diff = await this.toolRegistry.execute<any, any>("git_diff", { maxBytes: 200000 }, { workspaceRoot: workspace }); return createHash("sha256").update(JSON.stringify({ status, diff })).digest("hex"); } catch { return undefined; }
  }

  private async assertPausedWorkspaceIntegrity(runtime: WorkflowRuntime): Promise<void> {
    if (!runtime.pausedWorkspaceFingerprint) return;
    const current = await this.workspaceFingerprint(this.workflowEngine.get(runtime.workflowId).workspace);
    if (current && current !== runtime.pausedWorkspaceFingerprint) throw new PlanRuntimeError("workspace_changed_during_pause");
  }

  async executeTask(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
    const plan = new PlanValidator().validate(input.plan);
    if (input.workflowId) {
      const workflow = this.workflowEngine.get(input.workflowId);
      if (workflow.planId !== plan.id) throw new PlanRuntimeError("plan_workflow_mismatch");
      if (!["approved", "running", "executing"].includes(workflow.status)) {
        throw new PlanRuntimeError("plan_not_awaiting_approval");
      }
    }
    this.assertPlanExecutable(plan);
    let model: AgentModelConfig;
    try {
      model = this.agentModels.get("executor");
    } catch {
      throw new ExecutorError(
        "executor_not_configured",
        "No provider/model is configured for the Executor role",
      );
    }

    const started = this.taskExecutions.begin(plan, input.taskId);
    this.events.emit("task.execution_started", {
      taskId: started.task.id,
      attempt: started.state.attempts,
    });

    try {
      const resolved = await this.resolveExecutorContext(input, started.task);
      const context = resolved.context;
      if (input.workflowId && resolved.source === "targeted_expansion") {
        this.workflowTargetedExpansions.set(input.workflowId, (this.workflowTargetedExpansions.get(input.workflowId) ?? 0) + 1);
      }
      const result = await this.executor.run({
        input: {
          task: started.task,
          objective: plan.objective,
          workspaceRoot: input.workspaceRoot,
          context,
          attempt: started.state.attempts,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.resolvePermission ? { resolvePermission: input.resolvePermission } : {}),
          ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        },
        model,
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...((input.limits ?? this.executorLimits)
          ? { limits: { ...this.executorLimits, ...input.limits } }
          : {}),
      });
      const state = this.taskExecutions.finish(plan, result);
      if (result.status === "completed") {
        this.events.emit("task.execution_completed", {
          taskId: result.taskId,
          attempt: state.attempts,
          changedFileCount: result.changedFiles.length,
        });
      } else {
        this.events.emit("task.execution_failed", {
          taskId: result.taskId,
          attempt: state.attempts,
          code: "executor_error",
        });
      }
      return {
        result,
        state,
        context,
        model,
        contextSource: resolved.source,
      };
    } catch (error: unknown) {
      const state = this.taskExecutions.fail(plan, input.taskId);
      this.events.emit("task.execution_failed", {
        taskId: input.taskId,
        attempt: state.attempts,
        code: errorCode(error),
      });
      throw error;
    }
  }

  /**
   * Context resolution order: reuse the bounded Planner bundle filtered for this
   * task, widen it with targeted expansion when a relevant file is missing, and
   * only fall back to a full ContextEngine build when no reusable context
   * exists. The fallback is deliberately the last option, not the default.
   */
  private async resolveExecutorContext(
    input: ExecuteTaskInput,
    task: PlannedTask,
  ): Promise<{
    readonly context: ContextBundle;
    readonly source: ExecuteTaskResult["contextSource"];
  }> {
    const planner = input.plannerContext;
    if (!planner || planner.workspaceRoot !== input.workspaceRoot) {
      const context = await this.contextEngine.build({
        workspaceRoot: input.workspaceRoot,
        prompt: taskContextQuery(task),
        ...(input.contextBudget ? { budget: input.contextBudget } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return { context, source: "build" };
    }

    const selection = selectTaskContext({
      task,
      plannerContext: planner,
      ...(input.contextBudget ? { budget: input.contextBudget } : {}),
    });
    if (selection.missingRelevantFiles.length === 0) {
      return { context: selection.context, source: "planner_reuse" };
    }

    try {
      const expanded = await this.contextEngine.expandTargeted({
        workspaceRoot: input.workspaceRoot,
        paths: selection.missingRelevantFiles.slice(0, 4),
        ...(input.contextBudget ? { budget: input.contextBudget } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (expanded.files.length === 0) {
        return { context: selection.context, source: "planner_reuse" };
      }
      return {
        context: mergeContextFiles(selection.context, expanded.files),
        source: "targeted_expansion",
      };
    } catch {
      // Targeted expansion is best-effort: the task still has planner evidence.
      return { context: selection.context, source: "planner_reuse" };
    }
  }

  async validate(input: ValidateInput): Promise<ValidationResult> {
    const config = mergeValidationConfig(this.validationConfig, input.config);
    const result = await this.validationEngine.run({
      ...input,
      ...(config ? { config } : {}),
    });
    this.validationStore.set(result);
    return result;
  }

  getLatestValidationResult(): ValidationResult | undefined {
    return this.validationStore.getLatest();
  }

  async reviewTask(input: ReviewTaskInput): Promise<ReviewTaskResult> {
    if (
      input.execution.taskId !== input.task.id ||
      (input.validation.taskId && input.validation.taskId !== input.task.id) ||
      (input.plannerContext &&
        input.plannerContext.workspaceRoot !== input.executorContext.workspaceRoot)
    ) {
      throw new ReviewerError(
        "invalid_review",
        "Review evidence must belong to the current task and workspace",
      );
    }
    let model: AgentModelConfig;
    try {
      model = this.agentModels.get("reviewer");
    } catch (error: unknown) {
      if (error instanceof AgentModelConfigError) {
        throw new ReviewerError(
          "reviewer_not_configured",
          "No provider/model is configured for the Reviewer role",
        );
      }
      throw error;
    }

    const budget = resolveReviewEvidenceBudget({
      ...this.reviewEvidenceBudget,
      ...input.evidenceBudget,
    });
    const maxReviewerTurns =
      input.limits?.maxReviewerTurns ??
      this.reviewerLimits?.maxReviewerTurns ??
      2;
    const limits = {
      ...this.reviewerLimits,
      ...input.limits,
      maxReviewerTurns,
      maxContextExpansions: Math.min(
        input.limits?.maxContextExpansions ??
          this.reviewerLimits?.maxContextExpansions ??
          budget.maxContextExpansions,
        budget.maxContextExpansions,
        maxReviewerTurns - 1,
      ),
    };
    const evidence = this.reviewEvidenceBuilder.build({
      requirement: input.requirement,
      objective: input.objective,
      task: input.task,
      execution: input.execution,
      validation: input.validation,
      contexts: [
        input.executorContext,
        ...(input.plannerContext ? [input.plannerContext] : []),
      ],
      budget,
    });
    const reviewerInput = {
      requirement: evidence.requirement,
      objective: evidence.objective,
      task: input.task,
      execution: input.execution,
      validation: input.validation,
      evidence,
      ...(input.engineeringRules ? { engineeringRules: input.engineeringRules } : {}),
    };
    const reviewStarted = performance.now();
    const previousReview = input.workflowId ? this.workflowReview.get(input.workflowId) : undefined;
    const reviewRecordStart = input.workflowId ? (this.usageRecords.get(input.workflowId)?.length ?? 0) : 0;
    const reviewed = await this.reviewer.run({
      input: reviewerInput,
      model,
      limits,
      ...(input.signal ? { signal: input.signal } : {}),
      expandContext: async (request, currentEvidence) => {
        validateReviewContextRequest(request);
        const expanded = await this.contextEngine.expandTargeted({
          workspaceRoot: input.executorContext.workspaceRoot,
          ...(request.paths ? { paths: request.paths } : {}),
          ...(request.symbols ? { symbols: request.symbols } : {}),
          budget: {
            maxFiles: budget.maxContextFiles,
            maxBytes: budget.maxContextBytes,
            maxBytesPerFile: budget.maxBytesPerContextFile,
          },
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.engineeringRules ? { engineeringRules: input.engineeringRules } : {}),
        });
        const expandedEvidence = this.reviewEvidenceBuilder.expand(
          currentEvidence,
          expanded.files,
          budget,
        );
        return {
          evidence: expandedEvidence,
          fileCount: expanded.files.length,
          contextBytes: reviewContextBytes(expandedEvidence),
        };
      },
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    });
    if (input.workflowId) {
      const providerDurationMs = (this.usageRecords.get(input.workflowId) ?? []).slice(reviewRecordStart).filter(r => r.role === "reviewer" && r.taskId === input.task.id).reduce<number | null>((sum, r) => sum === null || r.providerDurationMs == null ? null : sum + r.providerDurationMs, 0);
      this.workflowTargetedExpansions.set(input.workflowId, (this.workflowTargetedExpansions.get(input.workflowId) ?? 0) + reviewed.contextExpansions);
      this.workflowReview.set(input.workflowId, { status: reviewed.result.status, calls: (previousReview?.calls ?? 0) + reviewed.turns, providerDurationMs: previousReview?.providerDurationMs === null || providerDurationMs === null ? null : (previousReview?.providerDurationMs ?? 0) + providerDurationMs, totalDurationMs: previousReview?.totalDurationMs === null ? null : (previousReview?.totalDurationMs ?? 0) + performance.now() - reviewStarted });
      this.refreshWorkflowUsage(input.workflowId);
    }
    this.reviewStore.set(input.task.id, reviewed.result);
    return { ...reviewed, model };
  }

  getLatestReviewResult(taskId: string): ReviewResult | undefined {
    return this.reviewStore.get(taskId);
  }

  /**
   * Bounded automatic repair for one already-executed task. The loop reuses the
   * existing Executor, Validation, and Reviewer boundaries: it never replans and
   * never rescans the repository.
   */
  async repairTask(input: RepairTaskInput): Promise<RepairResult> {
    const repairStarted = performance.now();
    const plan = new PlanValidator().validate(input.plan);
    const task = plan.tasks.find((candidate) => candidate.id === input.taskId);
    if (!task) {
      throw new RepairError(
        "task_not_found",
        `Plan task does not exist: ${input.taskId}`,
      );
    }
    if (input.execution.taskId !== task.id) {
      throw new RepairError(
        "repair_error",
        "Repair evidence must belong to the task being repaired",
      );
    }
    let model: AgentModelConfig;
    try {
      model = this.agentModels.get("executor");
    } catch {
      throw new ExecutorError(
        "executor_not_configured",
        "No provider/model is configured for the Executor role",
      );
    }

    const operations: RepairOperations = {
      validate: async (request) => {
        const result = await this.validate({
          workspaceRoot: request.workspaceRoot,
          taskId: request.taskId,
          planId: plan.id,
          ...(request.config ? { config: request.config } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        if (input.workflowId) {
          this.workflowValidation.set(input.workflowId, [...(this.workflowValidation.get(input.workflowId) ?? []), result].slice(-64));
          this.refreshWorkflowUsage(input.workflowId);
        }
        return result;
      },
      review: async (request) => {
        const reviewed = await this.reviewTask({
          ...(input.workflowId ? { workflowId: input.workflowId } : {}),
          requirement: request.requirement,
          objective: request.objective,
          task: request.task,
          execution: request.execution,
          validation: request.validation,
          executorContext: request.executorContext,
          ...(request.plannerContext
            ? { plannerContext: request.plannerContext }
            : {}),
          ...(request.evidenceBudget
            ? { evidenceBudget: request.evidenceBudget }
            : {}),
          ...(request.limits ? { limits: request.limits } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          ...((this.planRuleSets.get(plan.id)?.tasks.get(task.id) ?? input.engineeringRules) ? { engineeringRules: this.planRuleSets.get(plan.id)?.tasks.get(task.id) ?? input.engineeringRules } : {}),
        });
        return reviewed.result;
      },
      expandContext: async (request) => {
        const expanded = await this.contextEngine.expandTargeted({
          workspaceRoot: request.workspaceRoot,
          paths: request.paths,
          ...(request.symbols.length > 0 ? { symbols: request.symbols } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        return expanded.files;
      },
    };

    const executorLimits = { ...this.executorLimits, ...input.executorLimits };
    const limits = { ...this.repairLimits, ...input.limits };
    const result = await this.repairOrchestrator.run(
      {
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        requirement: input.requirement,
        objective: input.objective,
        originalTask: task,
        workspaceRoot: input.workspaceRoot,
        execution: input.execution,
        validation: input.validation,
        ...(input.review ? { review: input.review } : {}),
        executorContext: input.executorContext,
        ...(input.plannerContext ? { plannerContext: input.plannerContext } : {}),
        ...(input.validationConfig
          ? { validationConfig: input.validationConfig }
          : {}),
        ...(Object.keys(executorLimits).length > 0 ? { executorLimits } : {}),
        ...(input.reviewerLimits ? { reviewerLimits: input.reviewerLimits } : {}),
        ...(input.reviewEvidenceBudget
          ? { reviewEvidenceBudget: input.reviewEvidenceBudget }
          : {}),
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.resolvePermission ? { resolvePermission: input.resolvePermission } : {}),
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
      },
      model,
      operations,
    );
    if (input.workflowId) this.workflowRepairDuration.set(input.workflowId, (this.workflowRepairDuration.get(input.workflowId) ?? 0) + Math.max(0, performance.now() - repairStarted));
    return result;
  }

  /**
   * Core-owned task pipeline: Executor, then Validation, then the Reviewer only
   * when validation passed, then a bounded Repair loop. Validation-first
   * authority lives here so no client can re-implement or bypass it.
   */
  async runTaskPipeline(
    input: RunTaskPipelineInput,
  ): Promise<TaskPipelineResult> {
    const plan = new PlanValidator().validate(input.plan);
    this.assertPlanExecutable(plan);
    const task = plan.tasks.find((candidate) => candidate.id === input.taskId);
    if (!task) {
      throw new ExecutorError(
        "task_not_found",
        "Plan task does not exist: " + input.taskId,
      );
    }

    const workflowId = input.workflowId;
    this.enterWorkflowStatus(workflowId, "executing", {
      planId: plan.id,
      currentTaskId: task.id,
    });

    try {
      const executed = await this.executeTask({
        ...(workflowId ? { workflowId } : {}),
        plan,
        taskId: task.id,
        workspaceRoot: input.workspaceRoot,
        ...(input.plannerContext
          ? { plannerContext: input.plannerContext }
          : {}),
        ...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
        ...(input.executorLimits ? { limits: input.executorLimits } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.resolvePermission ? { resolvePermission: input.resolvePermission } : {}),
        ...(workflowId ? { checkpoint: () => this.pauseAtBoundary(workflowId) } : {}),
      });
      this.recordWorkflowTask(workflowId, {
        taskId: task.id,
        executionStatus: executed.result.status,
        attempts: executed.state.attempts,
      });

      if (workflowId) await this.pauseAtBoundary(workflowId);
      this.enterWorkflowStatus(workflowId, "validating");
      const validation = await this.validate({
        workspaceRoot: input.workspaceRoot,
        planId: plan.id,
        taskId: task.id,
        ...(input.validation ? { config: input.validation } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (workflowId) {
        this.workflowValidation.set(workflowId, [...(this.workflowValidation.get(workflowId) ?? []), validation].slice(-64));
        this.refreshWorkflowUsage(workflowId);
      }
      this.recordWorkflowTask(workflowId, {
        taskId: task.id,
        validationStatus: validation.status,
      });
      if (workflowId) await this.pauseAtBoundary(workflowId);

      // Validation-first: a failing deterministic check forbids the Reviewer.
      let reviewed: ReviewTaskResult | undefined;
      if (validation.status === "passed") {
        this.enterWorkflowStatus(workflowId, "reviewing");
        reviewed = await this.reviewTask({
          ...(workflowId ? { workflowId } : {}),
          requirement: input.requirement,
          objective: plan.objective,
          task,
          execution: executed.result,
          validation,
          executorContext: executed.context,
          ...(input.plannerContext
            ? { plannerContext: input.plannerContext }
            : {}),
          ...(input.reviewEvidenceBudget
            ? { evidenceBudget: input.reviewEvidenceBudget }
            : {}),
          ...(input.reviewerLimits ? { limits: input.reviewerLimits } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...((this.planRuleSets.get(plan.id)?.tasks.get(task.id) ?? input.engineeringRules) ? { engineeringRules: this.planRuleSets.get(plan.id)?.tasks.get(task.id) ?? input.engineeringRules } : {}),
        });
        this.recordWorkflowTask(workflowId, {
          taskId: task.id,
          reviewStatus: reviewed.result.status,
        });
        if (workflowId) await this.pauseAtBoundary(workflowId);
      }

      const base = {
        taskId: task.id,
        executorContext: executed.context,
        reviewSkipped: validation.status !== "passed",
      } as const;

      if (executed.result.status === "completed" && validation.status === "passed" && reviewed?.result.status === "passed") {
        return {
          ...base,
          status: "passed",
          execution: executed.result,
          validation,
          review: reviewed.result,
          reviewEvidence: reviewed.evidence,
        };
      }

      if (!input.allowRepair) {
        return {
          ...base,
          status: "failed",
          execution: executed.result,
          validation,
          ...(reviewed
            ? { review: reviewed.result, reviewEvidence: reviewed.evidence }
            : {}),
        };
      }

      this.enterWorkflowStatus(workflowId, "repairing");
      const repair = await this.repairTask({
        ...(workflowId ? { workflowId } : {}),
        requirement: input.requirement,
        objective: plan.objective,
        plan,
        taskId: task.id,
        workspaceRoot: input.workspaceRoot,
        execution: executed.result,
        validation,
        ...(reviewed ? { review: reviewed.result } : {}),
        executorContext: executed.context,
        ...(input.plannerContext
          ? { plannerContext: input.plannerContext }
          : {}),
        ...(input.validation ? { validationConfig: input.validation } : {}),
        ...(input.executorLimits
          ? { executorLimits: input.executorLimits }
          : {}),
        ...(input.reviewerLimits ? { reviewerLimits: input.reviewerLimits } : {}),
        ...(input.reviewEvidenceBudget
          ? { reviewEvidenceBudget: input.reviewEvidenceBudget }
          : {}),
        ...(input.repairLimits ? { limits: input.repairLimits } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...((this.planRuleSets.get(plan.id)?.tasks.get(task.id) ?? input.engineeringRules) ? { engineeringRules: this.planRuleSets.get(plan.id)?.tasks.get(task.id) ?? input.engineeringRules } : {}),
        ...(input.resolvePermission ? { resolvePermission: input.resolvePermission } : {}),
        ...(workflowId ? { checkpoint: () => this.pauseAtBoundary(workflowId) } : {}),
      });

      const finalValidation = repair.finalValidation ?? validation;
      const finalReview = repair.finalReview ?? reviewed?.result;
      this.recordWorkflowTask(workflowId, {
        taskId: task.id,
        repairStatus: repair.status,
        validationStatus: finalValidation.status,
        ...(finalReview ? { reviewStatus: finalReview.status } : {}),
      });

      return {
        ...base,
        status: repair.status === "passed" ? "passed" : "failed",
        execution: repair.finalExecution,
        validation: finalValidation,
        ...(finalReview ? { review: finalReview } : {}),
        ...(reviewed ? { reviewEvidence: reviewed.evidence } : {}),
        repair,
      };
      } catch (error: unknown) {
      if (!input.signal?.aborted) {
        this.failWorkflowIfTracked(workflowId, error, "task_pipeline_error");
      }
      throw error;
    }
  }

  /** Workflow status is only ever changed through the Core state machine. */
  private enterWorkflowStatus(
    workflowId: string | undefined,
    status: WorkflowStatus,
    patch: WorkflowTransitionInput = {},
  ): void {
    if (workflowId === undefined) return;
    this.workflowEngine.transition(workflowId, status, patch);
  }

  private recordWorkflowTask(
    workflowId: string | undefined,
    patch: WorkflowTaskRecord,
  ): void {
    if (workflowId === undefined) return;
    this.workflowEngine.recordTask(workflowId, patch);
  }

  private failWorkflowIfTracked(
    workflowId: string | undefined,
    error: unknown,
    fallbackCode: string,
  ): void {
    if (workflowId === undefined || !this.workflowEngine.has(workflowId)) return;
    try {
      this.workflowEngine.fail(workflowId, {
        code: errorCodeOr(error, fallbackCode),
        message: errorMessageOr(error, "Workflow failed"),
      });
    } catch {
      // A workflow already in a terminal state keeps its original failure.
    }
  }

  private emitProviderFailure(
    providerId: string,
    operation: "list_models" | "generate",
    error: unknown,
  ): void {
    this.events.emit("provider.operation.failed", {
      providerId,
      operation,
      error: {
        message: error instanceof Error ? error.message : "Unknown provider error",
      },
    });
  }

  private emitToolRegistryEvent(event: ToolRegistryEvent): void {
    switch (event.type) {
      case "permission.requested":
        this.events.emit(event.type, {
          tool: event.tool,
          capability: event.capability,
          ...(event.resource ? { resource: event.resource } : {}),
          ...(event.command ? { command: event.command } : {}),
        });
        break;
      case "permission.allowed":
      case "permission.denied":
        this.events.emit(event.type, {
          tool: event.tool,
          capability: event.capability,
        });
        break;
      case "tool.started":
        this.events.emit(event.type, { tool: event.tool });
        if (event.tool === "write_file") {
          this.events.emit("file.write_started", {
            path: event.resources?.[0] ?? "unknown",
          });
        } else if (event.tool === "apply_patch") {
          this.events.emit("patch.started", {
            paths: event.resources ?? [],
          });
        }
        break;
      case "tool.completed":
        this.events.emit(event.type, {
          tool: event.tool,
          durationMs: event.durationMs,
        });
        if (event.tool === "write_file") {
          this.events.emit("file.write_completed", {
            path: event.resources?.[0] ?? "unknown",
          });
        } else if (event.tool === "apply_patch") {
          this.events.emit("patch.completed", {
            paths: event.resources ?? [],
          });
        }
        break;
      case "tool.failed":
        this.events.emit(event.type, { tool: event.tool, code: event.code });
        if (event.tool === "apply_patch") {
          this.events.emit("patch.failed", {
            paths: event.resources ?? [],
            code: event.code,
          });
        }
        break;
    }
  }
}

function mergeValidationConfig(
  base: ValidationConfig | undefined,
  override: ValidationConfig | undefined,
): ValidationConfig | undefined {
  if (!base && !override) return undefined;
  const merged: ValidationConfig = { ...base, ...override };
  for (const kind of ["typecheck", "lint", "test", "build"] as const) {
    if (base?.[kind] || override?.[kind]) {
      Object.assign(merged, {
        [kind]: { ...base?.[kind], ...override?.[kind] },
      });
    }
  }
  return merged;
}

/**
 * Folds targeted expansion results into a bundle already selected from Planner
 * context. Selection entries win, so expansion only supplies evidence the
 * selection was missing.
 */
function mergeContextFiles(
  base: ContextBundle,
  extra: readonly ContextFile[],
): ContextBundle {
  const seen = new Set(base.files.map((file) => file.path));
  const added = extra.filter((file) => !seen.has(file.path));
  if (added.length === 0) return base;

  const files = [...base.files, ...added];
  const addedBytes = added.reduce(
    (bytes, file) => bytes + Buffer.byteLength(file.content, "utf8"),
    0,
  );
  return {
    workspaceRoot: base.workspaceRoot,
    prompt: base.prompt,
    files,
    git: base.git,
    totalBytes: base.totalBytes + addedBytes,
    estimatedTokens: TOKEN_ESTIMATOR.estimate(
      [base.prompt, base.git.diff.diff, ...files.map((file) => file.content)].join(
        "\n",
      ),
    ),
    truncated: base.truncated || added.some((file) => file.truncated),
  };
}

function errorCode(error: unknown): string {
  return errorCodeOr(error, "executor_error");
}

function canonicalChangedPath(workspaceRoot: string, file: string): string {
  const relative = path.isAbsolute(file) ? path.relative(workspaceRoot, file) : file;
  return path.posix.normalize(relative.replaceAll("\\", "/")).replace(/^\.\//, "");
}
