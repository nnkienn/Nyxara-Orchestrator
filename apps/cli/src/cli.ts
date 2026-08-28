import {
  type NyxaraOrchestrator,
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
    ({ response }) => {
      io.write(`\nResponse:\n${response.text}\n`);
    },
  );

  try {
    io.write("NYXARA ORCHESTRATOR\n\n");

    const provider = await selectProvider(io, nyxara.listProviders());
    const models = await nyxara.listModels(provider.id);
    const model = await selectModel(io, models);
    const prompt = await io.question("Prompt:\n> ");

    await nyxara.generate({
      providerId: provider.id,
      model: model.id,
      prompt,
    });
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
      io.write("✓ Plan created\n");
    }),
  ];

  try {
    const result = await nyxara.createPlan({ workspaceRoot, prompt });
    io.write(`\nObjective\n${result.plan.objective}\n\nTasks\n\n`);
    for (const task of result.plan.tasks) {
      io.write(`${task.id}\n${task.title}\n`);
      if (task.dependencies.length > 0) {
        io.write(`Depends on: ${task.dependencies.join(", ")}\n`);
      }
      io.write("\n");
    }
  } finally {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
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
    const executed = await nyxara.executeTask({
      plan: planned.plan,
      taskId: task.id,
      workspaceRoot,
    });
    const validation = await nyxara.validate({
      workspaceRoot,
      planId: planned.plan.id,
      taskId: task.id,
    });
    if (validation.status === "failed") {
      io.write("\nValidation\nFAIL\n\nReview skipped: deterministic validation failed.\n");
      return;
    }
    const reviewed = await nyxara.reviewTask({
      requirement: prompt,
      objective: planned.plan.objective,
      task,
      execution: executed.result,
      validation,
      executorContext: executed.context,
      plannerContext: planned.context,
    });

    io.write("\nReview Evidence\n\n");
    io.write(`Task\n${task.title}\n\n`);
    io.write(`Acceptance Criteria\n${task.acceptanceCriteria.length}\n\n`);
    io.write(`Changed Files\n${reviewed.evidence.changedFiles.length}\n\n`);
    io.write(`Diff\n${formatBytes(Buffer.byteLength(reviewed.evidence.diff.content, "utf8"))}\n\n`);
    io.write(
      `Relevant Context\n${reviewed.evidence.context.length} snippets / ${formatBytes(reviewed.evidence.context.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0))}\n\n`,
    );
    io.write(`Validation\n${validation.status === "passed" ? "PASS" : "FAIL"}\n\n`);
    io.write("Acceptance Criteria\n\n");
    for (const criterion of reviewed.result.criteria) {
      const marker = criterion.status === "satisfied" ? "✓" : "✗";
      io.write(`${marker} ${criterion.criterion}\n`);
    }
    io.write(
      `\nReview\n${reviewed.result.status === "passed" ? "PASS" : "FAIL"}\n`,
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
