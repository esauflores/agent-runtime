import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { constants } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import type { Readable } from "node:stream";

export const OUTPUT_LIMIT = 1024 * 1024;

export interface Options {
  workspace: string;
  timeoutSecs: number;
  argv: string[];
}

interface Record {
  job_id: string;
  workspace: string;
  argv: string[];
  timeout_secs: number;
  state: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "error";
  exit_code: number | null;
  signal: number | null;
  cancellation_signal: number | null;
  started_at_ms: number | null;
  finished_at_ms: number | null;
  elapsed_ms: number | null;
  error: string | null;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function interrupted(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EINTR";
}

function retry<T>(operation: () => T): T {
  for (;;) {
    try {
      return operation();
    } catch (error) {
      if (!interrupted(error)) throw error;
    }
  }
}

// Always drain, even after the cap or a disk error. Each stream owns its log.
export function capture(stream: Readable, path: string, errors: string[]): Promise<boolean> {
  let fd: number | undefined;
  try {
    fd = retry(() => fs.openSync(path, "w", 0o600));
  } catch (error) {
    errors.push(`opening ${path}: ${message(error)}`);
  }
  let retained = 0;
  let truncated = false;
  return new Promise((resolve) => {
    stream.on("data", (chunk: Buffer) => {
      const keep = Math.min(chunk.length, OUTPUT_LIMIT - retained);
      retained += keep;
      truncated ||= keep < chunk.length;
      if (fd === undefined || keep === 0) return;
      try {
        fs.writeFileSync(fd, chunk.subarray(0, keep));
      } catch (error) {
        errors.push(`writing ${path}: ${message(error)}`);
        close();
      }
    });
    stream.on("error", (error) => errors.push(`reading ${path}: ${message(error)}`));
    stream.once("close", () => {
      close();
      resolve(truncated);
    });
    function close() {
      if (fd === undefined) return;
      try {
        fs.closeSync(fd);
      } catch (error) {
        errors.push(`closing ${path}: ${message(error)}`);
      }
      fd = undefined;
    }
  });
}

function save(dir: string, record: Record): void {
  const temporary = join(dir, "result.json.tmp");
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record, null, 2) + "\n");
    retry(() => fs.fsyncSync(fd));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, join(dir, "result.json"));
  const directory = fs.openSync(dir, "r");
  try {
    retry(() => fs.fsyncSync(directory));
  } finally {
    fs.closeSync(directory);
  }
}

function write(stream: NodeJS.WriteStream, text: string): Promise<boolean> {
  return new Promise((resolve) => stream.write(text, (error) => resolve(!error)));
}

export async function run(options: Options): Promise<number> {
  if (!options.workspace) throw new Error("workspace must not be empty");
  const workspace = fs.realpathSync(options.workspace);
  if (!fs.statSync(workspace).isDirectory() || workspace === parse(workspace).root) {
    throw new Error("workspace must be a directory other than /");
  }
  const base = process.env.XDG_STATE_HOME || (process.env.HOME && join(process.env.HOME, ".local/state"));
  if (!base || !isAbsolute(base)) throw new Error("state directory must be absolute (set XDG_STATE_HOME or HOME)");
  const jobs = join(base, "agent-runtime/jobs");
  fs.mkdirSync(jobs, { recursive: true });
  const jobId = randomUUID();
  const dir = join(jobs, jobId);
  fs.mkdirSync(dir, { mode: 0o700 });
  const record: Record = {
    job_id: jobId,
    workspace,
    argv: options.argv,
    timeout_secs: options.timeoutSecs,
    state: "queued",
    exit_code: null,
    signal: null,
    cancellation_signal: null,
    started_at_ms: null,
    finished_at_ms: null,
    elapsed_ms: null,
    error: null,
    stdout_truncated: false,
    stderr_truncated: false,
  };
  const errors: string[] = [];
  let child: ChildProcess | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started: number | undefined;
  function killGroup() {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        errors.push(`killing child process group: ${message(error)}`);
    }
  }
  function cancel(signal: "SIGINT" | "SIGTERM") {
    record.cancellation_signal ??= constants.signals[signal];
    killGroup();
  }
  const onInt = () => cancel("SIGINT");
  const onTerm = () => cancel("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    save(dir, record);
    await write(process.stderr, `job=${record.job_id} result=${join(dir, "result.json")}\n`);
    // Let pending cancellation notifications run before starting a workload.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!record.cancellation_signal) {
      started = performance.now();
      record.started_at_ms = Date.now();
      record.state = "running";
      save(dir, record);
      child = spawn(options.argv[0]!, options.argv.slice(1), {
        cwd: workspace,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out = capture(child.stdout!, join(dir, "stdout.log"), errors);
      const err = capture(child.stderr!, join(dir, "stderr.log"), errors);
      await new Promise<void>((resolve) => {
        child!.once("error", (error) => {
          errors.push(`spawning command: ${message(error)}`);
          resolve();
        });
        // 'close' waits for pipes; cleanup must happen at 'exit' to unblock them.
        child!.once("exit", (code, signal) => {
          record.exit_code = code;
          record.signal = signal ? constants.signals[signal] : null;
          killGroup();
          resolve();
        });
        timer = setTimeout(() => {
          timedOut = true;
          killGroup();
        }, options.timeoutSecs * 1000);
      });
      clearTimeout(timer);
      [record.stdout_truncated, record.stderr_truncated] = await Promise.all([out, err]);
    }
  } catch (error) {
    errors.push(message(error));
  } finally {
    clearTimeout(timer);
    record.elapsed_ms = started === undefined ? null : Math.round(performance.now() - started);
    record.finished_at_ms = Date.now();
    record.state = errors.length
      ? "error"
      : record.cancellation_signal
        ? "cancelled"
        : timedOut
          ? "timed_out"
          : record.exit_code === 0
            ? "succeeded"
            : "failed";
    record.error = errors.length ? errors.join("; ") : null;
    try {
      save(dir, record);
    } catch (error) {
      record.state = "error";
      record.error = [record.error, `saving final result.json: ${message(error)}`].filter(Boolean).join("; ");
    }
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
  if (record.error) await write(process.stderr, `agent-runtime: ${record.error}\n`);
  const reported = await write(process.stdout, JSON.stringify(record) + "\n");
  if (!reported || record.state === "error") return 1;
  if (record.state === "cancelled") return 128 + record.cancellation_signal!;
  if (record.state === "timed_out") return 124;
  return Math.min(125, Math.max(0, record.exit_code ?? 1));
}
