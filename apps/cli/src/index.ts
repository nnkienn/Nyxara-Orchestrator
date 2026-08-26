#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runCli } from "./cli.js";

const readline = createInterface({ input: stdin, output: stdout });

try {
  await runCli({
    write(message) {
      stdout.write(message);
    },
    question(prompt) {
      return readline.question(prompt);
    },
  });
} catch (error: unknown) {
  process.exitCode = 1;

  if (!(error instanceof Error)) {
    stdout.write("Nyxara stopped because of an unknown error.\n");
  }
} finally {
  readline.close();
}

