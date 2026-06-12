/**
 * Result-shaping helpers for Codex app-server attempt terminal text, replay
 * safety, startup failures, and malformed image errors.
 */
import type {
  AgentMessage,
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexSystemPromptReport } from "./attempt-context.js";
import type { CodexAttemptTurnWatchTimeoutKind } from "./attempt-turn-watches.js";

const CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_USER_MESSAGE =
  "Codex 没有返回完整结束信号；OpenClaw 正在按最新状态恢复，请稍后重试或发送“怎么样了”查看进度。";
const CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_SIDE_EFFECT_USER_MESSAGE =
  "正在核验刚才执行到哪一步，避免重复执行已经发生的动作。";

const READ_ONLY_TOOL_NAMES = new Set([
  "find",
  "grep",
  "list",
  "ls",
  "read",
  "search",
  "web_fetch",
  "web_search",
]);

const EXTERNAL_DELIVERY_TOOL_NAMES = new Set([
  "sessions_send",
  "send_message",
  "send_email",
  "telegram_send",
  "feishu_send",
]);

const MUTATING_TOOL_NAMES = new Set([
  "apply_patch",
  "edit",
  "image_generate",
  "process",
  "sessions_spawn",
  "write",
]);

const READ_ONLY_SHELL_COMMAND_RE =
  /^\s*(?:g?timeout\s+\d+\s+)?(?:rg|grep|sed|awk|cat|tail|head|ls|find|pwd|wc|jq|python3?\s+-m\s+json\.tool)\b/u;
const PREPARE_ONLY_TOOL_RE = /(?:^|[_-])prepare(?:[_-]|$)/iu;

type CodexAppServerRecoveryMetadata = {
  sideEffectClass: NonNullable<
    NonNullable<EmbeddedRunAttemptResult["promptTimeoutOutcome"]>["sideEffectClass"]
  >;
  recoveryMode: NonNullable<
    NonNullable<EmbeddedRunAttemptResult["promptTimeoutOutcome"]>["recoveryMode"]
  >;
  lastAssistantText?: string;
  lastToolSummary?: string;
};

/** Joins terminal assistant text blocks into the final attempt answer. */
export function collectTerminalAssistantText(result: EmbeddedRunAttemptResult): string {
  return result.assistantTexts.join("\n\n").trim();
}

/**
 * Builds the user-facing timeout outcome when Codex stops without a terminal
 * turn event.
 */
export function buildCodexAppServerPromptTimeoutOutcome(params: {
  result: EmbeddedRunAttemptResult;
  turnCompletionIdleTimedOut: boolean;
  turnWatchTimeoutKind?: CodexAttemptTurnWatchTimeoutKind;
}): EmbeddedRunAttemptResult["promptTimeoutOutcome"] {
  if (!params.turnCompletionIdleTimedOut) {
    return undefined;
  }
  if (params.turnWatchTimeoutKind !== undefined && params.turnWatchTimeoutKind !== "completion") {
    return undefined;
  }
  const replayBlockedReason = resolveCodexAppServerReplayBlockedReason(params.result);
  const recovery = classifyCodexAppServerRecoveryMetadata(params.result);
  const completionIdleTimeoutHadPotentialSideEffects =
    replayBlockedReason === "tool_activity" ||
    replayBlockedReason === "potential_side_effect" ||
    replayBlockedReason === "active_item";
  return {
    message:
      recovery.lastAssistantText && replayBlockedReason === "assistant_output"
        ? recovery.lastAssistantText
        : completionIdleTimeoutHadPotentialSideEffects
          ? CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_SIDE_EFFECT_USER_MESSAGE
          : CODEX_APP_SERVER_MISSING_TERMINAL_EVENT_USER_MESSAGE,
    sideEffectClass: recovery.sideEffectClass,
    recoveryMode: recovery.recoveryMode,
    ...(recovery.lastAssistantText ? { lastAssistantText: recovery.lastAssistantText } : {}),
    ...(recovery.lastToolSummary ? { lastToolSummary: recovery.lastToolSummary } : {}),
    ...(replayBlockedReason
      ? {
          replayInvalid: true,
          livenessState: "abandoned" as const,
        }
      : {}),
  };
}

/** Explains why an incomplete app-server turn cannot be safely replayed. */
export function resolveCodexAppServerReplayBlockedReason(
  result: EmbeddedRunAttemptResult,
):
  | NonNullable<EmbeddedRunAttemptResult["codexAppServerFailure"]>["replayBlockedReason"]
  | undefined {
  if (result.replayMetadata.hadPotentialSideEffects) {
    return "potential_side_effect";
  }
  if (result.assistantTexts.some((text) => text.trim().length > 0)) {
    return "assistant_output";
  }
  if (result.toolMetas.length > 0 && !result.replayMetadata.replaySafe) {
    return "tool_activity";
  }
  if (result.clientToolCalls || result.lastToolError || result.didSendDeterministicApprovalPrompt) {
    return "tool_activity";
  }
  if (result.itemLifecycle.startedCount > 0 || result.itemLifecycle.activeCount > 0) {
    return "active_item";
  }
  return undefined;
}

