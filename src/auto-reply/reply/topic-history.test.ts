import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { MsgContext } from "../templating.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";
import {
  buildTopicHistoryRecallStructuredContext,
  isTopicHistoryContinuationQuery,
  resolveTelegramTopicHistoryRecall,
} from "./topic-history.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeSessionsDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-topic-history-"));
  tempDirs.push(dir);
  return dir;
}

async function writeTranscript(
  dir: string,
  name: string,
  params: {
    sessionId: string;
    sessionKey: string;
    agentId?: string | null;
    provider?: string;
    runtimeContext?: {
      chatId: string;
      topicId: string;
    };
    messages?: Array<{ role: "user" | "assistant" | "toolResult"; text: string }>;
  },
) {
  const file = path.join(dir, name);
  const lines = [
    { type: "session", id: params.sessionId, version: 1, timestamp: "2026-05-10T00:00:00.000Z" },
    {
      traceSchema: "openclaw-trajectory",
      type: "session.started",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      data: {
        ...(params.agentId === null ? {} : { agentId: params.agentId ?? "daily-collector" }),
        messageProvider: params.provider ?? "telegram",
      },
    },
    ...(params.runtimeContext
      ? [
          {
            type: "custom_message",
            customType: "openclaw.runtime-context",
            content: `Conversation info (untrusted metadata):\n\`\`\`json\n${JSON.stringify({ chat_id: params.runtimeContext.chatId, topic_id: params.runtimeContext.topicId })}\n\`\`\``,
          },
        ]
      : []),
    ...(params.messages ?? []).map((message, index) => ({
      type: "message",
      id: `m-${index}`,
      message: {
        role: message.role,
        content: [{ type: "text", text: message.text }],
        timestamp: 1_777_000_000_000 + index,
      },
    })),
  ];
  await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  return file;
}

function currentCtx(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram" as MsgContext["OriginatingChannel"],
    OriginatingTo: "telegram:-100111",
    MessageThreadId: 8,
    AccountId: "default",
    ChatType: "group",
    Body: "继续昨晚的问题",
    ...overrides,
  };
}

function currentStore(
  currentFile: string,
  sessionId = "current-session",
): Record<string, SessionEntry> {
  return {
    "agent:daily-collector:telegram:group:-100111:topic:8": {
      sessionId,
      updatedAt: Date.now(),
      sessionFile: currentFile,
      channel: "telegram",
      groupId: "-100111:topic:8",
      lastChannel: "telegram",
      lastTo: "telegram:-100111",
      lastThreadId: 8,
      lastAccountId: "default",
      chatType: "group",
      origin: {
        provider: "telegram",
        surface: "telegram",
        chatType: "group",
        to: "telegram:-100111",
        accountId: "default",
        threadId: 8,
      },
    },
  };
}

