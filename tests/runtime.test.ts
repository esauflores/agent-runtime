import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { capture, OUTPUT_LIMIT } from "../src/runner.ts";

const CLI = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const runtimeArgs = ["bun" in process.versions ? "--bun" : "", CLI].filter(Boolean);
const utf8 = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8");

function launch(args: string[], state: string) {
  const child = spawn(process.execPath, [...runtimeArgs, ...args], {
    env: { ...process.env, XDG_STATE_HOME: state },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const finished = new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, out: utf8(stdout), err: utf8(stderr) }));
  });
  return { child, finished };
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await delay(10);
  }
  throw new Error("independent test deadline exceeded");
}

function setup(t: { onTestFinished: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(join(tmpdir(), "agent-runtime-"));
  const children: ChildProcess[] = [];
  t.onTestFinished(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  function start(argv: string[], timeout = "2") {
    const job = launch(["run", "--workspace", root, "--timeout-secs", timeout, "--", ...argv], root);
    children.push(job.child);
    return job;
  }
  async function dir() {
    return waitFor(() => {
      const jobs = join(root, "agent-runtime/jobs");
      if (!fs.existsSync(jobs)) return;
      const entry = fs.readdirSync(jobs)[0];
      return entry ? join(jobs, entry) : undefined;
    });
  }
  return { root, start, dir };
}

for (const [name, argv, code, state] of [
  ["success", ["printf", "%s", "literal $HOME; no shell"], 0, "succeeded"],
  ["failure", ["sh", "-c", "exit 7"], 7, "failed"],
  ["exit 124 is not timeout", ["sh", "-c", "exit 124"], 124, "failed"],
  ["spawn failure", ["missing-agent-runtime-test-command"], 1, "error"],
  ["signal exit", ["sh", "-c", "kill -TERM $$"], 1, "failed"],
] as const) {
  test(name, { timeout: 5000 }, async (t) => {
    const { start, dir } = setup(t);
    const result = await start([...argv]).finished;
    assert.equal(result.code, code, result.err);
    const record = JSON.parse(result.out);
    assert.equal(record.state, state);
    assert.equal(typeof record.elapsed_ms, "number");
    assert.equal(typeof record.started_at_ms, "number");
    assert.equal(typeof record.finished_at_ms, "number");
    const job = await dir();
    assert.deepEqual(JSON.parse(fs.readFileSync(join(job, "result.json"), "utf8")), record);
    assert.equal(fs.statSync(job).mode & 0o777, 0o700);
    if (name === "success") assert.equal(fs.readFileSync(join(job, "stdout.log"), "utf8"), argv[2]);
    if (name === "signal exit") assert.equal(record.signal, 15);
  });
}

test("timeout kills group and retains partial output", { timeout: 5000 }, async (t) => {
  const { start, dir } = setup(t);
  const result = await start(["sh", "-c", "printf partial; sleep 30 & wait"], "1").finished;
  assert.equal(result.code, 124, result.err);
  assert.equal(JSON.parse(result.out).state, "timed_out");
  assert.equal(fs.readFileSync(join(await dir(), "stdout.log"), "utf8"), "partial");
});

test("ordinary descendants cannot keep inherited pipes open", { timeout: 5000 }, async (t) => {
  const { start } = setup(t);
  const began = performance.now();
  const result = await start(["sh", "-c", "sleep 30 & exit 0"]).finished;
  assert.equal(result.code, 0, result.err);
  assert.ok(performance.now() - began < 2000);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} persists cancellation and live logs`, { timeout: 5000 }, async (t) => {
    const { start, dir } = setup(t);
    const { child, finished } = start(["sh", "-c", "printf visible; sleep 30 & wait"]);
    const job = await dir();
    await waitFor(() => {
      const path = join(job, "stdout.log");
      return fs.existsSync(path) && fs.readFileSync(path, "utf8") === "visible" ? true : undefined;
    });
    assert.equal(child.exitCode, null);
    child.kill(signal);
    const result = await finished;
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143, result.err);
    const record = JSON.parse(result.out);
    assert.equal(record.state, "cancelled");
    assert.equal(record.cancellation_signal, signal === "SIGINT" ? 2 : 15);
    assert.equal(record.signal, 9);
    assert.deepEqual(JSON.parse(fs.readFileSync(join(job, "result.json"), "utf8")), record);
  });
}

test("caps both streams while draining excess bytes", { timeout: 5000 }, async (t) => {
  const { start, dir } = setup(t);
  const result = await start(["sh", "-c", "head -c 2097152 /dev/zero; head -c 2097152 /dev/zero >&2"]).finished;
  assert.equal(result.code, 0, result.err);
  const record = JSON.parse(result.out);
  assert.ok(record.stdout_truncated && record.stderr_truncated);
  const job = await dir();
  for (const file of ["stdout.log", "stderr.log"]) assert.equal(fs.statSync(join(job, file)).size, OUTPUT_LIMIT);
});

test("capture preserves bytes before reader failure", async (t) => {
  const { root } = setup(t);
  const errors: string[] = [];
  const reader = new Readable({
    read() {
      this.push(Buffer.from("partial"));
      this.destroy(new Error("reader failed"));
    },
  });
  await capture(reader, join(root, "log"), errors);
  assert.equal(fs.readFileSync(join(root, "log"), "utf8"), "partial");
  assert.match(errors.join(";"), /reader failed/);
});

test("capture drains after log open or write failure", async (t) => {
  const { root } = setup(t);
  for (const path of [root, "/dev/full"]) {
    const errors: string[] = [];
    const reader = Readable.from([Buffer.alloc(8192), Buffer.alloc(OUTPUT_LIMIT)]);
    assert.equal(await capture(reader, path, errors), true);
    assert.ok(reader.readableEnded);
    assert.equal(errors.length, 1);
  }
});

test("a failed log does not prevent its sibling from being captured", async (t) => {
  const { root } = setup(t);
  const errors: string[] = [];
  await Promise.all([
    capture(Readable.from([Buffer.from("out")]), root, errors),
    capture(Readable.from([Buffer.from("err")]), join(root, "stderr.log"), errors),
  ]);
  assert.equal(errors.length, 1);
  assert.equal(fs.readFileSync(join(root, "stderr.log"), "utf8"), "err");
});

test("exactly the output limit is not marked truncated", async (t) => {
  const { root } = setup(t);
  const errors: string[] = [];
  assert.equal(await capture(Readable.from([Buffer.alloc(OUTPUT_LIMIT)]), join(root, "log"), errors), false);
  assert.deepEqual(errors, []);
});

test("final persistence failure appears in JSON and diagnostic exactly once", { timeout: 5000 }, async (t) => {
  const { start } = setup(t);
  const result = await start([
    "sh",
    "-c",
    'for job in "$XDG_STATE_HOME"/agent-runtime/jobs/*; do mkdir "$job/result.json.tmp"; done',
  ]).finished;
  assert.equal(result.code, 1);
  const record = JSON.parse(result.out);
  assert.equal(record.state, "error");
  assert.equal(record.exit_code, 0);
  assert.match(record.error, /saving final result.json/);
  assert.equal(result.err.match(/saving final result.json/g)?.length, 1);
});

test("broken stdout does not prevent terminal result persistence", { timeout: 5000 }, async (t) => {
  const { start, dir } = setup(t);
  const { child, finished } = start(["sh", "-c", "sleep 0.1; printf saved"]);
  child.stdout!.destroy();
  const result = await finished;
  assert.equal(result.code, 1);
  const job = await dir();
  const record = JSON.parse(fs.readFileSync(join(job, "result.json"), "utf8"));
  assert.equal(record.state, "succeeded");
  assert.equal(fs.readFileSync(join(job, "stdout.log"), "utf8"), "saved");
});

test("CLI rejects invalid options without starting a job", { timeout: 5000 }, async (t) => {
  const { root } = setup(t);
  for (const args of [
    ["run", "--workspace", root, "true"],
    ["run", "--", "true"],
    ["run", "--workspace", root, "--", ""],
    ["run", "--workspace", root, "--timeout-secs", "0", "--", "true"],
    ["run", "--workspace", root, "--timeout-secs", "86401", "--", "true"],
    ["run", "--workspace", root, "--timeout-secs", "1.5", "--", "true"],
    ["run", "--workspace", root, "--workspace", root, "--", "true"],
    ["run", "--workspace", root, "--timeout-secs", "1", "--timeout-secs", "2", "--", "true"],
    ["run", "--workspace", root, "--unknown", "--", "true"],
    ["run", "--workspace", "/", "--", "true"],
  ]) {
    const result = await launch(args, root).finished;
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(result.out, "");
  }
});

test("help and version work without a workspace", { timeout: 5000 }, async (t) => {
  const { root } = setup(t);
  for (const args of [[], ["--help"], ["--version"], ["run", "--help"]]) {
    const result = await launch(args, root).finished;
    assert.equal(result.code, 0, result.err);
    if (args[0] === "--version") assert.equal(result.out.trim(), "0.1.0");
    else assert.match(result.out, /agent-runtime/);
  }
});
