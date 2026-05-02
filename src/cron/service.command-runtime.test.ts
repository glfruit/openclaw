import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronServiceDeps } from "./service.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronJobCreate } from "./types.js";

describe("cron command runtime", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-command-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createCron() {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      cronEnabled: true,
      storePath: path.join(tmpDir, "cron", "jobs.json"),
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: runIsolatedAgentJob as CronServiceDeps["runIsolatedAgentJob"],
    });
    return { cron, runIsolatedAgentJob };
  }

  function commandJob(payload: CronJobCreate["payload"]): CronJobCreate {
    return {
      name: "command-smoke",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload,
      delivery: { mode: "none" },
    };
  }

  it("runs command payloads directly without invoking an isolated agent", async () => {
    const { cron, runIsolatedAgentJob } = createCron();
    const job = await cron.add(
      commandJob({
        kind: "command",
        command: process.execPath,
        args: ["-e", "console.log('ATLAS_INGEST_OK source=dropbox new=0 updated=0')"],
        successRegex: "ATLAS_INGEST_OK",
        summaryRegex: "^(ATLAS_INGEST_OK .*)$",
        outputMode: "lastLine",
      }),
    );

    await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

    const updated = cron.getJob(job.id);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(updated?.state.lastRunStatus).toBe("ok");
    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastError).toBeUndefined();
    expect(updated?.state.consecutiveSkipped).toBe(0);
  });

  it("marks command payloads failed when failureRegex matches", async () => {
    const { cron } = createCron();
    const job = await cron.add(
      commandJob({
        kind: "command",
        command: process.execPath,
        args: ["-e", "console.error('ATLAS_INGEST_FAIL source=dropbox reason=bad')"],
        failureRegex: "ATLAS_INGEST_FAIL",
        summaryRegex: "^(ATLAS_INGEST_FAIL .*)$",
        outputMode: "lastLine",
      }),
    );

    await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

    const updated = cron.getJob(job.id);
    expect(updated?.state.lastRunStatus).toBe("error");
    expect(updated?.state.lastStatus).toBe("error");
    expect(updated?.state.lastError).toContain("ATLAS_INGEST_FAIL source=dropbox reason=bad");
    expect(updated?.state.consecutiveErrors).toBe(1);
  });

  it("marks command payloads failed when successRegex does not match", async () => {
    const { cron } = createCron();
    const job = await cron.add(
      commandJob({
        kind: "command",
        command: process.execPath,
        args: ["-e", "console.log('NO_MATCH')"],
        successRegex: "ATLAS_INGEST_OK",
        outputMode: "lastLine",
      }),
    );

    await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

    const updated = cron.getJob(job.id);
    expect(updated?.state.lastRunStatus).toBe("error");
    expect(updated?.state.lastError).toBe("NO_MATCH");
  });
});
