export type RuntimeTurnLane =
  | "live_user"
  | "operator_recovery"
  | "heartbeat"
  | "cron"
  | "maintenance"
  | "subagent"
  | "inter_session";
