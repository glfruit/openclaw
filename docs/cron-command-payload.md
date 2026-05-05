# Cron Command Payload — Design & Migration Guide

## Overview

OpenClaw cron now supports `payload.kind="command"` as a first-class payload type alongside `systemEvent` and `agentTurn`. Command jobs execute a local binary directly via `child_process.spawn` with `shell: false`, bypassing any model invocation entirely.

This is the recommended execution path for pure-script cron jobs: observability checks, file validation, structured status scrapers, and any task that produces deterministic stdout without needing natural language reasoning.

## Schema

```ts
type CronCommandPayload = {
  kind: "command";
  command: string; // Absolute path to executable (required)
  args?: string[]; // Arguments (no shell interpolation)
  cwd?: string; // Working directory
  env?: Record<string, string>; // Extra env vars merged atop process.env
  timeoutSeconds?: number; // Per-command timeout; job-level timeout ceiling still applies
  successRegex?: string; // If set, combined stdout+stderr must match for success
  failureRegex?: string; // If set, any match in combined stdout+stderr → failure
  summaryRegex?: string; // Extract summary from first match group in stdout
  outputMode?: "lastLine" | "stdout" | "json"; // Default: "lastLine"
};
```

## Safety Boundaries

| Rule                  | Details                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Absolute paths only   | `command` must be an absolute path                                                                 |
| No shell              | Uses `spawn(cmd, args, { shell: false })`                                                          |
| Args passed literally | Shell metacharacters in `args` are not interpreted because no shell is invoked                     |
| Output truncation     | stdout/stderr each capped at 128 KiB                                                               |
| Timeout enforced      | Command timeout and job-level abort kill with SIGKILL                                              |
| sessionTarget         | Must be `"isolated"` (default); `main`/`current`/`session:<id>` rejected                           |
| Summary capped        | `stdout` summaries are capped at 4096 chars; default `lastLine` summaries are capped at 1024 chars |

## CLI Usage

### Add a command cron job

```bash
openclaw cron add \
  --name "watchdog" \
  --every 5m \
  --command /usr/bin/python3 \
  --args /path/to/watchdog.py \
  --args --minutes \
  --args 10 \
  --success-regex "^WATCHDOG_OK" \
  --summary-regex "^SUMMARY:(.+)" \
  --output-mode lastLine
```

### Edit a job to use command payload

```bash
openclaw cron edit my-job-id \
  --command /usr/bin/python3 \
  --args /path/to/script.py \
  --success-regex "^OK"
```

### jobs.json Example

```json
{
  "id": "session-runtime-watchdog",
  "name": "session runtime watchdog",
  "enabled": true,
  "schedule": { "kind": "every", "everyMs": 300000 },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "command",
    "command": "/usr/bin/python3",
    "args": ["/Users/gorin/.openclaw/scripts/session_runtime_watchdog.py", "--minutes", "10"],
    "timeoutSeconds": 120,
    "successRegex": "^(WATCHDOG_OK|NO_ACTION)",
    "summaryRegex": "^SUMMARY:(.+)",
    "outputMode": "lastLine"
  },
  "delivery": { "mode": "none" }
}
```

## Migration from agentTurn Wrapper Jobs

### When to migrate

A job should migrate from `agentTurn` to `command` when:

1. The agent's message is purely "run script X and report its output"
2. No natural language reasoning is needed
3. The script already outputs structured status lines (OK/FAIL)
4. The agent adds no value beyond piping stdout

### Migration checklist

For each job:

1. **Ensure the script outputs stable status lines** — e.g., `WATCHDOG_OK`, `SUMMARY: 3 sessions active`
2. **Create the command payload** — point `command` at the script interpreter, set `args`, configure `successRegex`
3. **Set delivery mode** — use `none` for command jobs; rely on run summaries and `failureAlert` until command success announcements are implemented
4. **Test with `openclaw cron run <id>`** — verify status and summary
5. **Observe one natural cycle** — check run log

### What NOT to migrate

| Job type               | Reason                                      |
| ---------------------- | ------------------------------------------- |
| standing-order patrol  | Needs model judgment for state decisions    |
| Content writing/review | Quality output requires LLM                 |
| Research/digest        | Requires natural language synthesis         |
| harness-audit          | Needs skill interpretation + prioritization |

## Delivery and Failure Alerts

Command jobs integrate with cron failure alerts. Successful command output is recorded as the run summary; command execution itself does not invoke the isolated-agent delivery path.

- **delivery.mode = "none"**: Recommended for deterministic script cron jobs
- **failureAlert**: After N consecutive command failures, alert is sent
- **delivery.mode = "announce"**: Reserved for agentTurn delivery; command success announcements require a follow-up delivery implementation

## Backwards Compatibility

- Existing `agentTurn` and `systemEvent` jobs are completely unaffected
- `sessionTarget: "main"` still requires `systemEvent` payload
- `sessionTarget: "isolated"` accepts `agentTurn` OR `command`
- The normalize layer strips cross-kind fields (e.g., `command` field removed from `agentTurn`)
- Old jobs.json files without `payload.kind` still infer correctly

## Rollback

To revert a command job back to agentTurn:

```bash
openclaw cron edit <id> --message "Run /path/to/script.py and report output"
```

Or restore a backup:

```bash
cp ~/.openclaw/jobs.json.bak.before-command-$(date +%Y%m%d%H%M%S) ~/.openclaw/jobs.json
openclaw gateway restart
```
