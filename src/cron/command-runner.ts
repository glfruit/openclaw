import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { runCommandWithTimeout } from "../process/exec.js";
import type { CronRunDiagnostics, CronRunOutcome, CronRunStatus, CronJob } from "./types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
const EFFECTIVELY_UNBOUNDED_TIMEOUT_MS = 2_147_483_647;

type CommandPayload = Extract<CronJob["payload"], { kind: "command" }>;

function secondsToMs(value: number | undefined): number | undefined {
  if (typeof value !== "number") {
    return undefined;
  }
  if (value <= 0) {
    return EFFECTIVELY_UNBOUNDED_TIMEOUT_MS;
  }
  return finiteSecondsToTimerSafeMilliseconds(value) ?? undefined;
}

function formatCommand(argv: string[]): string {
  return argv.map((arg) => JSON.stringify(arg)).join(" ");
}

function trimOutput(value: string): string | undefined {
  return normalizeOptionalString(value);
}

function splitLegacyCommandLine(input: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let tokenStarted = false;

  for (const ch of input.trim()) {
    if (escaped) {
      current += ch;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      tokenStarted = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += ch;
    tokenStarted = true;
  }

  if (escaped || quote) {
    return undefined;
  }
  if (tokenStarted) {
    tokens.push(current);
  }
  return tokens.length > 0 ? tokens : undefined;
}

function resolveCommandArgv(payload: CommandPayload): string[] | undefined {
  if (Array.isArray(payload.argv) && payload.argv.length > 0) {
    return payload.argv;
  }
  const command = normalizeOptionalString(payload.command);
  if (!command) {
    return undefined;
  }
  if ("args" in payload) {
    if (!Array.isArray(payload.args) || payload.args.some((entry) => typeof entry !== "string")) {
      return undefined;
    }
    if (/\s/.test(command)) {
      return undefined;
    }
    return [command, ...payload.args];
  }
  return splitLegacyCommandLine(command);
}

function compileOptionalRegex(pattern: string | undefined, field: string): RegExp | string | null {
  if (!pattern) {
    return null;
  }
  try {
    return new RegExp(pattern, "m");
  } catch {
    return `${field} is not a valid regex: ${pattern}`;
  }
}

function lastNonEmptyLine(stdout: string, maxLength: number): string | undefined {
  const lines = stdout.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (line) {
      return line.slice(0, maxLength);
    }
  }
  return undefined;
}

function buildLegacyCommandSummary(stdout: string, payload: CommandPayload): string | undefined {
  const summaryRegex = compileOptionalRegex(payload.summaryRegex, "summaryRegex");
  if (summaryRegex instanceof RegExp) {
    const match = summaryRegex.exec(stdout);
    if (match) {
      return match[1] ?? match[0];
    }
  }

  switch (payload.outputMode) {
    case "stdout":
      return stdout.trimEnd().slice(-4096);
    case "json": {
      const lines = stdout.trimEnd().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) {
          continue;
        }
        try {
          JSON.parse(line);
          return line;
        } catch {
          // Continue scanning for a JSON summary line.
        }
      }
      return lastNonEmptyLine(stdout, 1024);
    }
    case "summary":
    case "lastLine":
      return lastNonEmptyLine(stdout, 1024);
    default:
      return undefined;
  }
}

function buildCommandSummary(params: {
  stdout: string;
  stderr: string;
  payload: CommandPayload;
}): string | undefined {
  const legacySummary = buildLegacyCommandSummary(params.stdout, params.payload);
  if (legacySummary !== undefined) {
    return trimOutput(legacySummary);
  }
  const stdout = trimOutput(params.stdout);
  const stderr = trimOutput(params.stderr);
  if (stdout && stderr) {
    return `stdout:\n${stdout}\n\nstderr:\n${stderr}`;
  }
  return stdout ?? stderr;
}

function commandErrorMessage(params: {
  code: number | null;
  signal: NodeJS.Signals | null;
  termination: string;
}): string {
  if (params.termination === "timeout") {
    return "command timed out";
  }
  if (params.termination === "no-output-timeout") {
    return "command produced no output before noOutputTimeoutSeconds";
  }
  if (params.termination === "signal") {
    return params.signal ? `command stopped by signal ${params.signal}` : "command stopped";
  }
  if (typeof params.code === "number") {
    return `command exited with code ${params.code}`;
  }
  return "command failed";
}

