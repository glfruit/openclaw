import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

type TestAgentConfig = {
  id?: string;
  workspace?: string;
  subagents?: {
    allowAgents?: string[];
  };
};

type TestConfig = {
  agents?: {
    list?: TestAgentConfig[];
  };
};

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  registerSubagentRunMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  hookRunner: {
    hasHooks: vi.fn(() => false),
    runSubagentSpawning: vi.fn(),
  },
}));

let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: () => "",
    getOAuthProviders: () => [],
  };
});

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig("/tmp/workspace-main", {
    agents: {
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    session: {
      threadBindings: {
        defaultSpawnContext: "isolated",
      },
    },
    ...overrides,
  });
}

function resolveTestAgentConfig(cfg: Record<string, unknown>, agentId: string) {
  return (cfg as TestConfig).agents?.list?.find((entry) => entry.id === agentId);
}

function resolveTestAgentWorkspace(cfg: Record<string, unknown>, agentId: string) {
  return resolveTestAgentConfig(cfg, agentId)?.workspace ?? `/tmp/workspace-${agentId}`;
}

function getRegisteredRun() {
  return hoisted.registerSubagentRunMock.mock.calls.at(0)?.[0] as
    | Record<string, unknown>
    | undefined;
}

function findLastSessionDeleteCall() {
  return hoisted.callGatewayMock.mock.calls.findLast(
    ([request]) => (request as { method?: string }).method === "sessions.delete",
  )?.[0] as
    | {
        params?: {
          key?: string;
          deleteTranscript?: boolean;
          emitLifecycleHooks?: boolean;
        };
      }
    | undefined;
}

async function expectAcceptedWorkspace(params: { agentId: string; expectedWorkspaceDir: string }) {
  const result = await spawnSubagentDirect(
    {
      task: "inspect workspace",
      agentId: params.agentId,
    },
    {
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "123",
      agentTo: "456",
      workspaceDir: "/tmp/requester-workspace",
    },
  );

  expect(result.status).toBe("accepted");
  expect(getRegisteredRun()).toMatchObject({
    workspaceDir: params.expectedWorkspaceDir,
  });
}

