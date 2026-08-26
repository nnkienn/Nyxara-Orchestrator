import { describe, expect, it } from "vitest";
import { runCli, type CliIO } from "../src/cli.js";

describe("Nyxara CLI", () => {
  it("consumes Core workflow events and renders their status", async () => {
    const output: string[] = [];
    const io: CliIO = {
      write(message) {
        output.push(message);
      },
      async question() {
        return "hello";
      },
    };

    await runCli(io, "/workspace");

    expect(output.join("")).toContain("NYXARA ORCHESTRATOR");
    expect(output).toContain("✓ Workflow started\n");
    expect(output).toContain("✓ Workflow completed\n");
  });
});

