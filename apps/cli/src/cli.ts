import {
  type NyxaraOrchestrator,
  type RepairResult,
  type WorkflowRunOutcome,
} from "@nyxara/core";
import type { ModelInfo, ProviderInfo } from "@nyxara/provider-sdk";

export interface CliIO {
  write(message: string): void;
  question(prompt: string): Promise<string>;
}

interface SelectableOption {
  readonly id: string;
  readonly label: string;
}

export async function runCli(
  io: CliIO,
  nyxara: NyxaraOrchestrator,
): Promise<void> {
  const unsubscribe = nyxara.events.on(
    "provider.generation.completed",
    ({ modelId, textLength }) => {
      io.write(`\nResponse received (${modelId}, ${textLength} characters)\n`);
    },
  );

  try {
    io.write("NYXARA ORCHESTRATOR\n\n");

    const provider = await selectProvider(io, nyxara.listProviders());
    const models = await nyxara.listModels(provider.id);
    const model = await selectModel(io, models);
    const prompt = await io.question("Prompt:\n> ");

    const response = await nyxara.generate({
      providerId: provider.id,
      model: model.id,
      prompt,
    });
    io.write(`\nResponse:\n${response.text}\n`);
  } finally {
    unsubscribe();
  }
}

export async function runInspectCli(
  io: CliIO,
  nyxara: NyxaraOrchestrator,
  workspaceRoot: string,
  prompt: string,
): Promise<void> {
  io.write("NYXARA REPOSITORY INSPECT\n\n");
  io.write(`Workspace\n${workspaceRoot}\n\n`);

  const context = await nyxara.inspectRepository({ workspaceRoot, prompt });

  io.write(`Context for:\n\"${prompt}\"\n\n`);
  io.write("Relevant files:\n");
  if (context.files.length === 0) {
    io.write("- No relevant files found\n");
  } else {
    context.files.forEach((file, index) => {
      io.write(`${index + 1}. ${file.path}\n   Reason: ${file.reason}\n`);
    });
  }

  io.write(`\nGit\n${context.git.status.files.length} changed files\n`);
  io.write(
    `\nContext\n${context.files.length} files\n${formatBytes(context.totalBytes)}\n~${context.estimatedTokens} estimated tokens\n`,
  );
  if (context.truncated) {
    io.write("Context was truncated to the configured budget.\n");
  }
}

export async function runPlanCli(
  io: CliIO,
  nyxara: NyxaraOrchestrator,
  workspaceRoot: string,
  prompt: string,
): Promise<void> {
  io.write("NYXARA ORCHESTRATOR\n\n");
  io.write(`Workspace\n${workspaceRoot}\n\n`);

  const provider = await selectProvider(io, nyxara.listProviders());
  const models = await nyxara.listModels(provider.id);
  const model = await selectModel(io, models);
  nyxara.configureAgent({
    role: "planner",
    providerId: provider.id,
    modelId: model.id,
  });
  io.write(`\nPlanner\n${provider.displayName} / ${model.name}\n\n`);

  const unsubscribers = [
    nyxara.events.on("context.completed", ({ fileCount, estimatedTokens }) => {
      io.write(
        `✓ Repository context built (${fileCount} files, ~${estimatedTokens} tokens)\n`,
      );
    }),
    nyxara.events.on("planner.started", () => {
      io.write("● Planner started\n");
    }),
    nyxara.events.on("planner.completed", () => {
      io.write("✓ Plan generated\n✓ Plan created\n");
    }),
  ];

  try {
    const workflow = typeof (nyxara as any).startWorkflow === "function"
      ? nyxara.startWorkflow({ workspace: workspaceRoot, prompt })
      : undefined;
    const result = await nyxara.createPlan({ workspaceRoot, prompt, ...(workflow ? { workflowId: workflow.id } : {}) });
    io.write(`\nObjective\n${result.plan.objective}\n\nTasks\n\n`);
    for (const task of result.plan.tasks) {
      io.write(`${task.id}\n${task.title}\n`);
      if (task.dependencies.length > 0) {
        io.write(`Depends on: ${task.dependencies.join(", ")}\n`);
      }
      io.write("\n");
    }
    if (workflow && typeof (nyxara as any).approvePlan === "function") {
      const decision = (await io.question("[A] Approve & Run\n[R] Reject\n[X] Exit\n> ")).trim().toUpperCase();
      if (decision === "A") {
        nyxara.approvePlan(workflow.id, result.plan.id);
        io.write("✓ Plan approved\n");
        if (typeof (nyxara as any).runApprovedPlan === "function") {
          const execution = await (nyxara as any).runApprovedPlan({ workflowId: workflow.id, planId: result.plan.id });
          io.write(`Workflow ${execution.status.toUpperCase()} (${execution.completedTasks}/${execution.totalTasks})\n`);
        }
      } else if (decision === "R") {
        nyxara.rejectPlan(workflow.id, result.plan.id);
        io.write("✓ Plan rejected\n");
      }
    }
  } finally {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  }
}

