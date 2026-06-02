import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

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
interface MutableAssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  result: () => Promise<AssistantMessage>;
}
type KimiThinkingConfig = {
  type: KimiThinkingType;
  budget_tokens?: number;
};
type KimiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

const KIMI_ANTHROPIC_THINKING_BUDGETS: Record<Exclude<KimiThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 1024,
  medium: 4096,
  high: 8192,
  adaptive: 8192,
  xhigh: 8192,
  max: 8192,
};
const KIMI_ANTHROPIC_VISIBLE_OUTPUT_RESERVE_TOKENS = 1024;
const KIMI_ANTHROPIC_MIN_OUTPUT_TOKENS = 16000;
const KIMI_PLACEHOLDER_REASONING_CONTENT = " ";
const KIMI_SYNTHETIC_TOOL_RESULT_TEXT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for Kimi transcript preflight.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readOpenAIToolCallId(toolCall: unknown): string | undefined {
  if (!isRecord(toolCall)) {
    return undefined;
  }
  return normalizeNonEmptyString(toolCall.id);
}

function readOpenAIToolCallName(toolCall: unknown): string | undefined {
  if (!isRecord(toolCall)) {
    return undefined;
  }
  const fn = toolCall.function;
  return isRecord(fn) ? normalizeNonEmptyString(fn.name) : undefined;
}

function makeKimiOpenAISyntheticToolResult(toolCall: unknown): Record<string, unknown> {
  const id = readOpenAIToolCallId(toolCall) ?? "missing_tool_call_id";
  const name = readOpenAIToolCallName(toolCall);
  return {
    role: "tool",
    tool_call_id: id,
    ...(name ? { name } : {}),
    content: KIMI_SYNTHETIC_TOOL_RESULT_TEXT,
  };
}

function ensureKimiOpenAIToolCallPairing(payloadObj: Record<string, unknown>): void {
  const messages = payloadObj.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  let changed = false;
  const nextMessages: unknown[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isRecord(message)) {
      nextMessages.push(message);
      continue;
    }

    if (message.role === "tool") {
      changed = true;
      continue;
    }

    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.filter((toolCall) => readOpenAIToolCallId(toolCall))
      : [];
    if (message.role !== "assistant" || toolCalls.length === 0) {
      nextMessages.push(message);
      continue;
    }

    nextMessages.push(message);
    const expectedIds = new Set(toolCalls.map((toolCall) => readOpenAIToolCallId(toolCall)!));
    const existingById = new Map<string, Record<string, unknown>>();
    let scan = index + 1;
    while (scan < messages.length) {
      const candidate = messages[scan];
      if (!isRecord(candidate) || candidate.role !== "tool") {
        break;
      }
      const toolCallId = normalizeNonEmptyString(candidate.tool_call_id);
      if (toolCallId && expectedIds.has(toolCallId) && !existingById.has(toolCallId)) {
        existingById.set(toolCallId, candidate);
      } else {
        changed = true;
      }
      scan += 1;
    }

    for (const toolCall of toolCalls) {
      const id = readOpenAIToolCallId(toolCall)!;
      const existing = existingById.get(id);
      if (existing) {
        nextMessages.push(existing);
      } else {
        nextMessages.push(makeKimiOpenAISyntheticToolResult(toolCall));
        changed = true;
      }
    }

    if (scan !== index + 1) {
      index = scan - 1;
    }
  }

  if (changed) {
    payloadObj.messages = nextMessages;
  }
}

function readAnthropicToolUseId(block: unknown): string | undefined {
  if (!isRecord(block) || block.type !== "tool_use") {
    return undefined;
  }
  return normalizeNonEmptyString(block.id);
}

function readAnthropicToolResultId(block: unknown): string | undefined {
  if (!isRecord(block) || block.type !== "tool_result") {
    return undefined;
  }
  return normalizeNonEmptyString(block.tool_use_id);
}

function makeKimiAnthropicSyntheticToolResult(toolUse: unknown): Record<string, unknown> {
  return {
    type: "tool_result",
    tool_use_id: readAnthropicToolUseId(toolUse) ?? "missing_tool_use_id",
    content: [{ type: "text", text: KIMI_SYNTHETIC_TOOL_RESULT_TEXT }],
    is_error: true,
  };
}

