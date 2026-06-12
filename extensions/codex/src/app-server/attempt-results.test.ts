// Codex tests cover attempt results plugin behavior.
import type { EmbeddedRunAttemptResult } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  buildCodexAppServerPromptTimeoutOutcome,
  classifyCodexAppServerRecoveryMetadata,
  collectTerminalAssistantText,
  isInvalidCodexImagePayloadError,
  resolveCodexAppServerReplayBlockedReason,
} from "./attempt-results.js";

function createResult(overrides: Partial<EmbeddedRunAttemptResult> = {}): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: {
      hadPotentialSideEffects: false,
      replaySafe: true,
    },
    itemLifecycle: {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
    ...overrides,
  } as EmbeddedRunAttemptResult;
}

describe("Codex app-server attempt results", () => {
  it("formats terminal assistant text", () => {
    expect(
      collectTerminalAssistantText(
        createResult({
          assistantTexts: [" first ", "second"],
        }),
      ),
    ).toBe("first \n\nsecond");
  });

  it("builds timeout outcomes from completion and side-effect evidence", () => {
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult(),
        turnCompletionIdleTimedOut: false,
      }),
    ).toBeUndefined();
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult(),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "progress",
      }),
    ).toBeUndefined();
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          toolMetas: [{ toolName: "exec" }],
          replayMetadata: {
            hadPotentialSideEffects: false,
            replaySafe: false,
          },
        }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "terminal",
      }),
    ).toBeUndefined();
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
        }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "completion",
      }),
    ).toEqual({
      message:
        "Codex 没有返回完整结束信号；OpenClaw 正在按最新状态恢复，请稍后重试或发送“怎么样了”查看进度。",
      sideEffectClass: "none",
      recoveryMode: "safe_fallback",
    });
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          replayMetadata: {
            hadPotentialSideEffects: true,
            replaySafe: false,
          },
        }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "completion",
      }),
    ).toEqual({
      message: "正在核验刚才执行到哪一步，避免重复执行已经发生的动作。",
      sideEffectClass: "mutating",
      recoveryMode: "blocked_side_effect",
      replayInvalid: true,
      livenessState: "abandoned",
    });
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          assistantTexts: ["I am changing the data model now..."],
        }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "completion",
      }),
    ).toEqual({
      message: "I am changing the data model now...",
      sideEffectClass: "none",
      recoveryMode: "safe_fallback",
      lastAssistantText: "I am changing the data model now...",
      replayInvalid: true,
      livenessState: "abandoned",
    });
    expect(
      buildCodexAppServerPromptTimeoutOutcome({
        result: createResult({
          toolMetas: [{ toolName: "exec" }],
          replayMetadata: {
            hadPotentialSideEffects: false,
            replaySafe: false,
          },
        }),
        turnCompletionIdleTimedOut: true,
        turnWatchTimeoutKind: "completion",
      }),
    ).toEqual({
      message: "正在核验刚才执行到哪一步，避免重复执行已经发生的动作。",
      sideEffectClass: "unknown",
      recoveryMode: "verify_only",
      lastToolSummary: "exec",
      replayInvalid: true,
      livenessState: "abandoned",
    });
  });

  it("classifies incomplete turn recovery metadata", () => {
    expect(classifyCodexAppServerRecoveryMetadata(createResult())).toEqual({
      sideEffectClass: "none",
      recoveryMode: "safe_fallback",
    });
    expect(
      classifyCodexAppServerRecoveryMetadata(
        createResult({
          toolMetas: [{ toolName: "read", meta: "path=README.md" }],
        }),
      ),
    ).toEqual({
      sideEffectClass: "read_only",
      recoveryMode: "safe_fallback",
      lastToolSummary: "read: path=README.md",
    });
    expect(
      classifyCodexAppServerRecoveryMetadata(
        createResult({
          toolMetas: [{ toolName: "dispatch_prepare", meta: "label=review" }],
        }),
      ),
    ).toEqual({
      sideEffectClass: "prepare_only",
      recoveryMode: "verify_only",
      lastToolSummary: "dispatch_prepare: label=review",
    });
    expect(
      classifyCodexAppServerRecoveryMetadata(
        createResult({
          toolMetas: [{ toolName: "bash", meta: "rg TODO src" }],
        }),
      ),
    ).toEqual({
      sideEffectClass: "read_only",
      recoveryMode: "safe_fallback",
      lastToolSummary: "bash: rg TODO src",
    });
    expect(
      classifyCodexAppServerRecoveryMetadata(
        createResult({
          toolMetas: [{ toolName: "bash", meta: "rg TODO src; python scripts/mutate.py" }],
        }),
      ),
    ).toEqual({
      sideEffectClass: "unknown",
      recoveryMode: "verify_only",
      lastToolSummary: "bash: rg TODO src; python scripts/mutate.py",
    });
    expect(
      classifyCodexAppServerRecoveryMetadata(
        createResult({
          toolMetas: [{ toolName: "bash", meta: "find . -exec rm {} \\;" }],
        }),
      ),
    ).toEqual({
      sideEffectClass: "unknown",
      recoveryMode: "verify_only",
      lastToolSummary: "bash: find . -exec rm {} \\;",
    });
    expect(
      classifyCodexAppServerRecoveryMetadata(
        createResult({
          didSendViaMessagingTool: true,
          messagingToolSentTexts: ["sent"],
        }),
      ).sideEffectClass,
    ).toBe("external_delivery");
  });

  it("classifies replay blocked reasons", () => {
    expect(resolveCodexAppServerReplayBlockedReason(createResult())).toBeUndefined();
    expect(
      resolveCodexAppServerReplayBlockedReason(
        createResult({
          replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        }),
      ),
    ).toBe("potential_side_effect");
    expect(
      resolveCodexAppServerReplayBlockedReason(
        createResult({
          assistantTexts: ["visible"],
        }),
      ),
    ).toBe("assistant_output");
    expect(
      resolveCodexAppServerReplayBlockedReason(
        createResult({
          toolMetas: [{ toolName: "bash" }],
        }),
      ),
    ).toBeUndefined();
    expect(
      resolveCodexAppServerReplayBlockedReason(
        createResult({
          replayMetadata: { hadPotentialSideEffects: false, replaySafe: false },
          toolMetas: [{ toolName: "bash" }],
        }),
      ),
    ).toBe("tool_activity");
    expect(
      resolveCodexAppServerReplayBlockedReason(
        createResult({
          itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 },
        }),
      ),
    ).toBe("active_item");
  });

  it("recognizes invalid image payload errors without matching unsupported image input", () => {
    expect(isInvalidCodexImagePayloadError("invalid_image_url")).toBe(true);
    expect(isInvalidCodexImagePayloadError("malformed-base64 image payload")).toBe(true);
    expect(isInvalidCodexImagePayloadError("unsupported image input")).toBe(false);
  });
});
