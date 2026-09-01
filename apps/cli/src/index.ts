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
  runProfilesCli,
  runApprovedPlanCli,
  runRuntimeControlCli,
  runRepairCli,
  runReviewCli,
  runValidationCli,
  runRulesCli,
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

  if (cliArguments[0] === "run") {
    const { prompt: argumentPrompt, profileId } = parsePromptAndProfile(cliArguments.slice(1));
    const prompt = argumentPrompt || (await io.question("Run prompt:\n> "));
    await runApprovedPlanCli(io, nyxara, workspaceRoot, prompt, profileId);
  } else if (["pause", "resume", "abort"].includes(cliArguments[0] ?? "")) {
    const action = cliArguments[0] as "pause" | "resume" | "abort";
    const workflowId = cliArguments[1] ?? "";
    // This CLI process owns no persistent workflow registry. The command is
    // useful when invoked inside an embedding process; across restarts it
    // fails clearly instead of pretending to control a missing workflow.
    await runRuntimeControlCli(io, nyxara, action, workflowId);
  } else if (cliArguments[0] === "inspect") {
    const argumentPrompt = cliArguments.slice(1).join(" ").trim();
    const prompt = argumentPrompt || (await io.question("Context prompt:\n> "));
    await runInspectCli(io, nyxara, workspaceRoot, prompt);
  } else if (cliArguments[0] === "plan") {
    const { prompt: argumentPrompt, profileId } = parsePromptAndProfile(cliArguments.slice(1));
    const prompt = argumentPrompt || (await io.question("Planning prompt:\n> "));
    await runPlanCli(io, nyxara, workspaceRoot, prompt, profileId);
  } else if (cliArguments[0] === "execute") {
    const { prompt: argumentPrompt, profileId } = parsePromptAndProfile(cliArguments.slice(1));
    const prompt = argumentPrompt || (await io.question("Execution prompt:\n> "));
    await runExecuteCli(io, nyxara, workspaceRoot, prompt, profileId);
  } else if (cliArguments[0] === "profiles") {
    runProfilesCli(io, nyxara);
  } else if (cliArguments[0] === "rules") {
    runRulesCli(io, nyxara, cliArguments[1]);
  } else if (cliArguments[0] === "validate") {
    await runValidationCli(io, nyxara, workspaceRoot);
  } else if (cliArguments[0] === "review") {
    const argumentPrompt = cliArguments.slice(1).join(" ").trim();
    const prompt = argumentPrompt || (await io.question("Review prompt:\n> "));
    await runReviewCli(io, nyxara, workspaceRoot, prompt);
  } else if (cliArguments[0] === "repair") {
    const argumentPrompt = cliArguments.slice(1).join(" ").trim();
    const prompt = argumentPrompt || (await io.question("Repair prompt:\n> "));
    await runRepairCli(io, nyxara, workspaceRoot, prompt);
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

function parsePromptAndProfile(argumentsList: readonly string[]): { prompt: string; profileId?: string } {
  const remaining = [...argumentsList];
  const profileIndex = remaining.indexOf("--profile");
  if (profileIndex < 0) return { prompt: remaining.join(" ").trim() };
  const profileId = remaining[profileIndex + 1]?.trim();
  if (!profileId) throw new Error("--profile requires a profile ID");
  remaining.splice(profileIndex, 2);
  return { prompt: remaining.join(" ").trim(), profileId };
}
