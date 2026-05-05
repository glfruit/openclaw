import { spawn } from "node:child_process";
import path from "node:path";
import type { CronCommandPayload, CronRunOutcome } from "./types.js";

/** Maximum stdout+stderr bytes captured (128 KiB). */
const MAX_OUTPUT_BYTES = 128 * 1024;

/**
 * Validate a command payload before execution.
 * Returns an error string if invalid, or undefined if valid.
 */
export function validateCommandPayload(payload: CronCommandPayload): string | undefined {
  if (!payload.command) {
    return "command payload requires a non-empty command";
  }

  // Reject non-absolute paths
  if (!path.isAbsolute(payload.command)) {
    return `command must be an absolute path, got: ${payload.command}`;
  }

  if (payload.args !== undefined) {
    if (!Array.isArray(payload.args) || !payload.args.every((a) => typeof a === "string")) {
      return "args must be a string array";
    }
  }

  // Validate regex fields compile
  for (const field of ["successRegex", "failureRegex", "summaryRegex"] as const) {
    const val = payload[field];
    if (val !== undefined) {
      try {
        new RegExp(val);
      } catch {
        return `${field} is not a valid regex: ${val}`;
      }
    }
  }

  return undefined;
}

/**
 * Execute a command payload via child_process.spawn with shell:false.
 * Returns a CronRunOutcome for integration with existing delivery/failureAlert paths.
 */
export async function executeCommandPayload(
  payload: CronCommandPayload,
  options?: { abortSignal?: AbortSignal },
): Promise<CronRunOutcome> {
  const validationError = validateCommandPayload(payload);
  if (validationError) {
    return { status: "error", error: validationError };
  }

  const timeoutMs = payload.timeoutSeconds != null ? payload.timeoutSeconds * 1000 : undefined;

  return new Promise<CronRunOutcome>((resolve) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (payload.env) {
      Object.assign(env, payload.env);
    }

    let killed = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const proc = spawn(payload.command, payload.args ?? [], {
      cwd: payload.cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);

      if (killed) {
        resolve({
          status: "error",
          error: `command timed out after ${payload.timeoutSeconds}s`,
        });
        return;
      }

      const output = stdout + stderr;

      // failureRegex check (checked first, even on exit 0)
      if (payload.failureRegex) {
        try {
          if (new RegExp(payload.failureRegex, "m").test(output)) {
            resolve({
              status: "error",
              error: `failureRegex matched in command output`,
              summary: buildSummary(stdout, payload),
            });
            return;
          }
        } catch {
          // Invalid regex at runtime — skip
        }
      }

      // Nonzero exit => error
      if (exitCode !== 0) {
        resolve({
          status: "error",
          error: `command exited with code ${exitCode ?? signal}`,
          summary: buildSummary(stdout, payload),
        });
        return;
      }

      // successRegex: if configured and missing, error
      if (payload.successRegex) {
        try {
          if (!new RegExp(payload.successRegex, "m").test(output)) {
            resolve({
              status: "error",
              error: `successRegex did not match in command output`,
              summary: buildSummary(stdout, payload),
            });
            return;
          }
        } catch {
          // Invalid regex at runtime — skip check
        }
      }

      resolve({
        status: "ok",
        summary: buildSummary(stdout, payload),
      });
    };

    proc.stdout.on("data", (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
      if (remaining > 0) {
        const add = str.slice(0, remaining);
        stdout += add;
        stdoutBytes += Buffer.byteLength(add, "utf8");
      }
    });

    proc.stderr.on("data", (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const remaining = MAX_OUTPUT_BYTES - stderrBytes;
      if (remaining > 0) {
        const add = str.slice(0, remaining);
        stderr += add;
        stderrBytes += Buffer.byteLength(add, "utf8");
      }
    });

    proc.on("close", (code, signal) => finish(code, signal));
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve({ status: "error", error: `command spawn error: ${err.message}` });
    });

    // Timeout handling
    if (timeoutMs != null && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        killed = true;
        proc.kill("SIGKILL");
      }, timeoutMs);
    }

    // Abort signal handling
    if (options?.abortSignal) {
      const onAbort = () => {
        if (settled) return;
        killed = true;
        proc.kill("SIGKILL");
      };
      if (options.abortSignal.aborted) {
        onAbort();
      } else {
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

function buildSummary(stdout: string, payload: CronCommandPayload): string {
  // summaryRegex: extract first match group or matching line
  if (payload.summaryRegex) {
    try {
      const re = new RegExp(payload.summaryRegex, "m");
      const match = re.exec(stdout);
      if (match) {
        return match[1] ?? match[0];
      }
    } catch {
      // Invalid regex — fall through
    }
  }

  const mode = payload.outputMode ?? "lastLine";

  switch (mode) {
    case "stdout":
      return stdout.trimEnd().slice(-4096);
    case "json": {
      // Try to parse last non-empty line as JSON for a structured summary
      const lines = stdout.trimEnd().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line) {
          try {
            JSON.parse(line);
            return line;
          } catch {
            // Not valid JSON, continue
          }
        }
      }
      // Fallback to lastLine
      break;
    }
    case "lastLine":
    default:
      break;
  }

  // Default: last non-empty line, trimmed to 1024 chars
  const lines = stdout.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) {
      return line.slice(0, 1024);
    }
  }
  return "";
}