/** Interactive approved-plan flow. Core owns every scheduling decision. */
export async function runApprovedPlanCli(
  io: CliIO,
  nyxara: NyxaraOrchestrator,
  workspaceRoot: string,
  prompt: string,
): Promise<void> {
  io.write("NYXARA APPROVE & RUN\n\n");
  for (const role of ["planner", "executor", "reviewer"] as const) {
    io.write(`${role[0]!.toUpperCase()}${role.slice(1)} configuration\n`);
    const provider = await selectProvider(io, nyxara.listProviders());
    const model = await selectModel(io, await nyxara.listModels(provider.id));
    nyxara.configureAgent({ role, providerId: provider.id, modelId: model.id });
  }
  const unsubscribers = [
    nyxara.events.on("workflow.task_selected", ({ taskId, completedCount, total }) => io.write(`● ${taskId} (${completedCount}/${total})\n`)),
    nyxara.events.on("workflow.task_completed", ({ taskId }) => io.write(`✓ ${taskId} completed\n`)),
    nyxara.events.on("workflow.task_failed", ({ taskId, code }) => io.write(`✗ ${taskId}: ${code}\n`)),
    nyxara.events.on("workflow.paused", () => io.write("⏸ Workflow paused\n")),
    nyxara.events.on("workflow.resumed", () => io.write("✓ Workflow resumed\n")),
  ];
  try {
    const workflow = nyxara.startWorkflow({ workspace: workspaceRoot, prompt });
    const planned = await nyxara.createPlan({ workflowId: workflow.id, workspaceRoot, prompt });
    io.write(`\nObjective\n${planned.plan.objective}\n\nTasks\n`);
    for (const task of planned.plan.tasks) io.write(`- ${task.id}: ${task.title}\n`);
    const decision = (await io.question("[A] Approve & Run\n[R] Reject\n[X] Exit\n> " )).trim().toUpperCase();
    if (decision === "R") { nyxara.rejectPlan(workflow.id, planned.plan.id); io.write("✓ Plan rejected\n"); return; }
    if (decision !== "A") return;
    nyxara.approvePlan(workflow.id, planned.plan.id);
    let result: WorkflowRunOutcome = await nyxara.runApprovedPlan({ workflowId: workflow.id, planId: planned.plan.id });
    while (result.status === "waiting_for_permission") {
      io.write(`\nPermission required\n\nCapability:\n${result.permission.capability}\n`);
      if (result.permission.resource) io.write(`\nResource:\n${result.permission.resource}\n`);
      const permissionDecision = (await io.question("\n[A] Allow once\n[D] Deny\n[X] Abort\n> ")).trim().toUpperCase();
      if (permissionDecision === "X") {
        nyxara.abortWorkflow(workflow.id);
        io.write("\nWorkflow ABORTED\n");
        return;
      }
      result = await nyxara.resolveWorkflowPermission({
        workflowId: workflow.id,
        permissionRequestId: result.permission.id,
        decision: permissionDecision === "A" ? "allow" : "deny",
      });
      if (permissionDecision === "A") io.write("✓ Permission granted\n");
    }
    if (result.status === "paused") {
      io.write("Workflow PAUSED\n");
      return;
    }
    io.write(`\nWorkflow ${result.status.toUpperCase()} (${result.completedTasks}/${result.totalTasks})\n`);
    if (result.changedFiles.length) { io.write("Changed files\n"); result.changedFiles.forEach((file) => io.write(`- ${file}\n`)); }
  } finally {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  }
}

