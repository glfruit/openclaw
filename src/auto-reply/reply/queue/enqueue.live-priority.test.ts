import { describe, expect, it } from "vitest";
import { enqueueFollowupRun } from "./enqueue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./state.js";
import type { FollowupRun, QueueSettings } from "./types.js";

function buildRun(prompt: string, priority: FollowupRun["priority"]): FollowupRun {
  return {
    prompt,
    enqueuedAt: Date.now(),
    lane: priority === "live" ? "live_user" : "cron",
    priority,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  };
}

describe("enqueueFollowupRun live priority", () => {
  it("keeps live_user followups ahead of autonomous backlog under a capped new-drop queue", () => {
    const key = "live-priority-test";
    clearFollowupQueue(key);
    const settings: QueueSettings = { mode: "followup", cap: 1, dropPolicy: "new" };

    expect(enqueueFollowupRun(key, buildRun("cron tick", "autonomous"), settings, "none")).toBe(
      true,
    );
    expect(enqueueFollowupRun(key, buildRun("human asks", "live"), settings, "none")).toBe(true);

    const queue = getExistingFollowupQueue(key);
    expect(queue?.items).toHaveLength(1);
    expect(queue?.items[0]?.prompt).toBe("human asks");
    expect(queue?.items[0]?.priority).toBe("live");
    clearFollowupQueue(key);
  });
});
