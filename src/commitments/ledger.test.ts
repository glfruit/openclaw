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

  it("does not use omitted optional scope fields as wildcards", async () => {
    await appendCommitmentLedgerEntry({
      ledgerPath,
      input: {
        ...baseScope,
        summary: "check the Plan C validation result",
        creationSource: "explicit_user_request",
      },
    });

    await expect(
      queryActiveCommitments({
        ledgerPath,
        query: {
          agentId: baseScope.agentId,
          channel: baseScope.channel,
          groupId: baseScope.groupId,
          topicId: baseScope.topicId,
        },
      }),
    ).resolves.toEqual([]);
  });

  it("returns unavailable instead of none when query scope is insufficient", async () => {
    const result = await resolveActiveCommitmentLedgerRecall({
      ledgerPath,
      query: {
        agentId: baseScope.agentId,
        channel: baseScope.channel,
        groupId: baseScope.groupId,
      },
      queryText: "what did you commit to?",
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "insufficient_scope" });
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

  it("dedupes concurrent appends under the ledger lock", async () => {
    const commitments = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendCommitmentLedgerEntry({
          ledgerPath,
          input: {
            ...baseScope,
            summary: `check the Plan C validation result ${index}`,
            creationSource: "explicit_user_request",
            dedupeKey: "plan-c-validation",
          },
        }),
      ),
    );

    expect(new Set(commitments.map((commitment) => commitment.id)).size).toBe(1);
    await expect(readCommitmentLedger(ledgerPath)).resolves.toHaveLength(1);
  });

  it("surfaces malformed and invalid ledger lines", async () => {
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.writeFile(ledgerPath, '{"version":1,"type":"commitment.created"}\nnot-json\n');

    await expect(readCommitmentLedger(ledgerPath)).rejects.toThrow(/Invalid commitment.created/);
    await fs.writeFile(ledgerPath, "not-json\n");
    await expect(
      resolveActiveCommitmentLedgerRecall({
        ledgerPath,
        query: baseScope,
        queryText: "what did you commit to?",
      }),
    ).rejects.toThrow(/Invalid commitment ledger JSON/);
  });

  it("resolves the default ledger path under OPENCLAW_STATE_DIR", () => {
    expect(
      resolveCommitmentLedgerPath(undefined, { OPENCLAW_STATE_DIR: tmpDir } as NodeJS.ProcessEnv),
    ).toBe(path.join(tmpDir, "commitments", "commitment-ledger.jsonl"));
  });
});