/** Runtime controls are intentionally process-local; no daemon/session is implied. */
export async function runRuntimeControlCli(
  io: CliIO,
  nyxara: NyxaraOrchestrator,
  action: "pause" | "resume" | "abort",
  workflowId: string,
): Promise<void> {
  if (!workflowId.trim()) throw new Error("workflowId is required");
  if (action === "pause") {
    const state = nyxara.pauseWorkflow(workflowId);
    io.write(`Workflow ${state.id} ${state.pauseRequested ? "PAUSE REQUESTED" : state.status.toUpperCase()}\n`);
    return;
  }
  if (action === "abort") {
    const state = nyxara.abortWorkflow(workflowId);
    io.write(`Workflow ${state.id} ABORTED\n`);
    return;
  }
  const outcome = await nyxara.resumeWorkflow(workflowId);
  if (outcome.status === "waiting_for_permission") {
    io.write(`Workflow WAITING_FOR_PERMISSION\nPermission request: ${outcome.permission.id}\n`);
  } else if (outcome.status === "paused") {
    io.write(`Workflow PAUSED\n`);
  } else {
    io.write(`Workflow ${outcome.status.toUpperCase()} (${outcome.completedTasks}/${outcome.totalTasks})\n`);
  }
}

export async function runExecuteCli(
  io: CliIO,
  nyxara: NyxaraOrchestrator,
  workspaceRoot: string,
  prompt: string,
): Promise<void> {
  io.write("NYXARA ORCHESTRATOR\n\n");
  io.write(`Workspace\n${workspaceRoot}\n\n`);

  io.write("Planner configuration\n");
  const plannerProvider = await selectProvider(io, nyxara.listProviders());
  const plannerModel = await selectModel(
    io,
    await nyxara.listModels(plannerProvider.id),
  );
  nyxara.configureAgent({
    role: "planner",
    providerId: plannerProvider.id,
    modelId: plannerModel.id,
  });

  io.write("\nExecutor configuration\n");
  const executorProvider = await selectProvider(io, nyxara.listProviders());
  const executorModel = await selectModel(
    io,
    await nyxara.listModels(executorProvider.id),
  );
  nyxara.configureAgent({
    role: "executor",
    providerId: executorProvider.id,
    modelId: executorModel.id,
  });

  let executorActive = false;
  const unsubscribers = [
    nyxara.events.on("planner.completed", () => io.write("✓ Plan created\n")),
    nyxara.events.on("executor.started", () => {
      executorActive = true;
      io.write(
        `\n● Executor\n  Provider: ${executorProvider.displayName}\n  Model: ${executorModel.name}\n`,
      );
    }),
    nyxara.events.on("tool.started", ({ tool }) => {
      if (executorActive) io.write(`  ${tool}\n`);
    }),
    nyxara.events.on("executor.completed", () => {
      executorActive = false;
      io.write("✓ Task completed\n");
    }),
    nyxara.events.on("executor.failed", () => {
      executorActive = false;
    }),
  ];

  try {
    const planned = await nyxara.createPlan({ workspaceRoot, prompt });
    const readyTask = planned.graph.getReadyTasks()[0];
    if (!readyTask) {
      throw new Error("The plan has no ready task to execute");
    }
    io.write(`\nExecuting ${readyTask.id}\n${readyTask.title}\n`);

    const executed = await nyxara.executeTask({
      plan: planned.plan,
      taskId: readyTask.id,
      workspaceRoot,
    });
    io.write("\nChanged files\n");
    if (executed.result.changedFiles.length === 0) {
      io.write("- No repository changes\n");
    } else {
      executed.result.changedFiles.forEach((path) => io.write(`- ${path}\n`));
    }
    io.write(
      `\nGit diff ${executed.result.diff.truncated ? "truncated" : "available"}.\n`,
    );
  } finally {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  }
}

