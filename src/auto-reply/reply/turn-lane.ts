import type { RuntimeTurnLane } from "./turn-lane.types.js";

type RuntimeTurnLaneInput = {
  Provider?: unknown;
  Surface?: unknown;
  RuntimeTurnLane?: unknown;
};

const VALID_TURN_LANES = new Set<RuntimeTurnLane>([
  "live_user",
  "operator_recovery",
  "heartbeat",
  "cron",
  "maintenance",
  "subagent",
  "inter_session",
]);

export function isRuntimeTurnLane(value: unknown): value is RuntimeTurnLane {
  return typeof value === "string" && VALID_TURN_LANES.has(value as RuntimeTurnLane);
}

function normalizeProvider(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function classifyRuntimeTurnLane(ctx: RuntimeTurnLaneInput): RuntimeTurnLane {
  if (isRuntimeTurnLane(ctx.RuntimeTurnLane)) {
    return ctx.RuntimeTurnLane;
  }

  const provider = normalizeProvider(ctx.Provider);
  switch (provider) {
    case "heartbeat":
      return "heartbeat";
    case "cron-event":
    case "cron":
      return "cron";
    case "exec-event":
    case "system-event":
    case "maintenance":
      return "maintenance";
    case "subagent":
    case "subagent-event":
      return "subagent";
    case "inter-session":
    case "inter_session":
    case "sessions-send":
      return "inter_session";
    case "operator-recovery":
    case "operator_recovery":
      return "operator_recovery";
    default:
      return "live_user";
  }
}

export function isAutonomousTurnLane(lane: RuntimeTurnLane): boolean {
  return lane === "heartbeat" || lane === "cron" || lane === "maintenance";
}

export function buildRuntimeTurnLanePrompt(lane: RuntimeTurnLane): string {
  return `Runtime turn lane: ${lane}. Treat live_user as a direct human request; heartbeat/cron/maintenance are autonomous wakes.`;
}
