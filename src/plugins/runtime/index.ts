import {
  clearGatewaySubagentRuntime,
  createPluginChannelRuntime,
  setGatewaySubagentRuntime,
} from "./gateway-channel-runtime.js";
import { createPluginRuntimeCore } from "./runtime-core.js";
import { createRuntimeMedia } from "./runtime-media.js";
import type { CreatePluginRuntimeOptions, PluginRuntime } from "./types.js";

export type { CreatePluginRuntimeOptions } from "./types.js";
export {
  clearGatewaySubagentRuntime,
  createPluginChannelRuntime,
  createPluginRuntimeCore,
  setGatewaySubagentRuntime,
};

export function createPluginRuntime(options: CreatePluginRuntimeOptions = {}): PluginRuntime {
  const runtime = createPluginRuntimeCore(options) as PluginRuntime & {
    media?: PluginRuntime["media"];
  };
  runtime.media = createRuntimeMedia();
  return runtime;
}

export type { PluginRuntime } from "./types.js";
