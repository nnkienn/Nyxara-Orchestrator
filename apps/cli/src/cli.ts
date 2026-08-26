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
