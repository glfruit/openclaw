import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { withTimeout } from "./timeout.js";

type SharedCodexAppServerClientEntry = {
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
  activeCount: number;
  lastUsedAt: number;
  idleTimeoutMs: number;
  maxClients: number;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type SharedCodexAppServerClientState = {
  clients: Map<string, SharedCodexAppServerClientEntry>;
};

type LegacySharedCodexAppServerClientState = Partial<SharedCodexAppServerClientEntry> & {
  key?: string;
  clients?: unknown;
};

const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: unknown;
  };
  const state = globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
  if (isSharedCodexAppServerClientState(state)) {
    return state;
  }
  const legacyState = readLegacySharedCodexAppServerClientState(state);
  const clients = new Map<string, SharedCodexAppServerClientEntry>();
  if (legacyState?.key && (legacyState.client || legacyState.promise)) {
    const legacyKey = legacyState.key;
    const runtimeOptions = resolveCodexAppServerRuntimeOptions();
    clients.set(legacyKey, {
      client: legacyState.client,
      promise: legacyState.promise,
      activeCount: 0,
      lastUsedAt: Date.now(),
      idleTimeoutMs: runtimeOptions.sharedClientIdleTimeoutMs,
      maxClients: runtimeOptions.sharedClientMaxClients,
    });
    legacyState.client?.addCloseHandler((closedClient) =>
      clearSharedClientEntryIfCurrent(legacyKey, closedClient),
    );
  }
  const nextState: SharedCodexAppServerClientState = { clients };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] = nextState;
  return nextState;
}

function isSharedCodexAppServerClientState(
  value: unknown,
): value is SharedCodexAppServerClientState {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { clients?: unknown }).clients instanceof Map
  );
}

function readLegacySharedCodexAppServerClientState(
  value: unknown,
): LegacySharedCodexAppServerClientState | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  return value as LegacySharedCodexAppServerClientState;
}

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  runtimeOptions?: Pick<
    CodexAppServerRuntimeOptions,
    "sharedClientIdleTimeoutMs" | "sharedClientMaxClients"
  >;
}): Promise<CodexAppServerClient> {
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const usesNativeAuth = options?.authProfileId === null;
  const requestedAuthProfileId =
    options?.authProfileId === null ? undefined : options?.authProfileId;
  const authProfileId = usesNativeAuth
    ? undefined
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: requestedAuthProfileId,
        agentDir,
        config: options?.config,
      });
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const runtimeOptions = options?.runtimeOptions ?? resolveCodexAppServerRuntimeOptions();
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    config: options?.config,
  });
  const key = codexAppServerStartOptionsKey(startOptions, {
    authProfileId,
    agentDir: usesNativeAuth ? undefined : agentDir,
  });
  const state = getSharedCodexAppServerClientState();
  const entry = getOrCreateSharedClientEntry(state, key);
  entry.idleTimeoutMs = runtimeOptions.sharedClientIdleTimeoutMs;
  entry.maxClients = runtimeOptions.sharedClientMaxClients;
  touchSharedClientEntry(entry);
  const sharedPromise =
    entry.promise ??
    (entry.promise = (async () => {
      const client = CodexAppServerClient.start(startOptions);
      entry.client = client;
      client.addCloseHandler((closedClient) => clearSharedClientEntryIfCurrent(key, closedClient));
      try {
        await client.initialize();
        await applyCodexAppServerAuthProfile({
          client,
          agentDir,
          authProfileId: usesNativeAuth ? null : authProfileId,
          startOptions,
          config: options?.config,
        });
        scheduleSharedClientIdleCleanup(key, entry, entry.idleTimeoutMs);
        pruneIdleSharedClients(state, entry.maxClients);
        return client;
      } catch (error) {
        // Startup failures happen before callers own the shared client, so close
        // the child here instead of leaving a rejected daemon attached to stdio.
        client.close();
        throw error;
      }
    })());
  try {
    return await withTimeout(
      sharedPromise,
      options?.timeoutMs ?? 0,
      "codex app-server initialize timed out",
    );
  } catch (error) {
    const currentEntry = state.clients.get(key);
    if (currentEntry?.promise === sharedPromise) {
      clearSharedClientEntry(key, currentEntry);
    }
    throw error;
  }
}

export async function createIsolatedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<CodexAppServerClient> {
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const usesNativeAuth = options?.authProfileId === null;
  const requestedAuthProfileId =
    options?.authProfileId === null ? undefined : options?.authProfileId;
  const authProfileId = usesNativeAuth
    ? undefined
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: requestedAuthProfileId,
        agentDir,
        config: options?.config,
      });
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    config: options?.config,
  });
  const client = CodexAppServerClient.start(startOptions);
  const initialize = client.initialize();
  try {
    await withTimeout(initialize, options?.timeoutMs ?? 0, "codex app-server initialize timed out");
    await applyCodexAppServerAuthProfile({
      client,
      agentDir,
      authProfileId: usesNativeAuth ? null : authProfileId,
      startOptions,
      config: options?.config,
    });
    return client;
  } catch (error) {
    client.close();
    void initialize.catch(() => undefined);
    throw error;
  }
}

