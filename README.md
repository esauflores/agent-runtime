# Agent Runtime

A small TypeScript CLI that runs one local command, enforces a timeout, and records its result. Runs directly on **Node.js 24+ or Bun 1.4+**, with no compilation step. Commander handles the CLI; Vitest handles tests. Linux/Unix only: cleanup uses process groups.

## Run

```sh
node src/main.ts run --workspace "$PWD" --timeout-secs 60 -- printf '%s\n' 'hello world'
# Or use Bun:
bun src/main.ts run --workspace "$PWD" --timeout-secs 60 -- printf '%s\n' 'hello world'
```

The CLI is `run --workspace PATH [--timeout-secs SECONDS] -- COMMAND [ARG...]`. Timeout defaults to 60 seconds and must be an integer from 1 to 86400. Arguments after `--` are passed literally, without an implicit shell. Explicitly invoking `sh -c` still invokes a shell. Node/Bun decode OS arguments into JavaScript strings; unlike the previous Rust CLI, original non-UTF-8 argument bytes cannot be validated or preserved.

Each run creates a private `0700` job directory under `$XDG_STATE_HOME/agent-runtime/jobs`, or `$HOME/.local/state/agent-runtime/jobs`, containing:

- `result.json`: queued/running/final state, argv, canonical workspace, exit code, child signal, cancellation signal, errors, truncation flags, and timing.
- `stdout.log` and `stderr.log`: separate logs written while the command runs, each capped at 1 MiB. Excess output continues draining to avoid pipe deadlocks. Log open/write failures are recorded independently and do not stop draining.

The CLI prints the final JSON to stdout and the result path/diagnostics to stderr. Result updates use a synced temporary file, atomic rename, and directory sync. Logs are visible immediately but are not synced for power-loss durability. Unix timestamps (`started_at_ms`, `finished_at_ms`) use epoch milliseconds; `elapsed_ms` uses a monotonic clock. Spawn attempts receive timing metadata; jobs cancelled before execution have null start/elapsed fields.

| Outcome                                       | State       | CLI exit                                          |
| --------------------------------------------- | ----------- | ------------------------------------------------- |
| Command exits 0                               | `succeeded` | 0                                                 |
| Command exits nonzero or by signal            | `failed`    | Child exit clamped to 0–125, or 1 for signal exit |
| Timeout                                       | `timed_out` | 124                                               |
| SIGINT / SIGTERM received by runtime          | `cancelled` | 130 / 143                                         |
| Spawn, capture, cleanup, or persistence error | `error`     | 1                                                 |

A child that exits 124 is `failed`, not `timed_out`: use the JSON state to distinguish them. Runtime errors take precedence over cancellation/timeout; cancellation takes precedence over timeout. Final result-save failures are reported once on stderr and in stdout JSON, but cannot guarantee an updated on-disk record. A broken output pipe returns nonzero without discarding the persisted result.

## Checks

```sh
bun install --frozen-lockfile
bun run check      # Oxlint, formatting, and type checks
bun run check:fix  # Apply lint fixes and formatting
bun run test      # Vitest on Node
bun --bun run test # Vitest and child CLI on Bun
```

Commander is the sole runtime dependency; Vitest is a development dependency only. Tests cover literal arguments, validation, success/failure, spawn errors, timeouts, signals, live logs, bounded output, capture failures, final-save errors, and ordinary descendant cleanup.

## Boundaries

**Local execution is not a sandbox.** The workspace is only the child's working directory; commands retain the runtime user's filesystem/network access and inherit its environment. Do not run hostile code or expose inherited credentials to untrusted commands.

The child starts in a separate process group. On timeout/cancellation the runtime kills the group and waits for the direct child. It also kills remaining group members on ordinary exit before waiting for the output streams to close. A subprocess can escape with `setsid` and retain inherited pipes: process-group cleanup is trusted-workload containment, not an isolation guarantee, and escaped pipe holders can prevent completion.

SIGINT/SIGTERM cancellation is supported. Runtime crashes, SIGKILL, restart recovery, scheduling, retries, and result retention/garbage collection are not implemented. Provide any required isolation and resource limits externally; this project does not manage containers.
