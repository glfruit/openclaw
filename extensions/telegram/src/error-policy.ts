import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

type TelegramErrorPolicy = "always" | "once" | "silent";

type TelegramErrorConfig =
  | TelegramAccountConfig
  | TelegramDirectConfig
  | TelegramGroupConfig
  | TelegramTopicConfig;

const errorCooldownStore = new Map<string, Map<string, number>>();
const DEFAULT_ERROR_COOLDOWN_MS = 14400000;
const STORE_VERSION = 1;
let errorCooldownStoreLoaded = false;

type TelegramErrorCooldownState = {
  version: number;
  scopes: Record<string, Record<string, number>>;
};

function pruneExpiredCooldowns(messageStore: Map<string, number>, now: number) {
  for (const [message, expiresAt] of messageStore) {
    if (expiresAt <= now) {
      messageStore.delete(message);
    }
  }
}

function resolveTelegramErrorCooldownPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env, os.homedir), "telegram", "error-cooldowns.json");
}

function readPersistentCooldowns(now: number): void {
  if (errorCooldownStoreLoaded) {
    return;
  }
  errorCooldownStoreLoaded = true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolveTelegramErrorCooldownPath(), "utf8"));
  } catch {
    return;
  }
  const state = parsed as Partial<TelegramErrorCooldownState>;
  if (state.version !== STORE_VERSION || !state.scopes || typeof state.scopes !== "object") {
    return;
  }
  for (const [scopeKey, messages] of Object.entries(state.scopes)) {
    if (!messages || typeof messages !== "object" || Array.isArray(messages)) {
      continue;
    }
    const scopeStore = new Map<string, number>();
    for (const [message, expiresAt] of Object.entries(messages)) {
      if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > now) {
        scopeStore.set(message, expiresAt);
      }
    }
    if (scopeStore.size > 0) {
      errorCooldownStore.set(scopeKey, scopeStore);
    }
  }
}

function writePersistentCooldowns(now: number): void {
  const scopes: Record<string, Record<string, number>> = {};
  for (const [scopeKey, messageStore] of errorCooldownStore) {
    pruneExpiredCooldowns(messageStore, now);
    if (messageStore.size === 0) {
      continue;
    }
    scopes[scopeKey] = Object.fromEntries(messageStore);
  }
  const filePath = resolveTelegramErrorCooldownPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (Object.keys(scopes).length === 0) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      tempPath,
      `${JSON.stringify({ version: STORE_VERSION, scopes } satisfies TelegramErrorCooldownState, null, 2)}\n`,
      "utf8",
    );
    fs.renameSync(tempPath, filePath);
  } catch {
    // Error reply cooldown is best-effort; delivery must not depend on state I/O.
  }
}

export function resolveTelegramErrorPolicy(params: {
  accountConfig?: TelegramAccountConfig;
  groupConfig?: TelegramDirectConfig | TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
}): {
  policy: TelegramErrorPolicy;
  cooldownMs: number;
} {
  const configs: Array<TelegramErrorConfig | undefined> = [
    params.accountConfig,
    params.groupConfig,
    params.topicConfig,
  ];
  let policy: TelegramErrorPolicy = "always";
  let cooldownMs = DEFAULT_ERROR_COOLDOWN_MS;

  for (const config of configs) {
    if (config?.errorPolicy) {
      policy = config.errorPolicy;
    }
    if (typeof config?.errorCooldownMs === "number") {
      cooldownMs = config.errorCooldownMs;
    }
  }

  return { policy, cooldownMs };
}

export function buildTelegramErrorScopeKey(params: {
  accountId: string;
  chatId: string | number;
  threadId?: string | number | null;
}): string {
  const threadId = params.threadId == null ? "main" : String(params.threadId);
  return `${params.accountId}:${String(params.chatId)}:${threadId}`;
}

export function shouldSuppressTelegramError(params: {
  scopeKey: string;
  cooldownMs: number;
  errorMessage?: string;
}): boolean {
  const { scopeKey, cooldownMs, errorMessage } = params;
  const now = Date.now();
  readPersistentCooldowns(now);
  const messageKey = errorMessage ?? "";
  const scopeStore = errorCooldownStore.get(scopeKey);

  if (scopeStore) {
    pruneExpiredCooldowns(scopeStore, now);
    if (scopeStore.size === 0) {
      errorCooldownStore.delete(scopeKey);
    }
  }

  if (errorCooldownStore.size > 100) {
    for (const [scope, messageStore] of errorCooldownStore) {
      pruneExpiredCooldowns(messageStore, now);
      if (messageStore.size === 0) {
        errorCooldownStore.delete(scope);
      }
    }
  }

  const expiresAt = scopeStore?.get(messageKey);
  if (typeof expiresAt === "number" && expiresAt > now) {
    return true;
  }

  const nextScopeStore = scopeStore ?? new Map<string, number>();
  nextScopeStore.set(messageKey, now + cooldownMs);
  errorCooldownStore.set(scopeKey, nextScopeStore);
  writePersistentCooldowns(now);
  return false;
}

export function isSilentErrorPolicy(policy: TelegramErrorPolicy): boolean {
  return policy === "silent";
}

export function resetTelegramErrorPolicyStoreForTest() {
  errorCooldownStore.clear();
  errorCooldownStoreLoaded = false;
}
