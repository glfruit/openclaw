import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createMessageTool } from "./tools/message-tool.js";

export type OpenClawMessageToolsOptions = {
  agentAccountId?: string;
  agentSessionKey?: string;
  sessionId?: string;
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  sandboxRoot?: string;
  requireExplicitMessageTarget?: boolean;
  disableMessageTool?: boolean;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
};

export function createOpenClawMessageTools(options?: OpenClawMessageToolsOptions): AnyAgentTool[] {
  if (options?.disableMessageTool) {
    return [];
  }

  return [
    createMessageTool({
      agentAccountId: options?.agentAccountId,
      agentSessionKey: options?.agentSessionKey,
      sessionId: options?.sessionId,
      config: options?.config,
      currentChannelId: options?.currentChannelId,
      currentChannelProvider: options?.agentChannel,
      currentThreadTs: options?.currentThreadTs,
      currentMessageId: options?.currentMessageId,
      replyToMode: options?.replyToMode,
      hasRepliedRef: options?.hasRepliedRef,
      sandboxRoot: options?.sandboxRoot,
      requireExplicitTarget: options?.requireExplicitMessageTarget,
      requesterSenderId: options?.requesterSenderId ?? undefined,
      senderIsOwner: options?.senderIsOwner,
    }),
  ];
}
