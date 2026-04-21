import { AGENT_GATEWAY_METHODS } from "./server-methods-list.js";
import { agentHandlers } from "./server-methods/agent.js";
import type { GatewayBuiltInCompatPayload } from "./server.js";

export function createAgentGatewayCompat(): GatewayBuiltInCompatPayload {
  return {
    handlers: agentHandlers,
    methodNames: [...AGENT_GATEWAY_METHODS],
  };
}

export const agentGatewayCompat = createAgentGatewayCompat();
