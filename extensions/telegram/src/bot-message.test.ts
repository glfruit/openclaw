import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const telegramInboundInfo = vi.hoisted(() => vi.fn());
const upsertChannelPairingRequest = vi.hoisted(() =>
  vi.fn(async () => ({ code: "PAIRCODE", created: true })),
);

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    child: () => ({
      info: telegramInboundInfo,
    }),
  }),
  danger: (message: string) => message,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

let createTelegramMessageProcessor: typeof import("./bot-message.js").createTelegramMessageProcessor;
let formatTelegramInboundLogLine: typeof import("./bot-message.js").formatTelegramInboundLogLine;
let telegramMessageTesting: typeof import("./bot-message.js").__testing;

describe("telegram bot message processor", () => {
  beforeAll(async () => {
    ({
      createTelegramMessageProcessor,
      formatTelegramInboundLogLine,
      __testing: telegramMessageTesting,
    } = await import("./bot-message.js"));
  });

  beforeEach(() => {
    buildTelegramMessageContext.mockReset();
    dispatchTelegramMessage.mockReset();
    telegramInboundInfo.mockClear();
    upsertChannelPairingRequest.mockClear();
    telegramMessageTesting.setTelegramGatewayShutdownPendingForTest(false);
    telegramMessageTesting.resetTelegramVisibleProgressLanesForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const telegramDepsForTest = {
    upsertChannelPairingRequest,
  } as unknown as TelegramBotDeps;

  const baseDeps = {
    bot: {},
    cfg: {},
    account: {},
    telegramCfg: {},
    historyLimit: 0,
    groupHistories: {},
    dmPolicy: {},
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "none",
    logger: {},
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({}),
    runtime: {},
    replyToMode: "auto",
    streamMode: "partial",
    textLimit: 4096,
    telegramDeps: telegramDepsForTest,
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  async function processSampleMessage(
    processMessage: ReturnType<typeof createTelegramMessageProcessor>,
    lifecycle?: import("./bot-message.js").TelegramMessageProcessorLifecycle,
  ) {
    return await processMessage(
      {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
        },
      } as unknown as Parameters<typeof processMessage>[0],
      [],
      [],
      {},
      undefined,
      undefined,
      undefined,
      lifecycle,
    );
  }

  function createDispatchFailureHarness(
    context: Record<string, unknown>,
    sendMessage: ReturnType<typeof vi.fn>,
  ) {
    const runtimeError = vi.fn();
    buildTelegramMessageContext.mockResolvedValue(createMessageContext(context));
    dispatchTelegramMessage.mockRejectedValue(new Error("dispatch exploded"));
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    return { processMessage, runtimeError };
  }

  function createMessageContext(context: Record<string, unknown> = {}) {
    return {
      chatId: 123,
      msg: { message_id: 456 },
      ctxPayload: {
        From: "telegram:123",
        To: "telegram:123",
        ChatType: "direct",
        RawBody: "hello there",
      },
      primaryCtx: { me: { username: "openclaw_bot" } },
      route: { sessionKey: "agent:main:main" },
      sendTyping: vi.fn().mockResolvedValue(undefined),
      ...context,
    };
  }

  it("dispatches when context is available", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchTelegramMessage.mock.invocationCallOrder[0],
    );
    expect(telegramInboundInfo).toHaveBeenCalledWith(
      "Inbound message telegram:123 -> @openclaw_bot (direct, 11 chars)",
    );
  });

  it("runs the dispatch-start lifecycle after context creation and before dispatch", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toBe(true);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(onDispatchStart).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      onDispatchStart.mock.invocationCallOrder[0],
    );
    expect(onDispatchStart.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchTelegramMessage.mock.invocationCallOrder[0],
    );
  });

  it("sends a visible progress notice when dispatch remains silent", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    let finishDispatch: (() => void) | undefined;
    dispatchTelegramMessage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        chatId: 123,
        msg: { message_id: 456 },
        threadSpec: { id: 99, scope: "forum" },
      }),
    );

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    const processing = processSampleMessage(processMessage);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "收到，已进入处理队列；如果任务较重，我会继续在这里报进度。",
      {
        message_thread_id: 99,
        reply_parameters: {
          message_id: 456,
          allow_sending_without_reply: true,
        },
      },
    );

    finishDispatch?.();
    await processing;
  });

  it("deduplicates visible progress notices while a lane is already processing", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const finishDispatches: Array<() => void> = [];
    dispatchTelegramMessage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDispatches.push(resolve);
        }),
    );
    buildTelegramMessageContext.mockImplementation(() =>
      Promise.resolve(
        createMessageContext({
          chatId: 123,
          msg: { message_id: 456 },
          route: { sessionKey: "agent:edu-tl:telegram:group:-1003802090799" },
          threadSpec: { id: 99, scope: "forum" },
        }),
      ),
    );

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    const first = processSampleMessage(processMessage);
    await vi.advanceTimersByTimeAsync(1);
    const second = processSampleMessage(processMessage);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      123,
      "上一轮还在处理，这条消息已排队；我会等前一轮收尾后继续处理，不会重复开工。",
      {
        message_thread_id: 99,
        reply_parameters: {
          message_id: 456,
          allow_sending_without_reply: true,
        },
      },
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      123,
      "收到，已进入处理队列；如果任务较重，我会继续在这里报进度。",
      {
        message_thread_id: 99,
        reply_parameters: {
          message_id: 456,
          allow_sending_without_reply: true,
        },
      },
    );

    finishDispatches.forEach((finish) => finish());
    await first;
    await second;
  });

  it("suppresses repeated queued notices for the same active lane during cooldown", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const finishDispatches: Array<() => void> = [];
    let messageId = 456;
    dispatchTelegramMessage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDispatches.push(resolve);
        }),
    );
    buildTelegramMessageContext.mockImplementation(() =>
      Promise.resolve(
        createMessageContext({
          chatId: 123,
          msg: { message_id: messageId++ },
          route: { sessionKey: "agent:edu-tl:telegram:group:-1003802090799" },
        }),
      ),
    );

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    const first = processSampleMessage(processMessage);
    await vi.advanceTimersByTimeAsync(1);
    const second = processSampleMessage(processMessage);
    await vi.advanceTimersByTimeAsync(1);
    const third = processSampleMessage(processMessage);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(
      sendMessage.mock.calls.filter(
        (call) =>
          call[1] === "上一轮还在处理，这条消息已排队；我会等前一轮收尾后继续处理，不会重复开工。",
      ),
    ).toHaveLength(1);
    expect(
      sendMessage.mock.calls.filter(
        (call) => call[1] === "收到，已进入处理队列；如果任务较重，我会继续在这里报进度。",
      ),
    ).toHaveLength(1);

    finishDispatches.forEach((finish) => finish());
    await first;
    await second;
    await third;
  });

  it("keeps long silent dispatches alive with visible heartbeat notices", async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    let finishDispatch: (() => void) | undefined;
    dispatchTelegramMessage.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        chatId: 123,
        msg: { message_id: 456 },
      }),
    );

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    const processing = processSampleMessage(processMessage);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(20 * 60_000);

    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      123,
      "仍在处理，没有卡死；我会继续推进，并在阶段完成后同步结果。",
      {
        reply_parameters: {
          message_id: 456,
          allow_sending_without_reply: true,
        },
      },
    );

    finishDispatch?.();
    await processing;
  });

  it("defers dispatch and sends a restart notice when shutdown is already pending", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    telegramMessageTesting.setTelegramGatewayShutdownPendingForTest(true);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        chatId: 123,
        msg: { message_id: 456 },
        threadSpec: { id: 99, scope: "forum" },
      }),
    );

    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);

    await expect(processSampleMessage(processMessage)).rejects.toThrow(
      "gateway shutdown is already in progress",
    );

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "系统正在重启，我已收到这条消息；当前进程不会继续处理，重启完成后会自动重试。",
      {
        message_thread_id: 99,
        reply_parameters: {
          message_id: 456,
          allow_sending_without_reply: true,
        },
      },
    );
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("does not run the dispatch-start lifecycle when no context is produced", async () => {
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(null);

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toBe(false);

    expect(onDispatchStart).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("does not send early typing cues for room events", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
        ctxPayload: {
          From: "telegram:123",
          To: "telegram:123",
          ChatType: "group",
          RawBody: "ambient",
          InboundEventKind: "room_event",
        },
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendTyping).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(false);
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
    expect(telegramInboundInfo).not.toHaveBeenCalled();
  });

  it("formats Telegram inbound summaries without message content", () => {
    expect(
      formatTelegramInboundLogLine({
        from: "telegram:123",
        to: "@openclaw_bot",
        chatType: "direct",
        body: "secret message",
      }),
    ).toBe("Inbound message telegram:123 -> @openclaw_bot (direct, 14 chars)");
    expect(
      formatTelegramInboundLogLine({
        from: "telegram:group:-100",
        to: "@openclaw_bot",
        chatType: "group",
        body: "<media:image>",
        mediaType: "image/jpeg",
      }),
    ).toBe("Inbound message telegram:group:-100 -> @openclaw_bot (group, image/jpeg, 13 chars)");
  });

  it("keeps dispatch running when the early typing cue fails", async () => {
    const sendTyping = vi.fn().mockRejectedValue(new Error("typing failed"));
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("sends user-visible fallback when dispatch throws", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage, runtimeError } = createDispatchFailureHarness(
      {
        chatId: 123,
        threadSpec: { id: 456, scope: "forum" },
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      { message_thread_id: 456 },
    );
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });

  it("omits message_thread_id for General-topic fallback replies", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage } = createDispatchFailureHarness(
      {
        chatId: 123,
        threadSpec: { id: 1, scope: "forum" },
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      undefined,
    );
  });

  it("swallows fallback delivery failures after dispatch throws", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("blocked by user"));
    const { processMessage, runtimeError } = createDispatchFailureHarness(
      {
        chatId: 123,
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    await expect(processSampleMessage(processMessage)).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      undefined,
    );
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });
});
