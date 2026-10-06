#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from "commander";

import { run } from "./runner.ts";

function once(value: string, previous?: string): string {
  if (previous !== undefined) throw new InvalidArgumentError("option must not be repeated");
  return value;
}
function timeout(value: string, previous?: string): string {
  once(value, previous);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 86400) {
    throw new InvalidArgumentError("timeout must be an integer from 1 to 86400");
  }
  return value;
}

// Commander parses runtime options only; workload arguments stay completely literal.
const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const command = separator < 0 ? [] : argv.slice(separator + 1);
const program = new Command();

program
  .name("agent-runtime")
  .description("Run one local command and record its result. Local execution is not a sandbox.")
  .version("0.1.0")
  .exitOverride();

program
  .command("run")
  .description("Run a command in the specified workspace")
  .usage("--workspace PATH [--timeout-secs SECONDS] -- COMMAND [ARG...]")
  .requiredOption("--workspace <PATH>", "workspace directory", once)
  .option("--timeout-secs <SECONDS>", "timeout from 1 to 86400 seconds (default: 60)", timeout)
  .action(async (options: { workspace: string; timeoutSecs?: string }) => {
    if (!command[0]) throw new Error("expected -- followed by a nonempty command");
    if (command.some((arg) => arg.includes("\0"))) throw new Error("command arguments must not contain NUL");
    process.exitCode = await run({
      workspace: options.workspace,
      timeoutSecs: Number(options.timeoutSecs ?? 60),
      argv: command,
    });
  });

// Broken diagnostic/output pipes must not crash cleanup or skip final persistence.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
try {
  if (!argv.length) program.outputHelp();
  else await program.parseAsync(separator < 0 ? argv : argv.slice(0, separator), { from: "user" });
} catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode;
  else {
    process.stderr.write(`agent-runtime: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
