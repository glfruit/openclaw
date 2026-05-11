import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCommitmentLedgerEntry,
  classifyExplicitCommitmentCreationIntent,
  queryActiveCommitments,
  readCommitmentLedger,
  resolveActiveCommitmentLedgerRecall,
  resolveCommitmentLedgerPath,
  updateCommitmentLedgerStatus,
} from "./ledger.js";

let tmpDir = "";
let ledgerPath = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commitment-ledger-"));
  ledgerPath = path.join(tmpDir, "commitments", "commitment-ledger.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const baseScope = {
  agentId: "daily-devops",
  channel: "telegram",
  accountId: "bot-main",
  groupId: "-1003395996452",
  topicId: "2",
};

describe("commitment ledger v1", () => {
  it("creates an explicit commitment and stores only summary/references", async () => {
    const intent = classifyExplicitCommitmentCreationIntent({
      userText: "Please remember you committed to review the deployment notes tomorrow",
    });

    expect(intent).toMatchObject({ kind: "explicit", creationSource: "explicit_user_request" });
    if (intent.kind !== "explicit") {
      throw new Error("expected explicit intent");
    }

    const commitment = await appendCommitmentLedgerEntry({
      ledgerPath,
      input: {
        ...baseScope,
        summary: intent.summary,
        creationSource: intent.creationSource,
        references: [{ surface: "user-confirmation", id: "msg-1", note: "explicit request" }],
        now: new Date("2026-05-12T00:00:00.000Z"),
      },
    });

    expect(commitment).toMatchObject({
      status: "active",
      summary: "review the deployment notes tomorrow",
      creationSource: "explicit_user_request",
      groupId: baseScope.groupId,
      topicId: baseScope.topicId,
    });
    const raw = await fs.readFile(ledgerPath, "utf-8");
    expect(raw).toContain("commitment.created");
    expect(raw).not.toContain("sourceUserText");
    expect(raw).not.toContain("sourceAssistantText");
    const stat = await fs.stat(ledgerPath);
    expect(stat.mode & 0o077).toBe(0);
  });

  it("does not treat brainstorming as a commitment", () => {
    expect(
      classifyExplicitCommitmentCreationIntent({
        userText: "Let's brainstorm options for follow-up checks",
      }),
    ).toEqual({ kind: "none", reason: "brainstorming" });
  });

  it("does not treat maybe-later language as a commitment", () => {
    expect(
      classifyExplicitCommitmentCreationIntent({
        userText: "Maybe later we can have you follow up on this",
      }),
    ).toEqual({ kind: "none", reason: "tentative" });
  });

  it("does not create commitment from assistant willingness without user approval", () => {
    expect(
      classifyExplicitCommitmentCreationIntent({
        userText: "Can this be handled?",
        assistantText: "I can do that.",
      }),
    ).toEqual({ kind: "none", reason: "assistant_only" });
  });

  it("finds active commitments for the same agent/group/topic", async () => {
    await appendCommitmentLedgerEntry({
      ledgerPath,
      input: {
        ...baseScope,
        summary: "check the Plan C validation result",
        creationSource: "explicit_user_request",
        now: new Date("2026-05-12T00:00:00.000Z"),
      },
    });

    const result = await resolveActiveCommitmentLedgerRecall({
      ledgerPath,
      query: baseScope,
      queryText: "what did you commit to?",
      now: new Date("2026-05-12T00:01:00.000Z"),
    });

    expect(result.status).toBe("match");
    expect(result.evidence).toMatchObject({
      surface: "commitment-ledger",
      resultCount: 1,
      scope: baseScope,
    });
  });

  it("does not match a different topic", async () => {
    await appendCommitmentLedgerEntry({
      ledgerPath,
      input: {
        ...baseScope,
        summary: "check the Plan C validation result",
        creationSource: "explicit_user_request",
      },
    });

    await expect(
      queryActiveCommitments({ ledgerPath, query: { ...baseScope, topicId: "9" } }),
    ).resolves.toEqual([]);
  });

  it("does not match a different agent", async () => {
    await appendCommitmentLedgerEntry({
      ledgerPath,
      input: {
        ...baseScope,
        summary: "check the Plan C validation result",
        creationSource: "explicit_user_request",
      },
    });

    await expect(
      queryActiveCommitments({ ledgerPath, query: { ...baseScope, agentId: "research" } }),
    ).resolves.toEqual([]);
  });

  it("fails closed when multiple active commitments match", async () => {
    await appendCommitmentLedgerEntry({
      ledgerPath,
      input: {
        ...baseScope,
        summary: "check the Plan C validation result",
        creationSource: "explicit_user_request",
        dedupeKey: "plan-c-validation",
      },
    });
    await appendCommitmentLedgerEntry({
      ledgerPath,
      input: {
        ...baseScope,
        summary: "report the deferred lifecycle hook gaps",
        creationSource: "explicit_user_request",
        dedupeKey: "lifecycle-gaps",
      },
    });

    const result = await resolveActiveCommitmentLedgerRecall({
      ledgerPath,
      query: baseScope,
      queryText: "continue",
    });

    expect(result).toMatchObject({ status: "ambiguous", count: 2 });
    expect(result.evidence).toMatchObject({ surface: "commitment-ledger", resultCount: 2 });
  });

  it("dedupes active commitments and hides completed commitments from active queries", async () => {
    const first = await appendCommitmentLedgerEntry({
      ledgerPath,
      input: {
        ...baseScope,
        summary: "check the Plan C validation result",
        creationSource: "explicit_user_request",
        dedupeKey: "plan-c-validation",
      },
    });
    const second = await appendCommitmentLedgerEntry({
      ledgerPath,
      input: {
        ...baseScope,
        summary: "check the Plan C validation result again",
        creationSource: "explicit_user_request",
        dedupeKey: "plan-c-validation",
      },
    });
    expect(second.id).toBe(first.id);

    await updateCommitmentLedgerStatus({ ledgerPath, id: first.id, status: "completed" });
    await expect(queryActiveCommitments({ ledgerPath, query: baseScope })).resolves.toEqual([]);
    await expect(readCommitmentLedger(ledgerPath)).resolves.toHaveLength(1);
  });

  it("resolves the default ledger path under OPENCLAW_STATE_DIR", () => {
    expect(
      resolveCommitmentLedgerPath(undefined, { OPENCLAW_STATE_DIR: tmpDir } as NodeJS.ProcessEnv),
    ).toBe(path.join(tmpDir, "commitments", "commitment-ledger.jsonl"));
  });
});
