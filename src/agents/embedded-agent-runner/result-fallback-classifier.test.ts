import { describe, expect, it } from "vitest";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./result-fallback-classifier.js";

describe("classifyEmbeddedAgentRunResultForModelFallback", () => {
  it("classifies Codex app-server incomplete turns after tool activity for side-effect recovery", () => {
    const classification = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai-codex",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            text:
              "OpenClaw detected an incomplete Codex turn after tool activity. " +
              "I stopped automatic retry to avoid repeating side effects; verify the current state before continuing.",
            isError: true,
          },
        ],
        meta: { durationMs: 1 },
      },
    });

    expect(classification).toMatchObject({
      reason: "format",
      code: "codex_app_server_incomplete_side_effect",
    });
  });

  it("classifies Codex app-server incomplete turns without side effects for normal fallback", () => {
    const classification = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai-codex",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            text:
              "OpenClaw detected an incomplete Codex turn before a final answer was available. " +
              "Please retry if needed.",
            isError: true,
          },
        ],
        meta: { durationMs: 1 },
      },
    });

    expect(classification).toMatchObject({
      reason: "format",
      code: "codex_app_server_incomplete_result",
    });
  });

  it("classifies aborted Codex app-server incomplete turns before a final answer", () => {
    const classification = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai-codex",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            text:
              "OpenClaw detected an incomplete Codex turn before a final answer was available. " +
              "Please retry if needed.",
            isError: true,
          },
        ],
        meta: {
          durationMs: 60_001,
          aborted: true,
          finalAssistantVisibleText:
            "OpenClaw detected an incomplete Codex turn before a final answer was available. Please retry if needed.",
        },
      },
    });

    expect(classification).toMatchObject({
      reason: "format",
      code: "codex_app_server_incomplete_result",
    });
  });

  it("does not fallback aborted non-Codex terminal errors", () => {
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "zai",
        model: "glm-5.1",
        result: {
          payloads: [{ text: "Request timed out.", isError: true }],
          meta: {
            durationMs: 60_001,
            aborted: true,
            finalAssistantVisibleText: "Request timed out.",
          },
        },
      }),
    ).toBeNull();
  });

  it("does not fallback Codex incomplete turns after tool evidence", () => {
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "openai-codex",
        model: "gpt-5.5",
        result: {
          payloads: [
            {
              text:
                "OpenClaw detected an incomplete Codex turn before a final answer was available. " +
                "Please retry if needed.",
              isError: true,
            },
          ],
          meta: {
            durationMs: 60_001,
            aborted: true,
            toolSummary: { calls: 1, tools: ["write"] },
          },
        },
      }),
    ).toBeNull();
  });

  it("does not fallback when sessions_spawn accepted a child session", () => {
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "mock-openai",
        model: "gpt-5.5",
        result: {
          meta: { durationMs: 1 },
          acceptedSessionSpawns: [
            {
              runId: "run-child",
              childSessionKey: "agent:qa:subagent:child",
            },
          ],
        },
      }),
    ).toBeNull();
  });
});
