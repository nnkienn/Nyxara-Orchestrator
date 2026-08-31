import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  GenerateRequest,
  GenerateResponse,
  ModelProvider,
} from "@nyxara/provider-sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { NyxaraOrchestrator, type ValidationResult } from "@nyxara/core";

const execFileAsync = promisify(execFile);
const modelInfo = {
  id: "audit-model",
  name: "Audit Model",
  provider: "fake",
  capabilities: { text: true, tools: true, structuredOutput: true },
};

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "nyxara-audit-fixture-"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "package.json"),
    JSON.stringify(
      {
        name: "audit-fixture",
        private: true,
        packageManager: "npm@10.9.8",
        type: "module",
        scripts: {
          typecheck: "node --check src/notifications.js",
          lint: "node --check src/notifications.js",
          test: "node --test src/notifications.js",
          build: "node --check src/notifications.js",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(workspace, "src", "notifications.js"),
    "export const notifications = [];\n",
  );
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "audit@nyxara.local"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["config", "user.name", "Nyxara Audit"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace });
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

it("runs the real Phase 1-7 pipeline on a temporary Git repository", async () => {
  let reviewCalls = 0;
  let repairCalls = 0;

  const provider: ModelProvider = {
    id: "fake",
    displayName: "Fake Audit Provider",
    capabilities: () => ({
      modelDiscovery: true,
      textGeneration: true,
      toolCalling: true,
      structuredOutput: true,
    }),
    listModels: async () => [modelInfo],
    generate: async (request: GenerateRequest): Promise<GenerateResponse> => {
      const base = { provider: "fake", model: modelInfo.id };
      if (request.prompt.includes("You are the Planner role")) {
        return {
          ...base,
          text: JSON.stringify({
            objective: "Add pagination metadata to the notification API",
            tasks: [
              {
                id: "T1",
                title: "Add pagination metadata",
                description: "Return page, limit, and total metadata.",
                dependencies: [],
                acceptanceCriteria: [
                  "Notification API exposes pagination metadata",
                ],
                relevantFiles: ["src/notifications.js"],
              },
            ],
          }),
        };
      }

      if (request.prompt.includes("You are the Reviewer role")) {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            ...base,
            text: JSON.stringify({
              status: "failed",
              summary: "Total page metadata is missing.",
              findings: [
                {
                  severity: "warning",
                  category: "requirement",
                  message: "pagination is missing totalPages metadata",
                  file: "src/notifications.js",
                },
              ],
              criteria: [
                {
                  criterion: "Notification API exposes pagination metadata",
                  status: "unsatisfied",
                  reason: "totalPages is absent from the diff",
                },
              ],
            }),
          };
        }
        return {
          ...base,
          text: JSON.stringify({
            status: "passed",
            summary: "Pagination metadata including totalPages is present.",
            findings: [],
            criteria: [
              {
                criterion: "Notification API exposes pagination metadata",
                status: "satisfied",
                reason: "The diff adds page, limit, and totalPages",
              },
            ],
          }),
        };
      }

      const repairing = request.prompt.includes(
        "You are repairing an existing implementation.",
      );
      if (repairing && !request.conversation) repairCalls += 1;
      if (!request.conversation) {
        return {
          ...base,
          text: "",
          toolCalls: [
            {
              id: repairing ? "repair-write-1" : "write-1",
              name: "write_file",
              arguments: {
                path: "src/notifications.js",
                content: repairing
                  ? "export const notifications = [];\nexport const pagination = { page: 1, limit: 20, totalPages: 1 };\n"
                  : "export const notifications = [];\nexport const pagination = { page: 1, limit: 20 };\n",
              },
            },
          ],
        };
      }
      return {
        ...base,
        text: JSON.stringify({
          status: "completed",
          summary: repairing
            ? "Added totalPages metadata"
            : "Added pagination metadata",
        }),
      };
    },
  };

  const nyxara = new NyxaraOrchestrator({
    providers: [provider],
    agents: [
      { role: "planner", providerId: "fake", modelId: modelInfo.id },
      { role: "executor", providerId: "fake", modelId: modelInfo.id },
      { role: "reviewer", providerId: "fake", modelId: modelInfo.id },
    ],
  });
  const generationEvents: unknown[] = [];
  nyxara.events.on("provider.generation.completed", (payload) => {
    generationEvents.push(payload);
  });

  const requirement = "Add pagination to notification API";
  const planned = await nyxara.createPlan({
    workspaceRoot: workspace,
    prompt: requirement,
  });
  const task = planned.plan.tasks[0]!;
  expect(planned.graph.getReadyTasks().map((ready) => ready.id)).toEqual(["T1"]);

  const executed = await nyxara.executeTask({
    plan: planned.plan,
    taskId: task.id,
    workspaceRoot: workspace,
  });
  expect(executed.result.status).toBe("completed");
  expect(executed.result.changedFiles).toEqual(["src/notifications.js"]);

  const validation: ValidationResult = await nyxara.validate({
    workspaceRoot: workspace,
    planId: planned.plan.id,
    taskId: task.id,
  });
  expect(validation.status).toBe("passed");

  const reviewed = await nyxara.reviewTask({
    requirement,
    objective: planned.plan.objective,
    task,
    execution: executed.result,
    validation,
    executorContext: executed.context,
    plannerContext: planned.context,
  });
  expect(reviewed.result.status).toBe("failed");

  // Deterministic authority: a Reviewer PASS cannot override validation FAIL.
  const failedValidation: ValidationResult = {
    ...validation,
    status: "failed",
    errorCode: "validation_failed",
    steps: validation.steps.map((step, index) =>
      index === 0
        ? {
            ...step,
            status: "failed" as const,
            exitCode: 1,
            stderr: "audit-injected deterministic failure",
          }
        : step,
    ),
  };
  const overridden = await nyxara.reviewTask({
    requirement,
    objective: planned.plan.objective,
    task,
    execution: executed.result,
    validation: failedValidation,
    executorContext: executed.context,
    plannerContext: planned.context,
  });
  expect(overridden.result.status).toBe("failed");
  expect(
    overridden.result.findings.some((finding) =>
      finding.message.includes("Deterministic validation failed"),
    ),
  ).toBe(true);

  const repaired = await nyxara.repairTask({
    requirement,
    objective: planned.plan.objective,
    plan: planned.plan,
    taskId: task.id,
    workspaceRoot: workspace,
    execution: executed.result,
    validation,
    review: reviewed.result,
    executorContext: executed.context,
    plannerContext: planned.context,
  });

  expect(repaired.status).toBe("passed");
  expect(repaired.cycles).toBe(1);
  expect(repaired.finalValidation?.status).toBe("passed");
  expect(repaired.finalReview?.status).toBe("passed");
  expect(repaired.changedFiles).toContain("src/notifications.js");
  expect(repairCalls).toBe(1);
  const serializedGenerationEvents = JSON.stringify(generationEvents);
  expect(serializedGenerationEvents).not.toContain("export const notifications");
  expect(serializedGenerationEvents).not.toContain("totalPages");
  expect(generationEvents).toHaveLength(4);
}, 120_000);
