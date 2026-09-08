import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

function isTelegramGroupAgentSessionKey(sessionKey: string | undefined): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  const parts = parsed.rest.split(":").map((part) => part.trim().toLowerCase());
  return parts[0] === "telegram" && parts.includes("group");
}

/**
 * Owned: agent sessions bound to Telegram groups default to visible delivery
 * unless the request states an explicit deliver preference. Group ops traffic
 * (alerts, standing-order notes) must not silently stay undelivered.
 */
export function resolveAgentVisibleDeliveryIntent(params: {
  requestDeliver?: boolean;
  sessionKey?: string;
}): boolean {
  if (typeof params.requestDeliver === "boolean") {
    return params.requestDeliver;
  }
  return isTelegramGroupAgentSessionKey(params.sessionKey);
}