export async function runValidationCli(
  io: CliIO,
  nyxara: NyxaraOrchestrator,
  workspaceRoot: string,
): Promise<void> {
  io.write("NYXARA VALIDATION\n\n");
  io.write(`Workspace\n${workspaceRoot}\n\n`);

  const unsubscribers = [
    nyxara.events.on("validation.step_passed", ({ kind, durationMs }) => {
      io.write(`✓ ${validationLabel(kind)}\n  ${formatDuration(durationMs)}\n\n`);
    }),
    nyxara.events.on("validation.step_failed", ({ kind, durationMs }) => {
      io.write(`✗ ${validationLabel(kind)}\n  ${formatDuration(durationMs)}\n\n`);
    }),
    nyxara.events.on("validation.step_timed_out", ({ kind, durationMs }) => {
      io.write(`✗ ${validationLabel(kind)} (timed out)\n  ${formatDuration(durationMs)}\n\n`);
    }),
    nyxara.events.on("validation.step_skipped", ({ kind, errorCode }) => {
      io.write(`- ${validationLabel(kind)} (skipped${errorCode ? `: ${errorCode}` : ""})\n`);
    }),
  ];

  try {
    const result = await nyxara.validate({ workspaceRoot });
    const failedStep = result.steps.find((step) =>
      ["failed", "timed_out", "errored"].includes(step.status),
    );
    if (failedStep) {
      if (failedStep.command) {
        io.write(`\nCommand\n${failedStep.command.join(" ")}\n`);
      }
      if (failedStep.exitCode !== undefined) {
        io.write(`\nExit code\n${failedStep.exitCode}\n`);
      }
      const output = [failedStep.stdout, failedStep.stderr]
        .filter((value): value is string => Boolean(value))
        .join("\n")
        .trim();
      if (output) {
        io.write(`\nOutput\n${output}\n`);
      }
      if (failedStep.errorCode) {
        io.write(`\nError\n${failedStep.errorCode}\n`);
      }
    }

    io.write(`\nValidation\n${result.status === "passed" ? "PASS" : "FAIL"}\n`);
    io.write(`\nDuration\n${formatDuration(result.durationMs)}\n`);
  } finally {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  }
}

