import { isAutonomousLane, isLiveRecoverableLane } from "./active-run-policy.js";
import type { QueueSettings } from "./queue.js";
import type { RuntimeTurnLane } from "./turn-lane.types.js";

export type ActiveRunQueueAction = "run-now" | "enqueue-followup" | "drop";

export function resolveActiveRunQueueAction(params: {
  isActive: boolean;
  isHeartbeat: boolean;
  lane?: RuntimeTurnLane;
  shouldFollowup: boolean;
  queueMode: QueueSettings["mode"];
  activeRunStale?: boolean;
}): ActiveRunQueueAction {
  if (!params.isActive) {
    return "run-now";
  }
  const lane = params.lane;
  if (params.isHeartbeat || isAutonomousLane(lane)) {
    return "drop";
  }
  if (isLiveRecoverableLane(lane)) {
    return "enqueue-followup";
  }
  if (params.shouldFollowup || params.queueMode === "steer") {
    return "enqueue-followup";
  }
  return "run-now";
}
