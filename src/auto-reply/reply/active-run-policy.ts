import type { RuntimeTurnLane } from "./turn-lane.types.js";

export const DEFAULT_ACTIVE_RUN_STALE_MS = 15 * 60 * 1000;

export type ActiveRunRuntimeState = {
  isActive: boolean;
  isStreaming?: boolean;
  startedAt?: number;
  lastActivityAt?: number;
  phase?: string;
  visiblePendingBackgroundedWork?: boolean;
};

export function isLiveRecoverableLane(lane?: RuntimeTurnLane): boolean {
  return lane === "live_user" || lane === "operator_recovery" || lane === "inter_session";
}

export function isAutonomousLane(lane?: RuntimeTurnLane): boolean {
  return lane === "heartbeat" || lane === "cron" || lane === "maintenance";
}

export function resolveActiveRunStaleness(params: {
  state?: ActiveRunRuntimeState;
  now?: number;
  staleMs?: number;
}): { stale: boolean; ageMs?: number; lastActivityAgeMs?: number; thresholdMs: number } {
  const thresholdMs = Math.max(1, Math.floor(params.staleMs ?? DEFAULT_ACTIVE_RUN_STALE_MS));
  const state = params.state;
  if (!state?.isActive) {
    return { stale: false, thresholdMs };
  }
  const now = params.now ?? Date.now();
  const startedAt = typeof state.startedAt === "number" ? state.startedAt : undefined;
  const lastActivityAt =
    typeof state.lastActivityAt === "number" ? state.lastActivityAt : startedAt;
  const ageMs = startedAt !== undefined ? Math.max(0, now - startedAt) : undefined;
  const lastActivityAgeMs =
    lastActivityAt !== undefined ? Math.max(0, now - lastActivityAt) : undefined;

  if (lastActivityAgeMs === undefined) {
    return { stale: false, ageMs, thresholdMs };
  }
  return {
    stale: lastActivityAgeMs >= thresholdMs,
    ageMs,
    lastActivityAgeMs,
    thresholdMs,
  };
}

export function shouldSurfaceLiveQueuedBehindStaleRun(params: {
  lane?: RuntimeTurnLane;
  activeRunStale?: boolean;
}): boolean {
  return params.activeRunStale === true && isLiveRecoverableLane(params.lane);
}

export function shouldSurfaceLiveQueuedBehindBackgroundedRun(params: {
  lane?: RuntimeTurnLane;
  visiblePendingBackgroundedWork?: boolean;
}): boolean {
  return params.visiblePendingBackgroundedWork === true && isLiveRecoverableLane(params.lane);
}

export function buildBackgroundedActiveRunQueuedReply(): string {
  return [
    "⚠️ I received this live message while prior backgrounded work is still running.",
    "I queued your message as live priority so it can be recovered after the background work finishes.",
    "The background process was not cancelled.",
  ].join("\n");
}

export function buildStaleActiveRunQueuedReply(params: {
  thresholdMs?: number;
  lastActivityAgeMs?: number;
}): string {
  const minutes = Math.max(
    1,
    Math.round((params.thresholdMs ?? DEFAULT_ACTIVE_RUN_STALE_MS) / 60_000),
  );
  return [
    "⚠️ I received this live message while the current run appears stuck.",
    `I queued it for recovery instead of dropping it (stale threshold: ${minutes}m).`,
    "The active run was not cancelled.",
  ].join("\n");
}