function ensureKimiAnthropicToolUsePairing(payloadObj: Record<string, unknown>): void {
  const messages = payloadObj.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  let changed = false;
  const nextMessages: unknown[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isRecord(message)) {
      nextMessages.push(message);
      continue;
    }

    const content = Array.isArray(message.content) ? message.content : [];
    const toolUses =
      message.role === "assistant" ? content.filter((block) => readAnthropicToolUseId(block)) : [];
    if (toolUses.length === 0) {
      if (message.role === "user" && content.some((block) => readAnthropicToolResultId(block))) {
        const nonToolResults = content.filter((block) => !readAnthropicToolResultId(block));
        if (nonToolResults.length > 0) {
          nextMessages.push({ ...message, content: nonToolResults });
        }
        changed = true;
        continue;
      }
      nextMessages.push(message);
      continue;
    }

    nextMessages.push(message);
    const expectedIds = new Set(toolUses.map((toolUse) => readAnthropicToolUseId(toolUse)!));
    const existingById = new Map<string, unknown>();
    let leftoverUserContent: unknown[] = [];
    const next = messages[index + 1];
    if (isRecord(next) && next.role === "user" && Array.isArray(next.content)) {
      for (const block of next.content) {
        const toolResultId = readAnthropicToolResultId(block);
        if (toolResultId && expectedIds.has(toolResultId) && !existingById.has(toolResultId)) {
          existingById.set(toolResultId, block);
          continue;
        }
        if (toolResultId) {
          changed = true;
          continue;
        }
        leftoverUserContent.push(block);
      }
      index += 1;
    }

    const toolResultContent: unknown[] = [];
    for (const toolUse of toolUses) {
      const id = readAnthropicToolUseId(toolUse)!;
      const existing = existingById.get(id);
      if (existing) {
        toolResultContent.push(existing);
      } else {
        toolResultContent.push(makeKimiAnthropicSyntheticToolResult(toolUse));
        changed = true;
      }
    }
    nextMessages.push({ role: "user", content: toolResultContent });
    if (leftoverUserContent.length > 0) {
      nextMessages.push({ ...(next as Record<string, unknown>), content: leftoverUserContent });
      changed = true;
    }
  }

  if (changed) {
    payloadObj.messages = nextMessages;
  }
}

function ensureKimiToolResultPairing(payloadObj: Record<string, unknown>, api: unknown): void {
  if (api === "anthropic-messages") {
    ensureKimiAnthropicToolUsePairing(payloadObj);
  } else {
    ensureKimiOpenAIToolCallPairing(payloadObj);
  }
}

function normalizeKimiThinkingBudgetTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized >= 1024 ? normalized : undefined;
}

function normalizeKimiAnthropicMaxTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function ensureKimiAnthropicMaxTokens(
  payloadObj: Record<string, unknown>,
  thinkingConfig: KimiThinkingConfig,
): void {
  if (thinkingConfig.type !== "enabled" || thinkingConfig.budget_tokens === undefined) {
    return;
  }
  const required = Math.max(
    KIMI_ANTHROPIC_MIN_OUTPUT_TOKENS,
    thinkingConfig.budget_tokens + KIMI_ANTHROPIC_VISIBLE_OUTPUT_RESERVE_TOKENS,
  );
  const current = normalizeKimiAnthropicMaxTokens(payloadObj.max_tokens);
  payloadObj.max_tokens = current === undefined ? required : Math.max(current, required);
}

function ensureKimiReasoningContent(payloadObj: Record<string, unknown>): void {
  if (!Array.isArray(payloadObj.messages)) {
    return;
  }
  for (const message of payloadObj.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }
    if (!("reasoning_content" in record)) {
      record.reasoning_content = KIMI_PLACEHOLDER_REASONING_CONTENT;
    }
  }
}

