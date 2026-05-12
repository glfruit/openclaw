import { beforeEach, describe, expect, it, vi } from "vitest";
import { runStatusJsonCommand } from "./status-json-command.ts";

const mocks = vi.hoisted(() => ({
  writeRuntimeJson: vi.fn(),
  resolveStatusJsonOutput: vi.fn(async (input) => ({ built: true, input })),
}));

vi.mock("../runtime.js", () => ({
  writeRuntimeJson: mocks.writeRuntimeJson,
}));

vi.mock("./status-json-runtime.ts", () => ({
  resolveStatusJsonOutput: mocks.resolveStatusJsonOutput,
}));

describe("runStatusJsonCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createRuntime = () =>
    ({
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    }) as never;

  const createScan = () => ({
    cfg: { gateway: {} },
    sourceConfig: { gateway: {} },
    summary: { ok: true },
    update: { root: null, installKind: "package" as const, packageManager: "npm" as const },
    osSummary: { platform: "linux" },
    memory: null,
    memoryPlugin: null,
    tailscaleMode: "off",
    tailscaleDns: null,
    tailscaleHttpsUrl: null,
    gatewayMode: "local" as const,
    gatewayConnection: {
      url: "ws://127.0.0.1:18789",
      urlSource: "config",
      message: "Gateway target: ws://127.0.0.1:18789",
    },
    remoteUrlMissing: false,
    gatewayReachable: true,
    gatewayProbe: null,
    gatewayProbeAuth: { token: "tok" },
    gatewaySelf: null,
    gatewayProbeAuthWarning: null,
    agentStatus: [],
    secretDiagnostics: [],
  });

  it("shares the fast-json scan and output flow", async () => {
    const runtime = createRuntime();
    const scan = createScan();
    const scanStatusJsonFast = vi.fn(async () => scan);
    const forceExit = vi.fn();

    await runStatusJsonCommand({
      opts: { deep: true, usage: true, timeoutMs: 1234, all: true },
      runtime,
      scanStatusJsonFast,
      includeSecurityAudit: true,
      includePluginCompatibility: true,
      suppressHealthErrors: true,
      forceExit,
    });

    expect(scanStatusJsonFast).toHaveBeenCalledWith({ timeoutMs: 1234, all: true }, runtime);
    expect(mocks.resolveStatusJsonOutput).toHaveBeenCalledWith({
      scan,
      opts: { deep: true, usage: true, timeoutMs: 1234, all: true },
      includeSecurityAudit: true,
      includePluginCompatibility: true,
      suppressHealthErrors: true,
    });
    expect(mocks.writeRuntimeJson).toHaveBeenCalledWith(runtime, {
      built: true,
      input: {
        scan,
        opts: { deep: true, usage: true, timeoutMs: 1234, all: true },
        includeSecurityAudit: true,
        includePluginCompatibility: true,
        suppressHealthErrors: true,
      },
    });
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(forceExit).not.toHaveBeenCalled();
  });

  it("writes partial timeout json and exits 124 when scan never resolves", async () => {
    const runtime = createRuntime();
    const forceExit = vi.fn();
    const scanStatusJsonFast = vi.fn(() => new Promise<never>(() => {}));

    await runStatusJsonCommand({
      opts: { timeoutMs: 1 },
      runtime,
      scanStatusJsonFast,
      includeSecurityAudit: false,
      forceExit,
    });

    expect(mocks.writeRuntimeJson).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        status: "partial",
        partial: true,
        partialReason: "timeout",
        timeoutMs: 1,
        phase: "scan",
        completed: [],
      }),
    );
    expect(runtime.exit).toHaveBeenCalledWith(124);
    expect(forceExit).toHaveBeenCalledWith(124);
  });

  it("writes partial timeout json and exits 124 when runtime output never resolves", async () => {
    const runtime = createRuntime();
    const forceExit = vi.fn();
    const scan = createScan();
    const scanStatusJsonFast = vi.fn(async () => scan);
    mocks.resolveStatusJsonOutput.mockImplementationOnce(() => new Promise<never>(() => {}));

    await runStatusJsonCommand({
      opts: { timeoutMs: 1 },
      runtime,
      scanStatusJsonFast,
      includeSecurityAudit: false,
      forceExit,
    });

    expect(mocks.writeRuntimeJson).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        status: "partial",
        partial: true,
        partialReason: "timeout",
        timeoutMs: 1,
        phase: "runtime",
        completed: ["scan"],
      }),
    );
    expect(runtime.exit).toHaveBeenCalledWith(124);
    expect(forceExit).toHaveBeenCalledWith(124);
  });
});