function buildDiagnostics(params: {
  command: string;
  status: CronRunStatus;
  summary?: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutTruncatedBytes?: number;
  stderrTruncatedBytes?: number;
  nowMs: () => number;
}): CronRunDiagnostics {
  const truncated =
    Boolean(params.stdoutTruncatedBytes && params.stdoutTruncatedBytes > 0) ||
    Boolean(params.stderrTruncatedBytes && params.stderrTruncatedBytes > 0);
  return {
    ...(params.summary ? { summary: params.summary } : {}),
    entries: [
      {
        ts: params.nowMs(),
        source: "exec",
        severity: params.status === "ok" ? "info" : "error",
        message: params.summary
          ? `command ${params.status}: ${params.command}`
          : `command ${params.status} with no output: ${params.command}`,
        exitCode: params.code,
        truncated,
        ...(params.signal ? { toolName: `signal:${params.signal}` } : {}),
      },
    ],
  };
}

/** Executes a cron command payload without starting an agent/model run. */
export async function runCronCommandJob(params: {
  job: CronJob;
  abortSignal?: AbortSignal;
  nowMs?: () => number;
}): Promise<CronRunOutcome> {
  const nowMs = params.nowMs ?? Date.now;
  const { payload } = params.job;
  if (payload.kind !== "command") {
    return {
      status: "skipped",
      error: 'command runner requires payload.kind="command"',
    };
  }
  const argv = resolveCommandArgv(payload);
  if (!argv) {
    return {
      status: "skipped",
      error: 'command payload requires non-empty "argv"',
    };
  }
  for (const field of ["successRegex", "failureRegex", "summaryRegex"] as const) {
    const compiled = compileOptionalRegex(payload[field], field);
    if (typeof compiled === "string") {
      return {
        status: "error",
        error: compiled,
        diagnostics: {
          summary: compiled,
          entries: [
            {
              ts: nowMs(),
              source: "exec",
              severity: "error",
              message: compiled,
              exitCode: null,
            },
          ],
        },
      };
    }
  }

  const command = formatCommand(argv);
  const noOutputTimeoutMs = secondsToMs(payload.noOutputTimeoutSeconds);
  try {
    const result = await runCommandWithTimeout(argv, {
      timeoutMs: secondsToMs(payload.timeoutSeconds) ?? DEFAULT_COMMAND_TIMEOUT_MS,
      ...(payload.cwd ? { cwd: payload.cwd } : {}),
      ...(payload.input !== undefined ? { input: payload.input } : {}),
      ...(payload.env ? { env: payload.env } : {}),
      ...(noOutputTimeoutMs !== undefined ? { noOutputTimeoutMs } : {}),
      ...(payload.outputMaxBytes !== undefined ? { maxOutputBytes: payload.outputMaxBytes } : {}),
      ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      killProcessTree: true,
    });
    const baseOk =
      result.code === 0 &&
      !result.killed &&
      result.termination !== "timeout" &&
      result.termination !== "no-output-timeout" &&
      result.termination !== "signal";
    const output = `${result.stdout}${result.stderr}`;
    const failureRegex = compileOptionalRegex(payload.failureRegex, "failureRegex");
    const successRegex = compileOptionalRegex(payload.successRegex, "successRegex");
    let error: string | undefined;
    if (failureRegex instanceof RegExp && failureRegex.test(output)) {
      error = "failureRegex matched in command output";
    } else if (!baseOk) {
      error = commandErrorMessage({
        code: result.code,
        signal: result.signal,
        termination: result.termination,
      });
    } else if (successRegex instanceof RegExp && !successRegex.test(output)) {
      error = "successRegex did not match in command output";
    }
    const status: CronRunStatus = error ? "error" : "ok";
    const summary = buildCommandSummary({ stdout: result.stdout, stderr: result.stderr, payload });
    return {
      status,
      ...(error ? { error } : {}),
      ...(summary ? { summary } : {}),
      diagnostics: buildDiagnostics({
        command,
        status,
        summary,
        code: result.code,
        signal: result.signal,
        stdoutTruncatedBytes: result.stdoutTruncatedBytes,
        stderrTruncatedBytes: result.stderrTruncatedBytes,
        nowMs,
      }),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      error,
      diagnostics: {
        summary: error,
        entries: [
          {
            ts: nowMs(),
            source: "exec",
            severity: "error",
            message: `command failed to start: ${command}: ${error}`,
            exitCode: null,
          },
        ],
      },
    };
  }
}
