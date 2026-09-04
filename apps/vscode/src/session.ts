import {
  NyxaraOrchestrator,
  type AutonomousWorkflowResult,
  type ExecutionPlan,
  type PlanResult,
  type WorkflowRunOutcome,
  type WorkflowSnapshot,
} from "@nyxara/core";
import { OpenAICompatibleProvider } from "@nyxara/providers";
import type { AgentRole } from "@nyxara/core";
import { VSCodeCredentialStore } from "./credentials.js";
import { createProvider, type ProviderConfig } from "./provider-config.js";

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

  constructor(private readonly context: { secrets: any }, private readonly output: { appendLine(value: string): void }, providers: string | readonly ProviderConfig[] = "https://api.openai.com/v1", injectedCore?: NyxaraOrchestrator) {
    const configuredProviders = typeof providers === "string"
      ? [new OpenAICompatibleProvider({ baseUrl: providers, credentialStore: new VSCodeCredentialStore(context.secrets) })]
      : providers.map((config) => createProvider(config, context.secrets));
    this.core = injectedCore ?? new NyxaraOrchestrator({ providers: configuredProviders });
    this.core.events.on("workflow.status_changed", (event: any) => this.log(`workflow ${event.workflowId}: ${event.to}`));
    this.core.events.on("workflow.completed", (event: any) => this.log(`workflow ${event.workflowId}: completed`));
    this.core.events.on("workflow.failed", (event: any) => this.log(`workflow ${event.workflowId}: failed (${event.code})`));
    this.core.events.on("workflow.aborted", (event: any) => this.log(`workflow ${event.workflowId}: aborted`));
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

  configureAgents(settings: (key: string) => string, availableProviderIds?: ReadonlySet<string>): void {
    const roles: AgentRole[] = ["planner", "executor", "reviewer"];
    let configuredRoles = 0;
    for (const role of roles) {
      const providerId = settings(`nyxara.${role}.provider`);
      const modelId = settings(`nyxara.${role}.model`);
      if (providerId && modelId && (!availableProviderIds || availableProviderIds.has(providerId))) {
        this.core.configureAgent({ role, providerId, modelId });
        configuredRoles += 1;
      }
    }
    this.configured = configuredRoles === roles.length;
  }

  async generate(prompt: string, workspaceRoot: string, profileId: string): Promise<PlanResult> {
    const workflow = this.core.startWorkflow({ workspace: workspaceRoot, prompt });
    this.workflowId = workflow.id;
    this.prompt = prompt;
    this.onChange?.();
    this.plan = await this.core.createPlan({ workspaceRoot, prompt, workflowId: workflow.id, ...(profileId ? { planningProfileId: profileId } : {}) });
    this.refresh();
    return this.plan;
  }

  async regenerate(prompt: string, workspaceRoot: string, profileId: string): Promise<PlanResult> {
    if (!this.workflowId) return this.generate(prompt, workspaceRoot, profileId);
    this.prompt = prompt;
    this.plan = await this.core.createPlan({ workspaceRoot, prompt, workflowId: this.workflowId, ...(profileId ? { planningProfileId: profileId } : {}) });
    this.refresh();
    return this.plan;
  }

  async approveAndRun(): Promise<WorkflowRunOutcome> {
    if (!this.workflowId || !this.plan) throw new Error("Generate a plan first");
    this.core.approvePlan(this.workflowId, this.plan.plan.id);
    const outcome = await this.core.runApprovedPlan({ workflowId: this.workflowId, planId: this.plan.plan.id });
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
  abort(): void { if (this.workflowId) this.core.abortWorkflow(this.workflowId); this.refresh(); this.onChange?.(); }
  resolvePermission(id: string, decision: "allow" | "deny"): Promise<WorkflowRunOutcome> {
    if (!this.workflowId) throw new Error("No workflow");
    return this.core.resolveWorkflowPermission({ workflowId: this.workflowId, permissionRequestId: id, decision }).then((outcome) => { if ("workflowId" in outcome && (outcome.status === "completed" || outcome.status === "failed" || outcome.status === "aborted")) this.result = outcome; this.refresh(); this.onChange?.(); return outcome; });
  }
  get snapshot(): WorkflowSnapshot | undefined { return this.workflowId ? this.core.getWorkflowSnapshot(this.workflowId) : undefined; }
  get currentPlan(): ExecutionPlan | undefined { return this.plan?.plan; }
  resetPresentation(): void {
    const active = this.snapshot?.status;
    if (active && !["completed", "failed", "aborted"].includes(active)) throw new Error("Finish or abort the active workflow before starting a new task.");
    delete this.plan; delete this.workflowId; delete this.prompt; delete this.result; this.validation.clear(); this.validationDurations.clear(); delete this.reviewStatus; delete this.reviewFindingCount; delete this.repairCycle; this.snapshots.clear(); this.onChange?.();
  }
}