describe("topic history recall", () => {
  it("detects Chinese and English continuation references", () => {
    for (const text of [
      "昨晚这个继续",
      "你忘了之前的事",
      "continue from last time",
      "do you remember what we discussed yesterday?",
    ]) {
      expect(isTopicHistoryContinuationQuery(text)).toBe(true);
    }
    expect(isTopicHistoryContinuationQuery("请总结这段新材料")).toBe(false);
  });

  it("resolves same Telegram group/topic by metadata and does not cross-contaminate same topic id in another group", async () => {
    const dir = await makeSessionsDir();
    const currentFile = await writeTranscript(dir, "current-topic-8.jsonl", {
      sessionId: "current-session",
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
    });
    await writeTranscript(dir, "older-same-topic.jsonl", {
      sessionId: "older-session",
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
      messages: [
        { role: "user", text: "昨晚我们讨论 banana rollout" },
        { role: "assistant", text: "我答应今天继续检查 banana rollout。" },
      ],
    });
    await writeTranscript(dir, "other-group-same-topic.jsonl", {
      sessionId: "other-session",
      sessionKey: "agent:daily-collector:telegram:group:-100222:topic:8",
      messages: [{ role: "user", text: "other group secret should not appear" }],
    });

    const recall = await resolveTelegramTopicHistoryRecall({
      agentId: "daily-collector",
      ctx: currentCtx(),
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
      sessionId: "current-session",
      storePath: path.join(dir, "sessions.json"),
      sessionStore: currentStore(currentFile),
      query: "继续昨晚的事",
      currentSessionFile: currentFile,
      now: new Date("2026-05-10T09:00:00.000Z"),
    });

    const text = JSON.stringify(recall?.snippets);
    expect(text).toContain("banana rollout");
    expect(text).not.toContain("other group secret");
    expect(recall?.evidence.scope).toMatchObject({
      agentId: "daily-collector",
      channel: "telegram",
      groupId: "-100111",
      topicId: "8",
      accountId: "default",
    });
    expect(recall?.evidence.surface).toBe("session-transcript");
  });

  it("uses runtime-context metadata when older transcript lacks sessionKey but proves same agent", async () => {
    const dir = await makeSessionsDir();
    const currentFile = await writeTranscript(dir, "current-topic-8.jsonl", {
      sessionId: "current-session",
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
    });
    await writeTranscript(dir, "legacy-runtime-context.jsonl", {
      sessionId: "legacy-session",
      sessionKey: "",
      agentId: "daily-collector",
      runtimeContext: { chatId: "telegram:-100111", topicId: "8" },
      messages: [{ role: "user", text: "legacy runtime context match" }],
    });

    const recall = await resolveTelegramTopicHistoryRecall({
      agentId: "daily-collector",
      ctx: currentCtx(),
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
      sessionId: "current-session",
      storePath: path.join(dir, "sessions.json"),
      sessionStore: currentStore(currentFile),
      query: "之前说什么",
      currentSessionFile: currentFile,
    });

    expect(JSON.stringify(recall?.snippets)).toContain("legacy runtime context match");
  });

  it("skips legacy runtime-context transcript without same-agent proof", async () => {
    const dir = await makeSessionsDir();
    const currentFile = await writeTranscript(dir, "current-topic-8.jsonl", {
      sessionId: "current-session",
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
    });
    await writeTranscript(dir, "legacy-runtime-context-no-agent.jsonl", {
      sessionId: "legacy-session",
      sessionKey: "",
      agentId: null,
      runtimeContext: { chatId: "telegram:-100111", topicId: "8" },
      messages: [{ role: "user", text: "legacy no-agent secret should not appear" }],
    });

    const recall = await resolveTelegramTopicHistoryRecall({
      agentId: "daily-collector",
      ctx: currentCtx(),
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
      sessionId: "current-session",
      storePath: path.join(dir, "sessions.json"),
      sessionStore: currentStore(currentFile),
      query: "之前说什么",
      currentSessionFile: currentFile,
    });

    expect(JSON.stringify(recall?.snippets)).not.toContain("legacy no-agent secret");
    expect(recall?.snippets).toEqual([]);
  });

  it("does not recall another agent in the same Telegram group/topic", async () => {
    const dir = await makeSessionsDir();
    const currentFile = await writeTranscript(dir, "current-topic-8.jsonl", {
      sessionId: "current-session",
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
    });
    await writeTranscript(dir, "other-agent-same-topic.jsonl", {
      sessionId: "other-agent-session",
      sessionKey: "agent:daily-devops:telegram:group:-100111:topic:8",
      messages: [{ role: "user", text: "other agent secret should not appear" }],
    });

    const recall = await resolveTelegramTopicHistoryRecall({
      agentId: "daily-collector",
      ctx: currentCtx(),
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
      sessionId: "current-session",
      storePath: path.join(dir, "sessions.json"),
      sessionStore: currentStore(currentFile),
      query: "继续昨晚的事",
      currentSessionFile: currentFile,
    });

    expect(JSON.stringify(recall?.snippets)).not.toContain("other agent secret");
    expect(recall?.snippets).toEqual([]);
  });

  it("excludes current session id/file explicitly", async () => {
    const dir = await makeSessionsDir();
    const currentFile = await writeTranscript(dir, "current-topic-8.jsonl", {
      sessionId: "current-session",
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
      messages: [{ role: "user", text: "current turn must not be recalled" }],
    });
    const recall = await resolveTelegramTopicHistoryRecall({
      agentId: "daily-collector",
      ctx: currentCtx(),
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
      sessionId: "current-session",
      storePath: path.join(dir, "sessions.json"),
      sessionStore: currentStore(currentFile),
      query: "之前说什么",
      currentSessionFile: currentFile,
    });
    expect(recall?.snippets).toEqual([]);
    expect(recall?.evidence.resultCount).toBe(0);
  });

  it("bounds extraction and skips huge tool dumps", async () => {
    const dir = await makeSessionsDir();
    const currentFile = await writeTranscript(dir, "current-topic-8.jsonl", {
      sessionId: "current-session",
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
    });
    await writeTranscript(dir, "older.jsonl", {
      sessionId: "older-session",
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
      messages: [
        { role: "toolResult", text: "TOOL".repeat(5_000) },
        { role: "user", text: "u".repeat(900) },
        { role: "assistant", text: "assistant concise answer" },
      ],
    });
    const recall = await resolveTelegramTopicHistoryRecall({
      agentId: "daily-collector",
      ctx: currentCtx(),
      sessionKey: "agent:daily-collector:telegram:group:-100111:topic:8",
      sessionId: "current-session",
      storePath: path.join(dir, "sessions.json"),
      sessionStore: currentStore(currentFile),
      query: "last time continue",
      currentSessionFile: currentFile,
    });
    const text = JSON.stringify(recall?.snippets);
    expect(text).not.toContain("TOOLTOOL");
    expect(text).toContain("[truncated]");
    expect(text).toContain("assistant concise answer");
  });

  it("injects recall as untrusted/background structured context with surface-specific evidence discipline", async () => {
    const context = buildTopicHistoryRecallStructuredContext({
      snippets: [
        {
          role: "user",
          text: "昨晚的问题是 banana",
          file: "/tmp/older.jsonl",
          timestamp: 1_777_000_000_000,
        },
      ],
      evidence: {
        surface: "session-transcript",
        query: "继续昨晚",
        scope: {
          agentId: "daily-collector",
          channel: "telegram",
          groupId: "-100111",
          topicId: "8",
        },
        files: ["/tmp/older.jsonl"],
        resultCount: 1,
        timestamp: "2026-05-10T09:00:00.000Z",
      },
    });

    const prompt = buildInboundUserContextPrefix({
      ChatType: "group",
      OriginatingTo: "telegram:-100111",
      MessageThreadId: 8,
      UntrustedStructuredContext: [context],
    });

    expect(prompt).toContain("Topic history recall (untrusted metadata)");
    expect(prompt).toContain("Background/untrusted recall");
    expect(prompt).toContain('"surface": "session-transcript"');
    expect(prompt).not.toContain('"surface": "nowledge"');
    expect(prompt).toContain("Do not claim Nowledge");
  });
});