/** Classifies incomplete Codex turns so callers can recover without blind replay. */
export function classifyCodexAppServerRecoveryMetadata(
  result: EmbeddedRunAttemptResult,
): CodexAppServerRecoveryMetadata {
  const lastAssistantText = [...result.assistantTexts]
    .reverse()
    .map((text) => text.trim())
    .find(Boolean);
  const lastToolSummary = summarizeRecentTools(result);
  if (
    result.didSendViaMessagingTool ||
    result.messagingToolSentTexts.length > 0 ||
    result.messagingToolSentMediaUrls.length > 0 ||
    result.messagingToolSentTargets.length > 0 ||
    result.toolMetas.some((tool) => EXTERNAL_DELIVERY_TOOL_NAMES.has(tool.toolName))
  ) {
    return {
      sideEffectClass: "external_delivery",
      recoveryMode: "blocked_side_effect",
      ...(lastAssistantText ? { lastAssistantText } : {}),
      ...(lastToolSummary ? { lastToolSummary } : {}),
    };
  }
  if (result.replayMetadata.hadPotentialSideEffects) {
    return {
      sideEffectClass: "mutating",
      recoveryMode: "blocked_side_effect",
      ...(lastAssistantText ? { lastAssistantText } : {}),
      ...(lastToolSummary ? { lastToolSummary } : {}),
    };
  }
  if (result.toolMetas.length === 0 && !result.clientToolCalls && !result.lastToolError) {
    return {
      sideEffectClass: "none",
      recoveryMode: "safe_fallback",
      ...(lastAssistantText ? { lastAssistantText } : {}),
    };
  }
  if (result.toolMetas.length > 0 && result.toolMetas.every(isReadOnlyToolMeta)) {
    return {
      sideEffectClass: "read_only",
      recoveryMode: "safe_fallback",
      ...(lastAssistantText ? { lastAssistantText } : {}),
      ...(lastToolSummary ? { lastToolSummary } : {}),
    };
  }
  if (result.toolMetas.length > 0 && result.toolMetas.every(isPrepareOnlyToolMeta)) {
    return {
      sideEffectClass: "prepare_only",
      recoveryMode: "verify_only",
      ...(lastAssistantText ? { lastAssistantText } : {}),
      ...(lastToolSummary ? { lastToolSummary } : {}),
    };
  }
  if (
    result.toolMetas.some((tool) => MUTATING_TOOL_NAMES.has(tool.toolName) || tool.asyncStarted)
  ) {
    return {
      sideEffectClass: "mutating",
      recoveryMode: "blocked_side_effect",
      ...(lastAssistantText ? { lastAssistantText } : {}),
      ...(lastToolSummary ? { lastToolSummary } : {}),
    };
  }
  return {
    sideEffectClass: "unknown",
    recoveryMode: "verify_only",
    ...(lastAssistantText ? { lastAssistantText } : {}),
    ...(lastToolSummary ? { lastToolSummary } : {}),
  };
}

function isReadOnlyToolMeta(tool: { toolName: string; meta?: string }): boolean {
  if (READ_ONLY_TOOL_NAMES.has(tool.toolName)) {
    return true;
  }
  if ((tool.toolName === "bash" || tool.toolName === "exec") && tool.meta) {
    return READ_ONLY_SHELL_COMMAND_RE.test(tool.meta);
  }
  return false;
}

function isPrepareOnlyToolMeta(tool: { toolName: string; meta?: string }): boolean {
  return PREPARE_ONLY_TOOL_RE.test(tool.toolName) || PREPARE_ONLY_TOOL_RE.test(tool.meta ?? "");
}

function summarizeRecentTools(result: EmbeddedRunAttemptResult): string | undefined {
  const names = result.toolMetas
    .slice(-3)
    .map((tool) => (tool.meta ? `${tool.toolName}: ${tool.meta}` : tool.toolName))
    .map((text) => text.trim())
    .filter(Boolean);
  return names.length > 0 ? names.join("; ") : undefined;
}

/** Builds an attempt result for failures before the app-server turn starts. */
export function buildCodexTurnStartFailureResult(params: {
  params: EmbeddedRunAttemptParams;
  message: string;
  messagesSnapshot: AgentMessage[];
  systemPromptReport: CodexSystemPromptReport;
}): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    promptError: params.message,
    promptErrorSource: "prompt",
    sessionIdUsed: params.params.sessionId,
    messagesSnapshot: params.messagesSnapshot,
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
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
    systemPromptReport: params.systemPromptReport,
  };
}

/** Detects app-server errors caused by invalid image payload data. */
export function isInvalidCodexImagePayloadError(message: unknown): boolean {
  if (typeof message !== "string" || !message.trim()) {
    return false;
  }
  const normalizedMessage = message.replace(/[_-]+/gu, " ");
  return (
    /\b(?:invalid|malformed)\b[\s\S]{0,120}\b(?:image|image url|base64)\b/iu.test(
      normalizedMessage,
    ) ||
    /\b(?:image|image url|base64)\b[\s\S]{0,120}\b(?:invalid|malformed)\b/iu.test(normalizedMessage)
  );
}
