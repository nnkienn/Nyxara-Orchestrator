import type {
  GenerateResponse,
  ModelInfo,
  ModelProvider,
  ProviderInfo,
} from "@nyxara/provider-sdk";
import type { WorkflowState } from "@nyxara/shared";
import {
  createDefaultToolRegistry,
  type ToolContext,
  type ToolRegistry,
  type ToolRegistryEvent,
} from "@nyxara/tools";
import {
  AgentModelConfigError,
  AgentModelRegistry,
} from "../agents/agent-model-registry.js";
import type { AgentModelConfig, AgentRole } from "../agents/agent.types.js";
import { ContextEngine } from "../context/context-engine.js";
import type {
  BuildContextInput,
  ContextBundle,
} from "../context/context.types.js";
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
import { PlanValidator } from "../planner/plan-validator.js";
import { TaskGraph } from "../planner/task-graph.js";
import type {
  CreatePlanInput,
  ExecutionPlan,
  PlanResult,
  PlannedTask,
} from "../planner/planner.types.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
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
  RunInput,
} from "./orchestrator.types.js";

export class NyxaraOrchestrator {
  readonly events = new EventBus<NyxaraEventMap>();

  private readonly workflowEngine = new WorkflowEngine(this.events);
  private readonly providerRegistry = new ProviderRegistry();
  private readonly agentModels: AgentModelRegistry;
  private readonly toolRegistry: ToolRegistry;
  private readonly contextEngine: ContextEngine;
  private readonly planner: Planner;
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

  constructor(config: NyxaraOrchestratorConfig = {}) {
    this.toolRegistry =
      config.toolRegistry ??
      createDefaultToolRegistry({
        observer: (event) => this.emitToolRegistryEvent(event),
      });
    this.contextEngine = new ContextEngine(this.toolRegistry, this.events);
    this.agentModels = new AgentModelRegistry(config.agents ?? []);
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

    for (const provider of config.providers ?? []) {
      this.registerProvider(provider);
    }
  }

  async run(input: RunInput): Promise<WorkflowState> {
    return this.workflowEngine.run(input);
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
        response,
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

  async createPlan(input: CreatePlanInput): Promise<PlanResult> {
    const model = this.agentModels.get("planner");
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
    });

    return { plan, context, model, graph: new TaskGraph(plan) };
  }

  getTaskExecutionStates(
    plan: ExecutionPlan,
  ): TaskExecutionState[] {
    return this.taskExecutions.list(plan);
  }

  async executeTask(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
    const plan = new PlanValidator().validate(input.plan);
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
      const context = await this.contextEngine.build({
        workspaceRoot: input.workspaceRoot,
        prompt: taskContextQuery(started.task),
        ...(input.contextBudget ? { budget: input.contextBudget } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const result = await this.executor.run({
        input: {
          task: started.task,
          objective: plan.objective,
          workspaceRoot: input.workspaceRoot,
          context,
          attempt: started.state.attempts,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        model,
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
      return { result, state, context, model };
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
    };
    const reviewed = await this.reviewer.run({
      input: reviewerInput,
      model,
      limits,
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
    });
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
      validate: (request) =>
        this.validate({
          workspaceRoot: request.workspaceRoot,
          taskId: request.taskId,
          planId: plan.id,
          ...(request.config ? { config: request.config } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        }),
      review: async (request) => {
        const reviewed = await this.reviewTask({
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
    return this.repairOrchestrator.run(
      {
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
      },
      model,
      operations,
    );
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

function taskContextQuery(
  task: PlannedTask,
): string {
  return [
    ...(task.relevantFiles ?? []),
    task.title,
    task.description,
    ...task.acceptanceCriteria,
  ].join("\n");
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "executor_error";
}
