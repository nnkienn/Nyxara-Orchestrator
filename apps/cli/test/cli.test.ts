import { NyxaraOrchestrator } from "@nyxara/core";
import type { ModelProvider } from "@nyxara/provider-sdk";
import { describe, expect, it, vi } from "vitest";
import { runCli, type CliIO } from "../src/cli.js";

describe("Nyxara CLI", () => {
  it("selects and consumes providers without provider-specific workflow logic", async () => {
    const generate = vi.fn(async () => ({
      provider: "fake",
      model: "model-1",
      text: "Normalized response",
    }));
    const provider: ModelProvider = {
      id: "fake",
      displayName: "Fake Provider",
      capabilities: () => ({ modelDiscovery: true, textGeneration: true }),
      listModels: async () => [
        { id: "model-1", name: "Model One", provider: "fake" },
      ],
      generate,
    };
    const nyxara = new NyxaraOrchestrator({ providers: [provider] });
    const answers = ["1", "model-1", "hello"];
    const output: string[] = [];
    const io: CliIO = {
      write(message) {
        output.push(message);
      },
      async question() {
        return answers.shift() ?? "";
      },
    };

    await runCli(io, nyxara);

    expect(generate).toHaveBeenCalledWith({
      model: "model-1",
      prompt: "hello",
    });
    expect(output.join("")).toContain("Fake Provider (fake)");
    expect(output.join("")).toContain("Model One (model-1)");
    expect(output.join("")).toContain("Response:\nNormalized response");
  });
});
