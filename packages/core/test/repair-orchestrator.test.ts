import { describe, expect, it, vi } from "vitest";
import { EventBus, RepairOrchestrator, type NyxaraEventMap } from "../src/index.js";
import type { Executor } from "../src/executor/executor.js";
import type { ExecutionResult } from "../src/executor/executor.types.js";
import type { AgentModelConfig } from "../src/agents/agent.types.js";
import type { RepairOperations, RepairWorkflowInput } from "../src/repair/repair.types.js";
import {
  contextBundle,
  execution,
  failingReview,
  failingValidation,
  passingReview,
  passingValidation,
  repairTask,
} from "./fixtures/repair-fixtures.js";

const model: AgentModelConfig = {
  role: "executor",
  providerId: "fake",
  modelId: "executor-model",
};

function input(
  overrides: Partial<RepairWorkflowInput> = {},
): RepairWorkflowInput {
  return {
    requirement: "Add pagination metadata",
    objective: "Return totalPages from the notification API",
    originalTask: repairTask(),
    workspaceRoot: "/workspace",
    execution: execution(),
    validation: failingValidation(),
    executorContext: contextBundle(),
    ...overrides,
  };
}

function harness() {
  const events = new EventBus<NyxaraEventMap>();
  const executeRepair = vi.fn<(args: unknown) => Promise<ExecutionResult>>();
  const executor = { executeRepair } as unknown as Executor;
  const operations: RepairOperations = {
    validate: vi.fn(),
    review: vi.fn(),
  };
  const orchestrator = new RepairOrchestrator(
    executor,
    events,
    undefined,
    undefined,
    () => "2026-08-30T00:00:00.000Z",
  );
  return { events, executeRepair, operations, orchestrator };
}

describe("RepairOrchestrator", () => {
  it("repairs validation failures, then validates and reviews successfully", async () => {
    const { executeRepair, operations, orchestrator } = harness();
    executeRepair.mockResolvedValue(execution({ marker: "2" }));
    vi.mocked(operations.validate).mockResolvedValue(passingValidation());
    vi.mocked(operations.review).mockResolvedValue(passingReview());

    const result = await orchestrator.run(input(), model, operations);

    expect(result.status).toBe("passed");
    expect(result.cycles).toBe(1);
    expect(executeRepair).toHaveBeenCalledOnce();
    expect(operations.validate).toHaveBeenCalledOnce();
    expect(operations.review).toHaveBeenCalledOnce();
    expect(result.finalReview?.status).toBe("passed");
  });

  it("never calls Reviewer while deterministic validation is failing", async () => {
    const { executeRepair, operations, orchestrator } = harness();
    executeRepair
      .mockResolvedValueOnce(execution({ marker: "2" }))
      .mockResolvedValueOnce(execution({ marker: "3" }));
    vi.mocked(operations.validate)
      .mockResolvedValueOnce(failingValidation("src/notification.service.ts(42,7): error TS2322: still broken"))
      .mockResolvedValueOnce(passingValidation());
    vi.mocked(operations.review).mockResolvedValue(passingReview());

    const result = await orchestrator.run(
      input({ limits: { maxRepairCycles: 2 } }),
      model,
      operations,
    );

    expect(result.status).toBe("passed");
    expect(executeRepair).toHaveBeenCalledTimes(2);
    expect(operations.review).toHaveBeenCalledOnce();
    expect(operations.review).toHaveBeenCalledAfter(vi.mocked(operations.validate));
  });

  it("repairs a review failure and rereviews the resulting implementation", async () => {
    const { executeRepair, operations, orchestrator } = harness();
    executeRepair.mockResolvedValue(execution({ marker: "2" }));
    vi.mocked(operations.validate).mockResolvedValue(passingValidation());
    vi.mocked(operations.review).mockResolvedValue(passingReview());

    const result = await orchestrator.run(
      input({ validation: passingValidation(), review: failingReview() }),
      model,
      operations,
    );

    expect(result.status).toBe("passed");
    expect(result.cycles).toBe(1);
    expect(executeRepair).toHaveBeenCalledOnce();
    expect(operations.validate).toHaveBeenCalledOnce();
    // Existing review is reused as the failure input; only the rereview is invoked.
    expect(operations.review).toHaveBeenCalledOnce();
  });

  it("stops at the configured cycle limit", async () => {
    const { executeRepair, operations, orchestrator } = harness();
    executeRepair.mockResolvedValue(execution({ marker: "2" }));
    vi.mocked(operations.validate).mockResolvedValue(failingValidation());
    vi.mocked(operations.review).mockResolvedValue(failingReview());

    const result = await orchestrator.run(
      input({ limits: { maxRepairCycles: 1 } }),
      model,
      operations,
    );

    expect(result.status).toBe("limit_reached");
    expect(result.cycles).toBe(1);
    expect(executeRepair).toHaveBeenCalledOnce();
    expect(operations.review).not.toHaveBeenCalled();
  });

  it("detects repeated findings and stalls before wasting another repair", async () => {
    const { executeRepair, operations, orchestrator } = harness();
    executeRepair
      .mockResolvedValueOnce(execution({ marker: "2" }))
      .mockResolvedValueOnce(execution({ marker: "3" }));
    vi.mocked(operations.validate).mockResolvedValue(failingValidation());

    const result = await orchestrator.run(
      input({ limits: { maxRepairCycles: 4, stuckThreshold: 1 } }),
      model,
      operations,
    );

    expect(result.status).toBe("stalled");
    expect(result.cycles).toBe(2);
    expect(executeRepair).toHaveBeenCalledOnce();
    expect(operations.review).not.toHaveBeenCalled();
  });

  it("stalls when Executor reports completion without a relevant change", async () => {
    const { executeRepair, operations, orchestrator } = harness();
    executeRepair.mockResolvedValue(execution({ changedFiles: [] }));

    const result = await orchestrator.run(input(), model, operations);

    expect(result.status).toBe("stalled");
    expect(operations.validate).not.toHaveBeenCalled();
    expect(operations.review).not.toHaveBeenCalled();
  });

  it("returns an aborted result without starting a repair cycle", async () => {
    const { executeRepair, operations, orchestrator } = harness();
    const controller = new AbortController();
    controller.abort();

    const result = await orchestrator.run(
      input({ signal: controller.signal }),
      model,
      operations,
    );

    expect(result.status).toBe("aborted");
    expect(result.cycles).toBe(0);
    expect(executeRepair).not.toHaveBeenCalled();
  });

  it("emits metadata-only repair events and never leaks source, diff, or logs", async () => {
    const { events, executeRepair, operations, orchestrator } = harness();
    executeRepair.mockResolvedValue(execution({ marker: "2" }));
    vi.mocked(operations.validate).mockResolvedValue(passingValidation());
    vi.mocked(operations.review).mockResolvedValue(passingReview());
    const emitted: unknown[] = [];
    for (const event of [
      "repair.started",
      "repair.cycle_started",
      "repair.task_created",
      "repair.execution_started",
      "repair.execution_completed",
      "repair.validation_started",
      "repair.validation_passed",
      "repair.review_started",
      "repair.review_passed",
      "repair.completed",
    ] as const) {
      events.on(event, (payload) => emitted.push(payload));
    }

    await orchestrator.run(input(), model, operations);

    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("totalPages = 1");
    expect(serialized).not.toContain("successful typecheck log");
    expect(serialized).not.toContain("secret");
    expect(emitted.every((payload) => typeof payload === "object")).toBe(true);
  });
});