function stripKimiOpenAIReasoningContent(payloadObj: Record<string, unknown>): void {
  if (!Array.isArray(payloadObj.messages)) {
    return;
  }
  for (const message of payloadObj.messages) {
    if (message && typeof message === "object") {
      delete (message as Record<string, unknown>).reasoning_content;
    }
  }
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

function normalizeKimiThinkingConfig(value: unknown): KimiThinkingConfig | undefined {
  const type = normalizeKimiThinkingType(value);
  if (!type) {
    return undefined;
  }
  if (type === "disabled") {
    return { type: "disabled" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "enabled" };
  }
  const record = value as Record<string, unknown>;
  const budgetTokens = normalizeKimiThinkingBudgetTokens(
    record.budget_tokens ?? record.budgetTokens,
  );
  return budgetTokens === undefined
    ? { type: "enabled" }
    : { type: "enabled", budget_tokens: budgetTokens };
}

function resolveKimiAnthropicThinkingBudgetTokens(
  thinkingLevel: KimiThinkingLevel | undefined,
): number | undefined {
  if (!thinkingLevel || thinkingLevel === "off") {
    return undefined;
  }
  return KIMI_ANTHROPIC_THINKING_BUDGETS[thinkingLevel];
}

export function resolveKimiThinkingConfig(params: {
  configuredThinking: unknown;
  thinkingLevel?: KimiThinkingLevel;
}): KimiThinkingConfig {
  const configured = normalizeKimiThinkingConfig(params.configuredThinking);
  const levelBudgetTokens = resolveKimiAnthropicThinkingBudgetTokens(params.thinkingLevel);
  if (configured) {
    return configured.type === "enabled" && configured.budget_tokens === undefined
      ? { type: "enabled", budget_tokens: levelBudgetTokens ?? 1024 }
      : configured;
  }
  if (!params.thinkingLevel || params.thinkingLevel === "off") {
    return { type: "disabled" };
  }
  return levelBudgetTokens === undefined
    ? { type: "enabled" }
    : { type: "enabled", budget_tokens: levelBudgetTokens };
}

export function resolveKimiThinkingType(params: {
  configuredThinking: unknown;
  thinkingLevel?: KimiThinkingLevel;
}): KimiThinkingType {
  return resolveKimiThinkingConfig(params).type;
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

function transformKimiStreamEvent(
  value: unknown,
  transformMessage: (message: unknown) => void,
): void {
  const event =
    value && typeof value === "object"
      ? (value as { partial?: unknown; message?: unknown })
      : undefined;
  if (!event) {
    return;
  }
  for (const message of [event.partial, event.message]) {
    transformMessage(message);
  }
}

function wrapStreamMessageObjects(
  stream: MutableAssistantMessageEventStream,
  transformMessage: (message: unknown) => void,
): MutableAssistantMessageEventStream {
  const readFinalMessage = stream.result.bind(stream);
  Object.assign(stream, {
    async result() {
      const message = await readFinalMessage();
      transformMessage(message);
      return message;
    },
  });

  const createIterator = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = () => {
    const iterator = createIterator();
    return {
      async next() {
        const step = await iterator.next();
        if (!step.done) {
          transformKimiStreamEvent(step.value, transformMessage);
        }
        return step;
      },
      async return(value?: unknown) {
        return iterator.return?.(value) ?? { done: true as const, value: undefined };
      },
      async throw(error?: unknown) {
        return iterator.throw?.(error) ?? { done: true as const, value: undefined };
      },
    };
  };
  return stream;
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
  thinkingConfig: KimiThinkingConfig | KimiThinkingType,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      const normalized =
        typeof thinkingConfig === "string" ? { type: thinkingConfig } : thinkingConfig;
      payloadObj.thinking =
        model.api === "anthropic-messages" ? { ...normalized } : { type: normalized.type };
      if (normalized.type === "enabled") {
        ensureKimiReasoningContent(payloadObj);
      } else {
        stripKimiOpenAIReasoningContent(payloadObj);
      }
      ensureKimiToolResultPairing(payloadObj, model.api);
      if (model.api === "anthropic-messages") {
        ensureKimiAnthropicMaxTokens(payloadObj, normalized);
      }
      delete payloadObj.reasoning;
      delete payloadObj.reasoning_effort;
      delete payloadObj.reasoningEffort;
    });
}

export function wrapKimiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const thinkingConfig = resolveKimiThinkingConfig({
    configuredThinking: ctx.extraParams?.thinking,
    thinkingLevel: ctx.thinkingLevel,
  });
  return createKimiToolCallMarkupWrapper(createKimiThinkingWrapper(ctx.streamFn, thinkingConfig));
}
