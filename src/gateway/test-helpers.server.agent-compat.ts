import { startAgentCompatGatewayServer as startAgentCompatGatewayServerDirect } from "./server.agent-compat.js";
import type { GatewayServerOptions } from "./server.js";

let registerTrackedGatewayServer:
  | ((
      server: Awaited<ReturnType<typeof startAgentCompatGatewayServerDirect>>,
    ) => Awaited<ReturnType<typeof startAgentCompatGatewayServerDirect>>)
  | undefined;

export function __setAgentCompatGatewayServerTrackerForTests(
  tracker:
    | ((
        server: Awaited<ReturnType<typeof startAgentCompatGatewayServerDirect>>,
      ) => Awaited<ReturnType<typeof startAgentCompatGatewayServerDirect>>)
    | undefined,
): void {
  registerTrackedGatewayServer = tracker;
}

export async function startAgentCompatGatewayServer(port: number, opts?: GatewayServerOptions) {
  const resolvedOpts =
    opts?.controlUiEnabled === undefined ? { ...opts, controlUiEnabled: false } : opts;
  const server = await startAgentCompatGatewayServerDirect(port, resolvedOpts);
  return registerTrackedGatewayServer ? registerTrackedGatewayServer(server) : server;
}
