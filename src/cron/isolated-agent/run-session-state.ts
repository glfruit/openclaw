import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { resolveCronSession } from "./session.js";

type MutableSessionStore = Record<string, SessionEntry>;

export type MutableCronSessionEntry = SessionEntry;
export type MutableCronSession = ReturnType<typeof resolveCronSession> & {
  store: MutableSessionStore;
  sessionEntry: MutableCronSessionEntry;
};
export type CronLiveSelection = LiveSessionModelSelection;

type UpdateSessionStore = (
  storePath: string,
  update: (store: MutableSessionStore) => void,
) => Promise<void>;

export type PersistCronSessionEntry = () => Promise<void>;

export function createPersistCronSessionEntry(params: {
  isFastTestEnv: boolean;
  cronSession: MutableCronSession;
  agentSessionKey: string;
  runSessionKey: string;
  updateSessionStore: UpdateSessionStore;
}): PersistCronSessionEntry {
  return async () => {
    if (params.isFastTestEnv) {
      return;
    }
    params.cronSession.store[params.agentSessionKey] = params.cronSession.sessionEntry;
    if (params.runSessionKey !== params.agentSessionKey) {
      params.cronSession.store[params.runSessionKey] = params.cronSession.sessionEntry;
    }
    await params.updateSessionStore(params.cronSession.storePath, (store) => {
      store[params.agentSessionKey] = params.cronSession.sessionEntry;
      if (params.runSessionKey !== params.agentSessionKey) {
        store[params.runSessionKey] = params.cronSession.sessionEntry;
      }
    });
  };
}

export async function persistCronSkillsSnapshotIfChanged(params: {
  isFastTestEnv: boolean;
  cronSession: MutableCronSession;
  skillsSnapshot: SkillSnapshot;
  nowMs: number;
  persistSessionEntry: PersistCronSessionEntry;
}) {
  if (
    params.isFastTestEnv ||
    params.skillsSnapshot === params.cronSession.sessionEntry.skillsSnapshot
  ) {
    return;
  }
  params.cronSession.sessionEntry = {
    ...params.cronSession.sessionEntry,
    updatedAt: params.nowMs,
    skillsSnapshot: params.skillsSnapshot,
  };
  await params.persistSessionEntry();
}

export function markCronSessionPreRun(params: {
  entry: MutableCronSessionEntry;
  provider: string;
  model: string;
}) {
  params.entry.modelProvider = params.provider;
  params.entry.model = params.model;
  params.entry.systemSent = true;
}

export function markCronSessionRunStarted(params: {
  entry: MutableCronSessionEntry;
  startedAt?: number;
}) {
  const startedAt = params.startedAt ?? Date.now();
  params.entry.updatedAt = startedAt;
  params.entry.status = "running";
  params.entry.startedAt = startedAt;
  params.entry.endedAt = undefined;
  params.entry.runtimeMs = undefined;
  params.entry.abortedLastRun = false;
}

export function markCronSessionRunFinished(params: {
  entry: MutableCronSessionEntry;
  status: Exclude<NonNullable<MutableCronSessionEntry["status"]>, "running">;
  startedAt?: number;
  endedAt?: number;
}) {
  const endedAt = params.endedAt ?? Date.now();
  const startedAt = params.startedAt ?? params.entry.startedAt;
  params.entry.updatedAt = endedAt;
  params.entry.status = params.status;
  params.entry.startedAt = startedAt;
  params.entry.endedAt = endedAt;
  params.entry.runtimeMs =
    typeof startedAt === "number" && Number.isFinite(startedAt)
      ? Math.max(0, endedAt - startedAt)
      : undefined;
  params.entry.abortedLastRun = params.status === "killed";
}

export function syncCronSessionLiveSelection(params: {
  entry: MutableCronSessionEntry;
  liveSelection: CronLiveSelection;
}) {
  params.entry.modelProvider = params.liveSelection.provider;
  params.entry.model = params.liveSelection.model;
  if (params.liveSelection.authProfileId) {
    params.entry.authProfileOverride = params.liveSelection.authProfileId;
    params.entry.authProfileOverrideSource = params.liveSelection.authProfileIdSource;
    if (params.liveSelection.authProfileIdSource === "auto") {
      params.entry.authProfileOverrideCompactionCount = params.entry.compactionCount ?? 0;
    } else {
      delete params.entry.authProfileOverrideCompactionCount;
    }
    return;
  }
  delete params.entry.authProfileOverride;
  delete params.entry.authProfileOverrideSource;
  delete params.entry.authProfileOverrideCompactionCount;
}
