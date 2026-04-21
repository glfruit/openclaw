import { createAgentGatewayCompat } from "./agent-gateway-compat.js";
import type { GatewayBuiltInCompatPayload, GatewayServerOptions } from "./server.js";

function mergeCompatBuiltIns(
  base: GatewayBuiltInCompatPayload | undefined,
  extra: GatewayBuiltInCompatPayload,
): GatewayBuiltInCompatPayload {
  if (!base) {
    return extra;
  }
  return {
    handlers: {
      ...base.handlers,
      ...extra.handlers,
    },
    methodNames: Array.from(
      new Set([
        ...(base.methodNames ?? []),
        ...Object.keys(base.handlers),
        ...(extra.methodNames ?? []),
        ...Object.keys(extra.handlers),
      ]),
    ),
  };
}

export function resolveAgentCompatGatewayOptions(
  opts: GatewayServerOptions = {},
): GatewayServerOptions {
  return {
    ...opts,
    compatBuiltIns: mergeCompatBuiltIns(opts.compatBuiltIns, createAgentGatewayCompat()),
  };
}