describe("spawnSubagentDirect workspace inheritance", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => hoisted.configOverride,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      hookRunner: hoisted.hookRunner,
      resolveAgentConfig: resolveTestAgentConfig,
      resolveAgentWorkspaceDir: resolveTestAgentWorkspace,
      resetModules: false,
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockClear();
    hoisted.registerSubagentRunMock.mockClear();
    hoisted.updateSessionStoreMock.mockReset();
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);
    hoisted.hookRunner.hasHooks.mockReset();
    hoisted.hookRunner.hasHooks.mockImplementation(() => false);
    hoisted.hookRunner.runSubagentSpawning.mockReset();
    hoisted.configOverride = createConfigOverride();
    setupAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
  });

  it("uses the target agent workspace for cross-agent spawns", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            subagents: {
              allowAgents: ["ops"],
            },
          },
          {
            id: "ops",
            workspace: "/tmp/workspace-ops",
          },
        ],
      },
    });

    await expectAcceptedWorkspace({
      agentId: "ops",
      expectedWorkspaceDir: "/tmp/workspace-ops",
    });
  });

  it("preserves the inherited workspace for same-agent spawns", async () => {
    await expectAcceptedWorkspace({
      agentId: "main",
      expectedWorkspaceDir: "/tmp/requester-workspace",
    });
  });

  async function spawnAndReadAgentParams(task: { task: string; lightContext?: boolean }) {
    await spawnSubagentDirect(task, {
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "123",
      agentTo: "456",
      workspaceDir: "/tmp/requester-workspace",
    });

    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    return agentCall?.params;
  }

  it("allows cross-agent cwd only when relative dot matches requester workspace and applies it to metadata/run/gateway", async () => {
    const requesterWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-requester-ws-"));
    const targetWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-target-ws-"));
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = { ...store };
      },
    });
    hoisted.configOverride = createConfigOverride({
      agents: {
        list: [
          {
            id: "main",
            workspace: requesterWorkspace,
            subagents: {
              allowAgents: ["ops"],
            },
          },
          {
            id: "ops",
            workspace: targetWorkspace,
          },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inspect same workspace",
        agentId: "ops",
        cwd: ".",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "123",
        agentTo: "456",
        workspaceDir: requesterWorkspace,
      },
    );

    const requesterRealpath = await fs.realpath(requesterWorkspace);
    expect(result.status).toBe("accepted");
    expect(Object.values(persistedStore ?? {}).at(0)).toMatchObject({
      spawnedWorkspaceDir: requesterRealpath,
    });
    expect(getRegisteredRun()).toMatchObject({
      workspaceDir: requesterRealpath,
    });
    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    expect(agentCall?.params).not.toHaveProperty("workspaceDir");
  });

  it("allows absolute requester workspace cwd for cross-agent same-workspace spawns", async () => {
    const requesterWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-requester-ws-"));
    const targetWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-target-ws-"));
    hoisted.configOverride = createConfigOverride({
      agents: {
        list: [
          {
            id: "main",
            workspace: requesterWorkspace,
            subagents: { allowAgents: ["ops"] },
          },
          { id: "ops", workspace: targetWorkspace },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inspect absolute same workspace",
        agentId: "ops",
        cwd: requesterWorkspace,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "123",
        agentTo: "456",
        workspaceDir: requesterWorkspace,
      },
    );

    const requesterRealpath = await fs.realpath(requesterWorkspace);
    expect(result.status).toBe("accepted");
    expect(getRegisteredRun()).toMatchObject({
      workspaceDir: requesterRealpath,
    });
    const agentCall = hoisted.callGatewayMock.mock.calls.find(
      ([request]) => (request as { method?: string }).method === "agent",
    )?.[0] as { params?: Record<string, unknown> } | undefined;
    expect(agentCall?.params).not.toHaveProperty("workspaceDir");
  });

  it("rejects arbitrary cwd values before child/session/run/gateway side effects", async () => {
    const requesterWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-requester-ws-"));
    const subdir = path.join(requesterWorkspace, "subdir");
    await fs.mkdir(subdir);
    const symlinkToRequester = path.join(requesterWorkspace, "link-to-requester");
    await fs.symlink(requesterWorkspace, symlinkToRequester, "dir");
    const missing = path.join(requesterWorkspace, "missing");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-outside-ws-"));
    hoisted.configOverride = createConfigOverride({
      agents: {
        list: [
          {
            id: "main",
            workspace: requesterWorkspace,
            subagents: { allowAgents: ["ops"] },
          },
          { id: "ops", workspace: outside },
        ],
      },
    });

    for (const cwd of [
      subdir,
      outside,
      missing,
      "subdir",
      "subdir/..",
      "./subdir/..",
      "../",
      "link-to-requester",
      "   ",
    ] as const) {
      hoisted.callGatewayMock.mockClear();
      hoisted.registerSubagentRunMock.mockClear();
      hoisted.updateSessionStoreMock.mockClear();

      const result = await spawnSubagentDirect(
        { task: `reject ${cwd}`, agentId: "ops", cwd },
        {
          agentSessionKey: "agent:main:main",
          agentChannel: "telegram",
          agentAccountId: "123",
          agentTo: "456",
          workspaceDir: requesterWorkspace,
        },
      );

      expect(result.status).toBe("forbidden");
      expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
      expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
      expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    }
  });

  it("passes lightweight bootstrap context flags for lightContext subagent spawns", async () => {
    const agentParams = await spawnAndReadAgentParams({
      task: "inspect workspace",
      lightContext: true,
    });

    expect(agentParams).toMatchObject({
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "default",
    });
  });

  it("omits bootstrap context flags for default subagent spawns", async () => {
    const agentParams = await spawnAndReadAgentParams({
      task: "inspect workspace",
    });

    expect(agentParams).not.toHaveProperty("bootstrapContextMode");
    expect(agentParams).not.toHaveProperty("bootstrapContextRunKind");
  });

  it("deletes the provisional child session when a non-thread subagent start fails", async () => {
    hoisted.callGatewayMock.mockImplementation(
      async (request: {
        method?: string;
        params?: { key?: string; deleteTranscript?: boolean; emitLifecycleHooks?: boolean };
      }) => {
        if (request.method === "sessions.patch") {
          return { ok: true };
        }
        if (request.method === "agent") {
          throw new Error("spawn startup failed");
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "fail after provisional session creation",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: "spawn startup failed",
    });
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();

    const deleteCall = findLastSessionDeleteCall();
    expect(deleteCall?.params).toMatchObject({
      key: result.childSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  });

  it("keeps lifecycle hooks enabled when registerSubagentRun fails after thread binding succeeds", async () => {
    hoisted.hookRunner.hasHooks.mockImplementation((name?: string) => name === "subagent_spawning");
    hoisted.hookRunner.runSubagentSpawning.mockResolvedValue({
      status: "ok",
      threadBindingReady: true,
    });
    hoisted.registerSubagentRunMock.mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    hoisted.callGatewayMock.mockImplementation(
      async (request: {
        method?: string;
        params?: { key?: string; deleteTranscript?: boolean; emitLifecycleHooks?: boolean };
      }) => {
        if (request.method === "sessions.patch") {
          return { ok: true };
        }
        if (request.method === "agent") {
          return { runId: "run-thread-register-fail" };
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "fail after register with thread binding",
        thread: true,
        mode: "session",
        context: "isolated",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: "Failed to register subagent run: registry unavailable",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      runId: "run-thread-register-fail",
    });

    const deleteCall = findLastSessionDeleteCall();
    expect(deleteCall?.params).toMatchObject({
      key: result.childSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: true,
    });
  });
});
