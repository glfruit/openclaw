import type { QueueSettings } from "./queue.js";
import type { RuntimeTurnLane } from "./turn-lane.types.js";

export type ActiveRunQueueAction = "run-now" | "enqueue-followup" | "drop";

export function resolveActiveRunQueueAction(params: {
  isActive: boolean;
  isHeartbeat: boolean;
  lane?: RuntimeTurnLane;
  shouldFollowup: boolean;
  queueMode: QueueSettings["mode"];
}): ActiveRunQueueAction {
  if (!params.isActive) {
    return "run-now";
  }
  const lane = params.lane;
  if (params.isHeartbeat || lane === "heartbeat" || lane === "cron" || lane === "maintenance") {
    return "drop";
  }
  if (lane === "live_user" || lane === "operator_recovery" || lane === "inter_session") {
    return "enqueue-followup";
  }
  if (params.shouldFollowup || params.queueMode === "steer") {
    return "enqueue-followup";
  }
  return "run-now";
}
