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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NyxaraOrchestrator,
  type ContextBundle,
  type ExecutionPlan,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const modelId = "pipeline-model";

function plan(): ExecutionPlan {
  return {
    id: crypto.randomUUID(),
    objective: "Implement the bounded feature",
    tasks: [
      {
        id: "T1",
        title: "Implement the feature",
        description: "Update the feature module.",
        dependencies: [],
        acceptanceCriteria: ["The feature exports a valid value"],
        relevantFiles: ["src/feature.js"],
      },
    ],
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function response(overrides: Partial<GenerateResponse>): GenerateResponse {
  return {
    provider: "fake",
    model: modelId,
    text: "",
    ...overrides,
  };
}

function provider(
  generate: (request: GenerateRequest) => Promise<GenerateResponse>,
): ModelProvider {
  return {
    id: "fake",
    displayName: "Fake Pipeline Provider",
    capabilities: () => ({
      modelDiscovery: true,
      textGeneration: true,
      toolCalling: true,
      structuredOutput: true,
    }),
    listModels: async () => [
      {
        id: modelId,
        name: "Pipeline Model",
        provider: "fake",
        capabilities: { text: true, tools: true, structuredOutput: true },
      },
    ],
    generate,
  };
}

function orchestrator(modelProvider: ModelProvider): NyxaraOrchestrator {
  return new NyxaraOrchestrator({
    providers: [modelProvider],
    agents: [
      { role: "executor", providerId: "fake", modelId },
      { role: "reviewer", providerId: "fake", modelId },
    ],
    repairLimits: {
      maxRepairCycles: 2,
      maxExecutorAttemptsPerCycle: 1,
    },
  });
}

function reviewResponse(status: "passed" | "failed"): GenerateResponse {
  return response({
    text: JSON.stringify({
      status,
      summary: status === "passed" ? "Feature is correct" : "Feature is incomplete",
      findings:
        status === "passed"
          ? []
          : [
              {
                severity: "warning",
                category: "requirement",
                message: "The expected final value is absent",
                file: "src/feature.js",
              },
            ],
      criteria: [
        {
          criterion: "The feature exports a valid value",
          status: status === "passed" ? "satisfied" : "unsatisfied",
          reason: status === "passed" ? "Valid exported value is present" : "Expected value is absent",
        },
      ],
    }),
  });
}

async function executorTurn(
  request: GenerateRequest,
  initialContent: string,
  repairContent: string,
): Promise<GenerateResponse> {
  const repairing = request.prompt.includes(
    "You are repairing an existing implementation.",
  );
  if (!request.conversation) {
    return response({
      toolCalls: [
        {
          id: repairing ? "repair-write" : "initial-write",
          name: "write_file",
          arguments: {
            path: "src/feature.js",
            content: repairing ? repairContent : initialContent,
          },
        },
      ],
    });
  }
  return response({
    text: JSON.stringify({
      status: "completed",
      summary: repairing ? "Repaired feature" : "Implemented feature",
    }),
  });
}

describe("Core runTaskPipeline end to end", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-pipeline-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify(
        {
          name: "pipeline-fixture",
          private: true,
          packageManager: "npm@10.9.8",
          type: "module",
          scripts: { typecheck: "node --check src/feature.js" },
        },
        null,
        2,
      ),
    );
    await writeFile(join(workspace, "src", "feature.js"), "export const value = 0;\n");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "pipeline@nyxara.local"], {
      cwd: workspace,
    });
    await execFileAsync("git", ["config", "user.name", "Nyxara Pipeline"], {
      cwd: workspace,
    });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: workspace });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  async function context(nyxara: NyxaraOrchestrator): Promise<ContextBundle> {
    return nyxara.inspectRepository({
      workspaceRoot: workspace,
      prompt: "Implement the feature in src/feature.js",
    });
  }

  it("executes, validates and reviews a passing task", async () => {
    let reviewerCalls = 0;
    const nyxara = orchestrator(
      provider(async (request) => {
        if (request.prompt.includes("You are the Reviewer role")) {
          reviewerCalls += 1;
          return reviewResponse("passed");
        }
        return executorTurn(
          request,
          "export const value = 1;\n",
          "export const value = 2;\n",
        );
      }),
    );
    const executionPlan = plan();
    const result = await nyxara.runTaskPipeline({
      requirement: "Implement the feature",
      plan: executionPlan,
      taskId: "T1",
      workspaceRoot: workspace,
      plannerContext: await context(nyxara),
      allowRepair: true,
    });

    expect(result.status).toBe("passed");
    expect(result.validation.status).toBe("passed");
    expect(result.review?.status).toBe("passed");
    expect(result.repair).toBeUndefined();
    expect(result.reviewSkipped).toBe(false);
    expect(reviewerCalls).toBe(1);
  });

  it("skips Reviewer on validation failure, repairs, then validates and reviews", async () => {
    let reviewerCalls = 0;
    let repairCalls = 0;
    const nyxara = orchestrator(
      provider(async (request) => {
        if (request.prompt.includes("You are the Reviewer role")) {
          reviewerCalls += 1;
          return reviewResponse("passed");
        }
        if (
          request.prompt.includes("You are repairing an existing implementation.") &&
          !request.conversation
        ) {
          repairCalls += 1;
          // Reviewer has not run before the repair starts.
          expect(reviewerCalls).toBe(0);
        }
        return executorTurn(
          request,
          "export const value = ;\n",
          "export const value = 2;\n",
        );
      }),
    );
    const result = await nyxara.runTaskPipeline({
      requirement: "Implement the feature",
      plan: plan(),
      taskId: "T1",
      workspaceRoot: workspace,
      plannerContext: await context(nyxara),
      allowRepair: true,
    });

    expect(result.status).toBe("passed");
    expect(result.reviewSkipped).toBe(true);
    expect(result.repair?.status).toBe("passed");
    expect(result.validation.status).toBe("passed");
    expect(result.review?.status).toBe("passed");
    expect(repairCalls).toBe(1);
    expect(reviewerCalls).toBe(1);
  });

  it("emits metadata-only events with no prompt, source, diff or logs", async () => {
    const nyxara = orchestrator(
      provider(async (request) => {
        if (request.prompt.includes("You are the Reviewer role")) {
          return reviewResponse("passed");
        }
        return executorTurn(
          request,
          "export const SECRET_MARKER_VALUE = 1;\n",
          "export const SECRET_MARKER_VALUE = 2;\n",
        );
      }),
    );

    const captured: Array<{ name: string; payload: unknown }> = [];
    const names = [
      "provider.generation.completed",
      "context.completed",
      "executor.started",
      "executor.completed",
      "task.execution_started",
      "task.execution_completed",
      "validation.completed",
      "reviewer.started",
      "reviewer.completed",
      "workflow.status_changed",
    ] as const;
    for (const name of names) {
      nyxara.events.on(name, (payload) =>
        captured.push({ name, payload }),
      );
    }

    const plannerContext = await context(nyxara);
    const executionPlan = plan();

    const result = await nyxara.runTaskPipeline({
      requirement: "Implement the feature",
      plan: executionPlan,
      taskId: "T1",
      workspaceRoot: workspace,
      plannerContext,
      allowRepair: false,
    });

    expect(result.status).toBe("passed");
    expect(captured.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(captured);
    for (const forbidden of [
      "SECRET_MARKER_VALUE",
      "You are the Reviewer role",
      "diff --git",
      "export const",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    // The provider event keeps only a length, never the generated text.
    const generation = captured.filter(
      (entry) => entry.name === "provider.generation.completed",
    );
    for (const entry of generation) {
      expect(entry.payload).not.toHaveProperty("text");
      expect(entry.payload).toHaveProperty("textLength");
      expect(entry.payload).toMatchObject({
        providerId: "fake",
        providerConfigId: "fake",
        requestedModelId: modelId,
        modelId,
        executionProfileSummary: { kind: "provider_default" },
      });
    }
  });

  it("drives Core workflow status and exposes a bounded snapshot", async () => {
    const nyxara = new NyxaraOrchestrator({
      providers: [
        provider(async (request) => {
          if (request.prompt.includes("You are the Planner role")) {
            return response({
              text: JSON.stringify({
                objective: "Implement the bounded feature",
                tasks: [
                  {
                    id: "T1",
                    title: "Implement the feature",
                    description: "Update the feature module.",
                    dependencies: [],
                    acceptanceCriteria: ["The feature exports a valid value"],
                    relevantFiles: ["src/feature.js"],
                  },
                ],
              }),
            });
          }
          if (request.prompt.includes("You are the Reviewer role")) {
            return reviewResponse("passed");
          }
          return executorTurn(
            request,
            "export const value = 1;\n",
            "export const value = 2;\n",
          );
        }),
      ],
      agents: [
        { role: "planner", providerId: "fake", modelId },
        { role: "executor", providerId: "fake", modelId },
        { role: "reviewer", providerId: "fake", modelId },
      ],
    });
    const statuses: string[] = [];
    nyxara.events.on("workflow.status_changed", ({ to }) => statuses.push(to));

    const workflow = nyxara.startWorkflow({
      workspace,
      prompt: "Implement the feature",
    });
    // Planning is owned by Core and recorded against the workflow.
    const planned = await nyxara.createPlan({
      workspaceRoot: workspace,
      prompt: "Implement the feature in src/feature.js",
      workflowId: workflow.id,
    });
    nyxara.approvePlan(workflow.id, planned.plan.id);

    const result = await nyxara.runTaskPipeline({
      workflowId: workflow.id,
      requirement: "Implement the feature",
      plan: planned.plan,
      taskId: "T1",
      workspaceRoot: workspace,
      plannerContext: planned.context,
      allowRepair: false,
    });
    expect(result.status).toBe("passed");

    // Core is the only component that moved workflow state.
    expect(statuses).toEqual([
      "planning",
      "awaiting_plan_approval",
      "approved",
      "executing",
      "validating",
      "reviewing",
    ]);

    const snapshot = nyxara.getWorkflowSnapshot(workflow.id);
    expect(snapshot.workflowId).toBe(workflow.id);
    expect(snapshot.planId).toBe(planned.plan.id);
    expect(snapshot.currentTaskId).toBe("T1");
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      taskId: "T1",
      executionStatus: "completed",
      validationStatus: "passed",
      reviewStatus: "passed",
    });

    // The snapshot stays a summary: no diff, source, or validation output.
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ["diff --git", "export const", "stdout", "stderr"]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(nyxara.completeWorkflow(workflow.id).status).toBe("completed");
  });

  it("repairs after Reviewer failure, then validates before reviewing again", async () => {
    let reviewerCalls = 0;
    let repairCalls = 0;
    const order: string[] = [];
    const nyxara = orchestrator(
      provider(async (request) => {
        if (request.prompt.includes("You are the Reviewer role")) {
          reviewerCalls += 1;
          order.push("review-" + reviewerCalls);
          return reviewResponse(reviewerCalls === 1 ? "failed" : "passed");
        }
        if (
          request.prompt.includes("You are repairing an existing implementation.") &&
          !request.conversation
        ) {
          repairCalls += 1;
          order.push("repair");
        }
        return executorTurn(
          request,
          "export const value = 1;\n",
          "export const value = 2;\n",
        );
      }),
    );
    nyxara.events.on("repair.validation_passed", () => order.push("validation"));

    const result = await nyxara.runTaskPipeline({
      requirement: "Implement the feature",
      plan: plan(),
      taskId: "T1",
      workspaceRoot: workspace,
      plannerContext: await context(nyxara),
      allowRepair: true,
    });

    expect(result.status).toBe("passed");
    expect(result.repair?.status).toBe("passed");
    expect(result.review?.status).toBe("passed");
    expect(repairCalls).toBe(1);
    expect(reviewerCalls).toBe(2);
    expect(order).toEqual(["review-1", "repair", "validation", "review-2"]);
  });
});
