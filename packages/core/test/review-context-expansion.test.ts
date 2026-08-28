import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GenerateRequest,
  ModelProvider,
} from "@nyxara/provider-sdk";
import { createDefaultToolRegistry } from "@nyxara/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextEngine,
  EventBus,
  NyxaraOrchestrator,
  type ContextBundle,
  type NyxaraEventMap,
} from "../src/index.js";
import {
  execution,
  passingValidation,
  task,
} from "./fixtures/review-fixtures.js";

describe("targeted review context expansion", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nyxara-review-context-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "src", "notification.mapper.ts"),
      "export function mapPaginationMetadata() { return { totalPages: 4 }; }\n",
    );
    await writeFile(
      join(workspace, "src", "unrelated.ts"),
      "export const unrelated = true;\n",
    );
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("reads an exact path and searches an exact symbol through ContextEngine", async () => {
    const engine = new ContextEngine(
      createDefaultToolRegistry(),
      new EventBus<NyxaraEventMap>(),
    );

    const byPath = await engine.expandTargeted({
      workspaceRoot: workspace,
      paths: ["src/notification.mapper.ts"],
      budget: { maxFiles: 1, maxBytes: 1024, maxBytesPerFile: 1024 },
    });
    const bySymbol = await engine.expandTargeted({
      workspaceRoot: workspace,
      symbols: ["mapPaginationMetadata"],
      budget: { maxFiles: 1, maxBytes: 1024, maxBytesPerFile: 1024 },
    });

    expect(byPath.files).toHaveLength(1);
    expect(byPath.files[0]).toMatchObject({
      path: "src/notification.mapper.ts",
      content: expect.stringContaining("totalPages"),
    });
    expect(bySymbol.files[0]).toMatchObject({
      path: "src/notification.mapper.ts",
      reason: expect.stringContaining("mapPaginationMetadata"),
    });
    expect(byPath.files.some((file) => file.path === "src/unrelated.ts")).toBe(false);
  });

  it("keeps workspace traversal protection for targeted reads", async () => {
    const engine = new ContextEngine(
      createDefaultToolRegistry(),
      new EventBus<NyxaraEventMap>(),
    );

    await expect(
      engine.expandTargeted({
        workspaceRoot: workspace,
        paths: ["../../secret"],
      }),
    ).rejects.toMatchObject({ code: "permission_error" });
  });

  it("lets Core expand one requested file and resume Reviewer without exposing tools", async () => {
    const generate = vi.fn();
    const responses = [needsMapperContext(), validPass()];
    let turn = 0;
    generate.mockImplementation(async (request: GenerateRequest) => ({
      provider: "fake",
      model: request.model,
      text: JSON.stringify(responses[turn++]),
    }));
    const nyxara = new NyxaraOrchestrator({
      providers: [provider(generate)],
      agents: [
        { role: "reviewer", providerId: "fake", modelId: "reviewer-model" },
      ],
    });
    const expanded = vi.fn();
    nyxara.events.on("review.context_expanded", expanded);

    const reviewed = await nyxara.reviewTask({
      requirement: "Add pagination",
      objective: "Paginate notifications",
      task: task(),
      execution: execution(),
      validation: passingValidation(),
      executorContext: emptyContext(workspace),
    });

    expect(reviewed).toMatchObject({
      result: { status: "passed" },
      turns: 2,
      contextExpansions: 1,
      model: {
        role: "reviewer",
        providerId: "fake",
        modelId: "reviewer-model",
      },
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(reviewed.evidence.context).toContainEqual(
      expect.objectContaining({ path: "src/notification.mapper.ts" }),
    );
    expect((generate.mock.calls[1]?.[0] as GenerateRequest).prompt).toContain(
      "mapPaginationMetadata",
    );
    expect(generate.mock.calls.every(([request]) => !request.tools)).toBe(true);
    expect(expanded).toHaveBeenCalledWith(
      expect.objectContaining({ fileCount: 1, expansion: 1 }),
    );
    expect(nyxara.getLatestReviewResult("T1")).toEqual(reviewed.result);
  });
});

function provider(generate: ModelProvider["generate"]): ModelProvider {
  return {
    id: "fake",
    displayName: "Fake Reviewer",
    capabilities: () => ({
      modelDiscovery: true,
      textGeneration: true,
      structuredOutput: true,
    }),
    listModels: async () => [
      {
        id: "reviewer-model",
        name: "Reviewer Model",
        provider: "fake",
        capabilities: { text: true, structuredOutput: true, tools: true },
      },
    ],
    generate,
  };
}

function needsMapperContext() {
  return {
    status: "needs_more_context",
    summary: "Mapper evidence is required",
    findings: [],
    criteria: task().acceptanceCriteria.map((criterion) => ({
      criterion,
      status: "uncertain",
      reason: "Need mapper evidence",
    })),
    contextRequest: {
      paths: ["src/notification.mapper.ts"],
      reasons: ["Verify pagination metadata mapping"],
    },
  };
}

function validPass() {
  return {
    status: "passed",
    summary: "Pagination criteria are satisfied",
    findings: [],
    criteria: task().acceptanceCriteria.map((criterion) => ({
      criterion,
      status: "satisfied",
      reason: "Diff and mapper evidence are sufficient",
    })),
  };
}

function emptyContext(workspaceRoot: string): ContextBundle {
  return {
    workspaceRoot,
    prompt: "pagination",
    files: [],
    git: {
      status: {
        isRepository: false,
        branch: null,
        files: [],
        truncated: false,
      },
      diff: { isRepository: false, diff: "", files: [], truncated: false },
    },
    totalBytes: 0,
    estimatedTokens: 0,
    truncated: false,
  };
}
