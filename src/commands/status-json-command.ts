import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";

export type StatusJsonCommandOptions = {
  deep?: boolean;
  usage?: boolean;
  timeoutMs?: number;
  all?: boolean;
};

type StatusJsonPhase = "scan" | "runtime" | "write";

type StatusJsonCompletedPhase = StatusJsonPhase;

function isValidTimeoutMs(timeoutMs: number | undefined): timeoutMs is number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: () => void }).unref;
  if (typeof maybeUnref === "function") {
    maybeUnref.call(timer);
  }
}

export async function runStatusJsonCommand(params: {
  opts: StatusJsonCommandOptions;
  runtime: RuntimeEnv;
  includeSecurityAudit: boolean;
  includePluginCompatibility?: boolean;
  suppressHealthErrors?: boolean;
  scanStatusJsonFast: (
    opts: { timeoutMs?: number; all?: boolean },
    runtime: RuntimeEnv,
  ) => Promise<Parameters<typeof resolveStatusJsonOutput>[0]["scan"]>;
  forceExit?: (code: number) => never | void;
}) {
  if (!isValidTimeoutMs(params.opts.timeoutMs)) {
    const scan = await params.scanStatusJsonFast(
      { timeoutMs: params.opts.timeoutMs, all: params.opts.all },
      params.runtime,
    );
    writeRuntimeJson(
      params.runtime,
      await resolveStatusJsonOutput({
        scan,
        opts: params.opts,
        includeSecurityAudit: params.includeSecurityAudit,
        includePluginCompatibility: params.includePluginCompatibility,
        suppressHealthErrors: params.suppressHealthErrors,
      }),
    );
    return;
  }

  const timeoutMs = params.opts.timeoutMs;
  let phase: StatusJsonPhase = "scan";
  const completed: StatusJsonCompletedPhase[] = [];
  let finished = false;

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
    unrefTimer(timeoutTimer);
  });

  const full = (async () => {
    const scan = await params.scanStatusJsonFast(
      { timeoutMs, all: params.opts.all },
      params.runtime,
    );
    if (finished) {
      return "finished-after-timeout" as const;
    }
    completed.push("scan");
    phase = "runtime";

    const output = await resolveStatusJsonOutput({
      scan,
      opts: params.opts,
      includeSecurityAudit: params.includeSecurityAudit,
      includePluginCompatibility: params.includePluginCompatibility,
      suppressHealthErrors: params.suppressHealthErrors,
    });
    if (finished) {
      return "finished-after-timeout" as const;
    }
    completed.push("runtime");
    phase = "write";

    writeRuntimeJson(params.runtime, output);
    completed.push("write");
    finished = true;
    return "success" as const;
  })();

  let result: Awaited<typeof full> | "timeout";
  try {
    result = await Promise.race([full, timeout]);
  } catch (error) {
    finished = true;
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    throw error;
  }

  if (result !== "timeout") {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    return;
  }

  finished = true;
  writeRuntimeJson(params.runtime, {
    status: "partial",
    partial: true,
    partialReason: "timeout",
    timeoutMs,
    phase,
    completed,
    message: `status --json timed out after ${timeoutMs}ms`,
  });
  params.runtime.exit(124);
  (params.forceExit ?? process.exit)(124);
}
