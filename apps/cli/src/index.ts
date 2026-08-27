#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { NyxaraOrchestrator } from "@nyxara/core";
import { OpenAICompatibleProvider } from "@nyxara/providers";
import {
  runCli,
  runExecuteCli,
  runInspectCli,
  runPlanCli,
  runValidationCli,
} from "./cli.js";
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
const workspaceRoot = process.env.INIT_CWD ?? process.cwd();
const cliArguments = process.argv.slice(2);
if (cliArguments[0] === "--") {
  cliArguments.shift();
}

try {
  const io = {
    write(message: string) {
      stdout.write(message);
    },
    question(prompt: string) {
      return readline.question(prompt);
    },
  };

  if (cliArguments[0] === "inspect") {
    const argumentPrompt = cliArguments.slice(1).join(" ").trim();
    const prompt = argumentPrompt || (await io.question("Context prompt:\n> "));
    await runInspectCli(io, nyxara, workspaceRoot, prompt);
  } else if (cliArguments[0] === "plan") {
    const argumentPrompt = cliArguments.slice(1).join(" ").trim();
    const prompt = argumentPrompt || (await io.question("Planning prompt:\n> "));
    await runPlanCli(io, nyxara, workspaceRoot, prompt);
  } else if (cliArguments[0] === "execute") {
    const argumentPrompt = cliArguments.slice(1).join(" ").trim();
    const prompt = argumentPrompt || (await io.question("Execution prompt:\n> "));
    await runExecuteCli(io, nyxara, workspaceRoot, prompt);
  } else if (cliArguments[0] === "validate") {
    await runValidationCli(io, nyxara, workspaceRoot);
  } else {
    await runCli(io, nyxara);
  }
} catch (error: unknown) {
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : "Unknown error";
  stdout.write(`\nNyxara stopped: ${message}\n`);
} finally {
  readline.close();
}
