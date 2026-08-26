import { NyxaraOrchestrator } from "@nyxara/core";

export interface CliIO {
  write(message: string): void;
  question(prompt: string): Promise<string>;
}

export async function runCli(
  io: CliIO,
  workspace = process.cwd(),
): Promise<void> {
  const nyxara = new NyxaraOrchestrator();

  nyxara.events.on("workflow.started", () => {
    io.write("✓ Workflow started\n");
  });
  nyxara.events.on("workflow.completed", () => {
    io.write("✓ Workflow completed\n");
  });
  nyxara.events.on("workflow.failed", ({ error }) => {
    io.write(`✗ Workflow failed: ${error.message}\n`);
  });

  io.write("NYXARA ORCHESTRATOR\n\n");
  const prompt = await io.question("> What do you want to build?\n\n");

  await nyxara.run({ workspace, prompt });
}