export async function runReviewCli(
  io: CliIO,
  nyxara: NyxaraOrchestrator,
  workspaceRoot: string,
  prompt: string,
): Promise<void> {
  io.write("NYXARA ORCHESTRATOR\n\n");
  io.write(`Workspace\n${workspaceRoot}\n\n`);

  const roles = [] as Array<{
    role: "planner" | "executor" | "reviewer";
    provider: ProviderInfo;
    model: ModelInfo;
  }>;
  for (const role of ["planner", "executor", "reviewer"] as const) {
    io.write(`${validationLabel(role)} configuration\n`);
    const provider = await selectProvider(io, nyxara.listProviders());
    const model = await selectModel(io, await nyxara.listModels(provider.id));
    nyxara.configureAgent({ role, providerId: provider.id, modelId: model.id });
    roles.push({ role, provider, model });
    io.write("\n");
  }
  const reviewerRole = roles.find((entry) => entry.role === "reviewer")!;

  const unsubscribers = [
    nyxara.events.on("planner.completed", () => io.write("✓ Plan created\n")),
    nyxara.events.on("executor.completed", () => io.write("✓ Task executed\n")),
    nyxara.events.on("validation.step_passed", ({ kind }) =>
      io.write(`✓ ${validationLabel(kind)}\n`),
    ),
    nyxara.events.on("reviewer.started", () => {
      io.write(
        `\n● Reviewer\n  Provider: ${reviewerRole.provider.displayName}\n  Model: ${reviewerRole.model.name}\n`,
      );
    }),
    nyxara.events.on("review.context_requested", () => {
      io.write("Additional targeted context required\n");
    }),
    nyxara.events.on("review.context_expanded", ({ fileCount }) => {
      io.write(`✓ Context expanded (${fileCount} files)\n`);
    }),
  ];

  try {
    const planned = await nyxara.createPlan({ workspaceRoot, prompt });
    const task = planned.graph.getReadyTasks()[0];
    if (!task) throw new Error("The plan has no ready task to review");
    const pipeline = await nyxara.runTaskPipeline({
      requirement: prompt,
      plan: planned.plan,
      taskId: task.id,
      workspaceRoot,
      plannerContext: planned.context,
      allowRepair: false,
    });
    if (pipeline.reviewSkipped) {
      io.write("\nValidation\nFAIL\n\nReview skipped: deterministic validation failed.\n");
      return;
    }
    if (!pipeline.review || !pipeline.reviewEvidence) {
      throw new Error("Core task pipeline did not return review evidence");
    }

    io.write("\nReview Evidence\n\n");
    io.write(`Task\n${task.title}\n\n`);
    io.write(`Acceptance Criteria\n${task.acceptanceCriteria.length}\n\n`);
    io.write(`Changed Files\n${pipeline.reviewEvidence.changedFiles.length}\n\n`);
    io.write(`Diff\n${formatBytes(Buffer.byteLength(pipeline.reviewEvidence.diff.content, "utf8"))}\n\n`);
    io.write(
      `Relevant Context\n${pipeline.reviewEvidence.context.length} snippets / ${formatBytes(pipeline.reviewEvidence.context.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0))}\n\n`,
    );
    io.write(`Validation\n${pipeline.validation.status === "passed" ? "PASS" : "FAIL"}\n\n`);
    io.write("Acceptance Criteria\n\n");
    for (const criterion of pipeline.review.criteria) {
      const marker = criterion.status === "satisfied" ? "✓" : "✗";
      io.write(`${marker} ${criterion.criterion}\n`);
    }
    io.write(
      `\nReview\n${pipeline.review.status === "passed" ? "PASS" : "FAIL"}\n`,
    );
  } finally {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  }
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function validationLabel(kind: string): string {
  if (kind === "test") return "Tests";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

async function selectProvider(
  io: CliIO,
  providers: readonly ProviderInfo[],
): Promise<ProviderInfo> {
  const selectedId = await selectOption(
    io,
    "Provider",
    providers.map((provider) => ({
      id: provider.id,
      label: provider.displayName,
    })),
  );

  return providers.find((provider) => provider.id === selectedId)!;
}

async function selectModel(
  io: CliIO,
  models: readonly ModelInfo[],
): Promise<ModelInfo> {
  const selectedId = await selectOption(
    io,
    "Model",
    models.map((model) => ({ id: model.id, label: model.name })),
  );

  return models.find((model) => model.id === selectedId)!;
}

async function selectOption(
  io: CliIO,
  title: string,
  options: readonly SelectableOption[],
): Promise<string> {
  if (options.length === 0) {
    throw new Error(`No ${title.toLowerCase()} options are available`);
  }

  io.write(`${title}:\n`);
  options.forEach((option, index) => {
    io.write(`  ${index + 1}. ${option.label} (${option.id})\n`);
  });

  const answer = (await io.question("> ")).trim();

  if (answer.length === 0) {
    return options[0]!.id;
  }

  const numericIndex = Number(answer) - 1;
  if (Number.isInteger(numericIndex) && options[numericIndex]) {
    return options[numericIndex].id;
  }

  const normalizedAnswer = answer.toLocaleLowerCase();
  const selected = options.find(
    (option) =>
      option.id.toLocaleLowerCase() === normalizedAnswer ||
      option.label.toLocaleLowerCase() === normalizedAnswer,
  );

  if (!selected) {
    throw new Error(`Unknown ${title.toLowerCase()} selection: ${answer}`);
  }

  return selected.id;
}

export async function runRepairCli(
  io: CliIO,
  nyxara: NyxaraOrchestrator,
  workspaceRoot: string,
  prompt: string,
): Promise<void> {
  io.write("NYXARA AUTONOMOUS DEVELOPMENT\n\n");
  io.write("Workspace\n" + workspaceRoot + "\n\n");

  for (const role of ["planner", "executor", "reviewer"] as const) {
    io.write(roleLabel(role) + " configuration\n");
    const provider = await selectProvider(io, nyxara.listProviders());
    const model = await selectModel(io, await nyxara.listModels(provider.id));
    nyxara.configureAgent({ role, providerId: provider.id, modelId: model.id });
    io.write("\n");
  }

  const unsubscribers = [
    nyxara.events.on("planner.completed", () => io.write("✓ Plan created\n")),
    nyxara.events.on("executor.completed", () => io.write("✓ Task executed\n")),
    nyxara.events.on("validation.step_passed", ({ kind }) =>
      io.write("✓ " + validationLabel(kind) + "\n"),
    ),
    nyxara.events.on("validation.step_failed", ({ kind }) =>
      io.write("✗ " + validationLabel(kind) + "\n"),
    ),
    nyxara.events.on("repair.cycle_started", ({ cycle }) =>
      io.write("\n────────────────────\n\nRepair Cycle " + cycle + "\n\n"),
    ),
    nyxara.events.on("repair.task_created", ({ findingCount }) =>
      io.write("● Repair task created (" + (findingCount ?? 0) + " finding(s))\n"),
    ),
    nyxara.events.on("repair.execution_started", () =>
      io.write("● Executor repairing\n"),
    ),
    nyxara.events.on("repair.execution_completed", ({ changedFileCount }) =>
      io.write("✓ Patch applied (" + (changedFileCount ?? 0) + " file(s))\n"),
    ),
    nyxara.events.on("repair.validation_failed", () =>
      io.write("✗ Validation failed; Reviewer skipped\n"),
    ),
    nyxara.events.on("repair.validation_passed", () =>
      io.write("✓ Validation passed\n"),
    ),
    nyxara.events.on("repair.review_started", () => io.write("● Reviewer\n")),
    nyxara.events.on("repair.review_passed", () =>
      io.write("✓ Acceptance criteria satisfied\n"),
    ),
    nyxara.events.on("repair.review_failed", ({ findingCount }) =>
      io.write("✗ Review failed (" + (findingCount ?? 0) + " finding(s))\n"),
    ),
    nyxara.events.on("repair.stalled", ({ reason }) =>
      io.write("✗ Repair stalled (" + (reason ?? "unknown") + ")\n"),
    ),
    nyxara.events.on("repair.limit_reached", () =>
      io.write("✗ Repair limit reached\n"),
    ),
  ];

  try {
    const planned = await nyxara.createPlan({ workspaceRoot, prompt });
    const task = planned.graph.getReadyTasks()[0];
    if (!task) throw new Error("The plan has no ready task to execute");

    const pipeline = await nyxara.runTaskPipeline({
      requirement: prompt,
      plan: planned.plan,
      taskId: task.id,
      workspaceRoot,
      plannerContext: planned.context,
      allowRepair: true,
    });

    if (pipeline.review) {
      io.write(
        pipeline.review.status === "passed"
          ? "✓ Review passed\n"
          : "✗ Review failed\n",
      );
      for (const finding of pipeline.review.findings) {
        io.write("\nFinding\n" + finding.message + "\n");
      }
    }

    if (!pipeline.repair) {
      io.write(`\nWorkflow\n${pipeline.status === "passed" ? "PASS" : "FAIL"}\n`);
      return;
    }

    const repaired = pipeline.repair;

    io.write("\nRepair Cycles\n" + repaired.cycles + "\n");
    io.write("Executor attempts\n" + repaired.executorAttempts + "\n");
    io.write("\nChanged files\n");
    if (repaired.changedFiles.length === 0) {
      io.write("- No repository changes\n");
    } else {
      for (const path of repaired.changedFiles) io.write("- " + path + "\n");
    }
    if (repaired.remainingFindings?.length) {
      io.write("\nRemaining findings\n");
      for (const finding of repaired.remainingFindings) {
        io.write("- [" + finding.source + "] " + finding.message + "\n");
      }
    }
    io.write("\nRepair\n" + repairVerdict(repaired.status) + "\n");
  } finally {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  }
}

function repairVerdict(status: RepairResult["status"]): string {
  if (status === "passed") return "PASS";
  if (status === "limit_reached") return "LIMIT REACHED";
  if (status === "stalled") return "STALLED";
  if (status === "aborted") return "ABORTED";
  return "FAIL";
}

function roleLabel(role: "planner" | "executor" | "reviewer"): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
