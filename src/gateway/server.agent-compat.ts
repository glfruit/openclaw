import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GatewayServerOptions } from "./server.js";

async function loadAgentCompatRuntime() {
  return await import("./server.agent-compat.runtime.js");
}

async function loadCoreGatewayServer() {
  const sourceBuildServerUrl = new URL("../../dist/gateway/server.js", import.meta.url);
  const builtLaneServerUrl = new URL("./server.js", import.meta.url);
  const serverUrl = existsSync(fileURLToPath(sourceBuildServerUrl))
    ? sourceBuildServerUrl
    : builtLaneServerUrl;
  return (await import(/* @vite-ignore */ serverUrl.href)) as typeof import("./server.js");
}

export async function startAgentCompatGatewayServer(port = 18789, opts: GatewayServerOptions = {}) {
  const [{ resolveAgentCompatGatewayOptions }, { startGatewayServer }] = await Promise.all([
    loadAgentCompatRuntime(),
    loadCoreGatewayServer(),
  ]);
  return await startGatewayServer(port, resolveAgentCompatGatewayOptions(opts));
}
