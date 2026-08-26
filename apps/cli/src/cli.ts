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

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
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
