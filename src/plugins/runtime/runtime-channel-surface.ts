import { createRuntimeChannel } from "./runtime-channel.js";
import type { PluginRuntime } from "./types.js";

export function createPluginChannelRuntime(): PluginRuntime["channel"] {
  return createRuntimeChannel();
}
