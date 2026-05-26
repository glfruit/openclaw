import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./event-types.js";

const sendMessageFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
}));

import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";

function createDeferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function createEvent(overrides: Partial<FeishuMessageEvent["message"]> = {}): FeishuMessageEvent {
  return {
    sender: {
      sender_id: {
        open_id: "ou-user",
      },
    },
    message: {
      message_id: "om_msg",
      chat_id: "oc_chat",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "do the long task" }),
      ...overrides,
    },
  };
}

function createCore(): PluginRuntime {
  return {
    channel: {
      debounce: {
        resolveInboundDebounceMs: vi.fn(() => 0),
        createInboundDebouncer: vi.fn(
          (options: { onFlush: (entries: FeishuMessageEvent[]) => Promise<void> | void }) => ({
            enqueue: async (event: FeishuMessageEvent) => {
              await options.onFlush([event]);
            },
          }),
        ),
      },
      commands: {
        isControlCommandMessage: vi.fn(() => false),
      },
    },
  } as unknown as PluginRuntime;
}

describe("createFeishuMessageReceiveHandler visible progress notices", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("sends a visible progress notice when a message handler stays silent", async () => {
    vi.useFakeTimers();
    sendMessageFeishuMock.mockResolvedValue(undefined);
    const gate = createDeferred();
    const handleMessage = vi.fn(async () => {
      await gate.promise;
    });
    const handler = createFeishuMessageReceiveHandler({
      cfg: { channels: { feishu: {} } } as ClawdbotConfig,
      core: createCore(),
      accountId: "main",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: () => "do the long task",
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
    });

    const pending = handler(createEvent());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      cfg: { channels: { feishu: {} } },
      to: "oc_chat",
      text: "收到，正在准备上下文并排队处理；如果任务较重，我会继续在这里报进度。",
      replyToMessageId: "om_msg",
      accountId: "main",
    });

    gate.resolve();
    await pending;
  });

  it("keeps long silent handlers alive with visible heartbeat notices", async () => {
    vi.useFakeTimers();
    sendMessageFeishuMock.mockResolvedValue(undefined);
    const gate = createDeferred();
    const handleMessage = vi.fn(async () => {
      await gate.promise;
    });
    const handler = createFeishuMessageReceiveHandler({
      cfg: { channels: { feishu: {} } } as ClawdbotConfig,
      core: createCore(),
      accountId: "main",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: () => "do the long task",
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
    });

    const pending = handler(createEvent({ message_id: "om_msg_heartbeat" }));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(20 * 60_000);

    expect(sendMessageFeishuMock).toHaveBeenNthCalledWith(2, {
      cfg: { channels: { feishu: {} } },
      to: "oc_chat",
      text: "仍在处理，没有卡死；我会继续推进，并在阶段完成后同步结果。",
      replyToMessageId: "om_msg_heartbeat",
      accountId: "main",
    });

    gate.resolve();
    await pending;
  });

  it("uses status-check progress text for short follow-up status questions", async () => {
    vi.useFakeTimers();
    sendMessageFeishuMock.mockResolvedValue(undefined);
    const gate = createDeferred();
    const handleMessage = vi.fn(async () => {
      await gate.promise;
    });
    const handler = createFeishuMessageReceiveHandler({
      cfg: { channels: { feishu: {} } } as ClawdbotConfig,
      core: createCore(),
      accountId: "main",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: () => "处理完没有？",
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
    });

    const pending = handler(
      createEvent({
        message_id: "om_msg_status",
        content: JSON.stringify({ text: "处理完没有？" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendMessageFeishuMock).toHaveBeenCalledWith({
      cfg: { channels: { feishu: {} } },
      to: "oc_chat",
      text: "我在查当前任务状态，不会重复开工；查到结果后会直接回 RUNNING / PASS / FAILED / BLOCKED。",
      replyToMessageId: "om_msg_status",
      accountId: "main",
    });

    gate.resolve();
    await pending;
  });
});
