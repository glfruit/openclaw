import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createMoonshotModel(): Model<"openai-completions"> {
  return {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    api: "openai-completions",
    provider: "moonshotai",
    baseUrl: "https://api.moonshot.cn/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 32_768,
  };
}

function createAssistantToolCallMessage(): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "moonshotai",
    model: "kimi-k2.6",
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: "exec",
        arguments: { command: "pwd" },
      },
    ],
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  };
}

describe("OpenAI-compatible completions provider compatibility", () => {
  it("backfills reasoning_content for Moonshot/Kimi replayed assistant tool calls", async () => {
    let capturedPayload: unknown;
    const context: Context = {
      messages: [
        { role: "user", content: "run pwd", timestamp: 1 },
        createAssistantToolCallMessage(),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "exec",
          content: [{ type: "text", text: "/tmp" }],
          isError: false,
          timestamp: 3,
        },
        { role: "user", content: "continue", timestamp: 4 },
      ],
    };

    const stream = streamOpenAICompletions(createMoonshotModel(), context, {
      apiKey: "test-key",
      reasoningEffort: "low",
      onPayload: (payload) => {
        capturedPayload = payload;
        throw new Error("stop before network");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedPayload).toMatchObject({
      messages: [
        { role: "user", content: "run pwd" },
        {
          role: "assistant",
          reasoning_content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "exec", arguments: '{"command":"pwd"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "/tmp" },
        { role: "user", content: "continue" },
      ],
    });
  });
});