export function acquireSharedCodexAppServerClientLease(
  client: CodexAppServerClient | undefined,
): (() => void) | undefined {
  if (!client) {
    return undefined;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client !== client) {
      continue;
    }
    entry.activeCount += 1;
    touchSharedClientEntry(entry);
    clearSharedClientIdleTimer(entry);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const currentEntry = state.clients.get(key);
      if (currentEntry !== entry) {
        return;
      }
      entry.activeCount = Math.max(0, entry.activeCount - 1);
      touchSharedClientEntry(entry);
      scheduleSharedClientIdleCleanup(key, entry, entry.idleTimeoutMs);
      pruneIdleSharedClients(state, entry.maxClients);
    };
  }
  return undefined;
}

export function resetSharedCodexAppServerClientForTests(): void {
  const state = getSharedCodexAppServerClientState();
  for (const entry of state.clients.values()) {
    clearSharedClientIdleTimer(entry);
  }
  state.clients.clear();
}

export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  for (const entry of state.clients.values()) {
    clearSharedClientIdleTimer(entry);
  }
  state.clients.clear();
  for (const client of clients) {
    client.close();
  }
}

export function clearSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      clearSharedClientIdleTimer(entry);
      state.clients.delete(key);
      client.close();
      return true;
    }
  }
  return false;
}

export async function clearSharedCodexAppServerClientIfCurrentAndWait(
  client: CodexAppServerClient | undefined,
  options?: {
    exitTimeoutMs?: number;
    forceKillDelayMs?: number;
  },
): Promise<boolean> {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  for (const [key, entry] of state.clients) {
    if (entry.client === client) {
      clearSharedClientIdleTimer(entry);
      state.clients.delete(key);
      await client.closeAndWait(options);
      return true;
    }
  }
  return false;
}

export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const clients = collectSharedClients(state);
  for (const entry of state.clients.values()) {
    clearSharedClientIdleTimer(entry);
  }
  state.clients.clear();
  await Promise.all(clients.map((client) => client.closeAndWait(options)));
}

function getOrCreateSharedClientEntry(
  state: SharedCodexAppServerClientState,
  key: string,
): SharedCodexAppServerClientEntry {
  let entry = state.clients.get(key);
  if (!entry) {
    const runtimeOptions = resolveCodexAppServerRuntimeOptions();
    entry = {
      activeCount: 0,
      lastUsedAt: Date.now(),
      idleTimeoutMs: runtimeOptions.sharedClientIdleTimeoutMs,
      maxClients: runtimeOptions.sharedClientMaxClients,
    };
    state.clients.set(key, entry);
  }
  return entry;
}

function clearSharedClientEntry(key: string, entry: SharedCodexAppServerClientEntry): void {
  const state = getSharedCodexAppServerClientState();
  if (state.clients.get(key) !== entry) {
    return;
  }
  clearSharedClientIdleTimer(entry);
  state.clients.delete(key);
  entry.client?.close();
}

function clearSharedClientEntryIfCurrent(key: string, client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  const entry = state.clients.get(key);
  if (entry?.client === client) {
    clearSharedClientIdleTimer(entry);
    state.clients.delete(key);
  }
}

function touchSharedClientEntry(entry: SharedCodexAppServerClientEntry): void {
  entry.lastUsedAt = Date.now();
}

function clearSharedClientIdleTimer(entry: SharedCodexAppServerClientEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
}

function scheduleSharedClientIdleCleanup(
  key: string,
  entry: SharedCodexAppServerClientEntry,
  idleTimeoutMs: number,
): void {
  clearSharedClientIdleTimer(entry);
  if (
    !entry.client ||
    entry.activeCount > 0 ||
    !Number.isFinite(idleTimeoutMs) ||
    idleTimeoutMs <= 0
  ) {
    return;
  }
  entry.idleTimer = setTimeout(
    () => {
      const state = getSharedCodexAppServerClientState();
      const currentEntry = state.clients.get(key);
      if (currentEntry !== entry || entry.activeCount > 0 || !entry.client) {
        return;
      }
      state.clients.delete(key);
      entry.client.close();
    },
    Math.max(1, Math.floor(idleTimeoutMs)),
  );
  entry.idleTimer.unref?.();
}

function pruneIdleSharedClients(state: SharedCodexAppServerClientState, maxClients: number): void {
  const limit = Math.max(1, Math.floor(maxClients));
  const entries = [...state.clients.entries()].filter(([, entry]) => Boolean(entry.client));
  if (entries.length <= limit) {
    return;
  }
  const idleEntries = entries
    .filter(([, entry]) => entry.activeCount <= 0)
    .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt);
  for (const [key, entry] of idleEntries) {
    if (state.clients.size <= limit) {
      break;
    }
    clearSharedClientEntry(key, entry);
  }
}

function collectSharedClients(state: SharedCodexAppServerClientState): CodexAppServerClient[] {
  return [
    ...new Set(
      [...state.clients.values()]
        .map((entry) => entry.client)
        .filter((client): client is CodexAppServerClient => Boolean(client)),
    ),
  ];
}
