import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

type GatewayCaller = typeof import("../gateway/call.js").callGateway;

export type OpenClawSessionToolsOptions = {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
  agentTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  agentThreadId?: string | number;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  requesterAgentIdOverride?: string;
  sessionId?: string;
  /** Callback invoked when sessions_yield tool is called. */
  onYield?: (message: string) => Promise<void> | void;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  workspaceDir?: string;
};

export function createOpenClawSessionTools(
  options?: OpenClawSessionToolsOptions & {
    callGateway?: GatewayCaller;
  },
): AnyAgentTool[] {
  return [
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: options?.config,
      callGateway: options?.callGateway,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config: options?.config,
      callGateway: options?.callGateway,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
      config: options?.config,
      callGateway: options?.callGateway,
    }),
    createSessionsYieldTool({
      sessionId: options?.sessionId,
      onYield: options?.onYield,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      agentGroupId: options?.agentGroupId,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupSpace: options?.agentGroupSpace,
      sandboxed: options?.sandboxed,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
      workspaceDir: options?.workspaceDir,
    }),
  ];
}
