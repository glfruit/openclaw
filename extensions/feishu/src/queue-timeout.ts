import { resolveFeishuRuntimeAccount } from "./accounts.js";
import type { ClawdbotConfig } from "./bot-runtime-api.js";

export const DEFAULT_FEISHU_QUEUE_TIMEOUT_MS = 5 * 60 * 1000;

export function resolveFeishuQueueTaskTimeoutMs(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): number {
  const account = resolveFeishuRuntimeAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const configured = account.config.queueTaskTimeoutMs;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured < 0) {
    return DEFAULT_FEISHU_QUEUE_TIMEOUT_MS;
  }
  return configured;
}
