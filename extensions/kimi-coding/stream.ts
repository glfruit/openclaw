import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  streamWithPayloadPatch,
  wrapStreamMessageObjects,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

const TOOL_CALLS_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOOL_CALLS_SECTION_END = "<|tool_calls_section_end|>";
const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
const TOOL_CALL_ARGUMENT_BEGIN = "<|tool_call_argument_begin|>";
const TOOL_CALL_END = "<|tool_call_end|>";

type KimiToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type KimiThinkingType = "enabled" | "disabled";
type KimiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeKimiThinkingType(value: unknown): KimiThinkingType | undefined {
  if (typeof value === "boolean") {
    return value ? "enabled" : "disabled";
  }
  if (typeof value === "string") {
    const normalized = normalizeOptionalLowercaseString(value);
    if (!normalized) {
      return undefined;
    }
    if (["enabled", "enable", "on", "true"].includes(normalized)) {
      return "enabled";
    }
    if (["disabled", "disable", "off", "false"].includes(normalized)) {
      return "disabled";
    }
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeKimiThinkingType((value as Record<string, unknown>).type);
  }
  return undefined;
}

export function resolveKimiThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: KimiThinkingLevel;
}): KimiThinkingType {
  const configured = normalizeKimiThinkingType(params.configuredThinking);
  if (configured) {
    return configured;
  }
  if (!params.thinkingLevel || params.thinkingLevel === "off") {
    return "disabled";
  }
  return "enabled";
}

function isKimiK26PayloadModel(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "k2.6" || normalized === "kimi-k2.6";
}

function isToolCallLikeBlock(block: unknown): boolean {
  if (!isRecord(block)) {
    return false;
  }
  return ["toolCall", "tool_call", "toolUse", "tool_use"].includes(String(block.type));
}

function assistantMessageHasToolCalls(message: Record<string, unknown>): boolean {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return true;
  }
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    return true;
  }
  return Array.isArray(message.content) && message.content.some(isToolCallLikeBlock);
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function extractReplayReasoningContent(message: Record<string, unknown>): string {
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      const value = firstNonEmptyString(block.thinking, block.reasoning_content, block.text);
      if (value) {
        return value;
      }
    }
  }
  const value = firstNonEmptyString(message.reasoning_content, message.reasoning, message.text);
  return value ?? "Tool call replay.";
}

function ensureKimiToolCallReplayReasoningContent(payloadObj: Record<string, unknown>): void {
  const messages = payloadObj.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    if (!assistantMessageHasToolCalls(message)) {
      continue;
    }
    if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
      continue;
    }
    message.reasoning_content = extractReplayReasoningContent(message);
  }
}

function stripTaggedToolCallCounter(value: string): string {
  return value.trim().replace(/:\d+$/, "");
}

function parseKimiTaggedToolCalls(text: string): KimiToolCallBlock[] | null {
  const trimmed = text.trim();
  // Kimi emits tagged tool-call sections as standalone text blocks on this path.
  if (!trimmed.startsWith(TOOL_CALLS_SECTION_BEGIN) || !trimmed.endsWith(TOOL_CALLS_SECTION_END)) {
    return null;
  }

  let cursor = TOOL_CALLS_SECTION_BEGIN.length;
  const sectionEndIndex = trimmed.length - TOOL_CALLS_SECTION_END.length;
  const toolCalls: KimiToolCallBlock[] = [];

  while (cursor < sectionEndIndex) {
    while (cursor < sectionEndIndex && /\s/.test(trimmed[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= sectionEndIndex) {
      break;
    }
    if (!trimmed.startsWith(TOOL_CALL_BEGIN, cursor)) {
      return null;
    }

    const nameStart = cursor + TOOL_CALL_BEGIN.length;
    const argMarkerIndex = trimmed.indexOf(TOOL_CALL_ARGUMENT_BEGIN, nameStart);
    if (argMarkerIndex < 0 || argMarkerIndex >= sectionEndIndex) {
      return null;
    }

    const rawId = trimmed.slice(nameStart, argMarkerIndex).trim();
    if (!rawId) {
      return null;
    }

    const argsStart = argMarkerIndex + TOOL_CALL_ARGUMENT_BEGIN.length;
    const callEndIndex = trimmed.indexOf(TOOL_CALL_END, argsStart);
    if (callEndIndex < 0 || callEndIndex > sectionEndIndex) {
      return null;
    }

    const rawArgs = trimmed.slice(argsStart, callEndIndex).trim();
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      return null;
    }
    if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      return null;
    }

    const name = stripTaggedToolCallCounter(rawId);
    if (!name) {
      return null;
    }

    toolCalls.push({
      type: "toolCall",
      id: rawId,
      name,
      arguments: parsedArgs as Record<string, unknown>,
    });

    cursor = callEndIndex + TOOL_CALL_END.length;
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

function rewriteKimiTaggedToolCallsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") {
    return;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return;
  }

  let changed = false;
  const nextContent: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      nextContent.push(block);
      continue;
    }
    const typedBlock = block as { type?: unknown; text?: unknown };
    if (typedBlock.type !== "text" || typeof typedBlock.text !== "string") {
      nextContent.push(block);
      continue;
    }

    const parsed = parseKimiTaggedToolCalls(typedBlock.text);
    if (!parsed) {
      nextContent.push(block);
      continue;
    }

    nextContent.push(...parsed);
    changed = true;
  }

  if (!changed) {
    return;
  }

  (message as { content: unknown[] }).content = nextContent;
  const typedMessage = message as { stopReason?: unknown };
  if (typedMessage.stopReason === "stop") {
    typedMessage.stopReason = "toolUse";
  }
}

export function createKimiToolCallMarkupWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const maybeStream = underlying(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapStreamMessageObjects(stream, rewriteKimiTaggedToolCallsInMessage),
      );
    }
    return wrapStreamMessageObjects(maybeStream, rewriteKimiTaggedToolCallsInMessage);
  };
}

export function createKimiThinkingWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingType: KimiThinkingType,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      payloadObj.thinking = { type: thinkingType };
      if (thinkingType === "enabled" && isKimiK26PayloadModel(payloadObj.model)) {
        (payloadObj.thinking as Record<string, unknown>).keep = "all";
      }
      if (thinkingType === "enabled") {
        ensureKimiToolCallReplayReasoningContent(payloadObj);
      }
      delete payloadObj.reasoning;
      delete payloadObj.reasoning_effort;
      delete payloadObj.reasoningEffort;
    });
}

export function wrapKimiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const thinkingType = resolveKimiThinkingType({
    configuredThinking: ctx.extraParams?.thinking,
    thinkingLevel: ctx.thinkingLevel,
  });
  return createKimiToolCallMarkupWrapper(createKimiThinkingWrapper(ctx.streamFn, thinkingType));
}
