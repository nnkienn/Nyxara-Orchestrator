#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { NyxaraOrchestrator } from "@nyxara/core";
import { OpenAICompatibleProvider } from "@nyxara/providers";
import { runCli } from "./cli.js";
import { EnvironmentCredentialStore } from "./environment-credential-store.js";

const readline = createInterface({ input: stdin, output: stdout });
const credentialStore = new EnvironmentCredentialStore(process.env);
const provider = new OpenAICompatibleProvider({
  ...(process.env.NYXARA_OPENAI_BASE_URL
    ? { baseUrl: process.env.NYXARA_OPENAI_BASE_URL }
    : {}),
  credentialStore,
  credentialKey: "NYXARA_OPENAI_API_KEY",
});
const nyxara = new NyxaraOrchestrator({ providers: [provider] });

try {
  await runCli(
    {
      write(message) {
        stdout.write(message);
      },
      question(prompt) {
        return readline.question(prompt);
      },
    },
    nyxara,
  );
} catch (error: unknown) {
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : "Unknown error";
  stdout.write(`\nNyxara stopped: ${message}\n`);
} finally {
  readline.close();
}
