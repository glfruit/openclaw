import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  shouldLogVerbose,
} from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import type { TelegramMessageContextOptions } from "./bot-message-context.types.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramThreadParams } from "./bot/helpers.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";

const telegramInboundLog = createSubsystemLogger("gateway/channels/telegram").child("inbound");
const VISIBLE_PROGRESS_INITIAL_DELAY_MS = 5_000;
const VISIBLE_PROGRESS_HEARTBEAT_MS = 20 * 60_000;

const TELEGRAM_VISIBLE_PROGRESS_TEXT =
  "收到，正在准备上下文并排队处理；如果任务较重，我会继续在这里报进度。";
const TELEGRAM_VISIBLE_PROGRESS_HEARTBEAT_TEXT =
  "仍在处理，没有卡死；我会继续推进，并在阶段完成后同步结果。";
const TELEGRAM_GATEWAY_RESTARTING_TEXT =
  "系统正在重启，我已收到这条消息；当前进程不会继续处理，重启完成后会自动重试。";

let telegramGatewayShutdownPending = false;

function markTelegramGatewayShutdownPending(): void {
  telegramGatewayShutdownPending = true;
}

process.once("SIGINT", markTelegramGatewayShutdownPending);
process.once("SIGTERM", markTelegramGatewayShutdownPending);

class TelegramGatewayRestartInProgressError extends Error {
  constructor() {
    super("Telegram message deferred because gateway shutdown is already in progress.");
    this.name = "TelegramGatewayRestartInProgressError";
  }
}

export function formatTelegramInboundLogLine(params: {
  from: string;
  to: string;
  chatType: string;
  body: string;
  mediaType?: string;
}): string {
  const kindLabel = params.mediaType ? `, ${params.mediaType}` : "";
  return `Inbound message ${params.from} -> ${params.to} (${params.chatType}${kindLabel}, ${params.body.length} chars)`;
}

type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  "primaryCtx" | "allMedia" | "storeAllowFrom" | "options"
> & {
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramDeps: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token" | "fetchAbortSignal">;
};

export type TelegramMessageProcessorLifecycle = {
  onDispatchStart?: () => Promise<void> | void;
};

function startTelegramVisibleProgressNotices(params: {
  bot: TelegramMessageProcessorDeps["bot"];
  context: Awaited<ReturnType<typeof buildTelegramMessageContext>>;
}): () => void {
  const context = params.context;
  if (!context || context.ctxPayload.InboundEventKind === "room_event") {
    return () => undefined;
  }
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  const sendNotice = async (text: string) => {
    if (stopped) {
      return;
    }
    await sendTelegramVisibleNotice({
      bot: params.bot,
      context,
      text,
      logLabel: "telegram visible progress notice",
    });
  };
  const scheduleHeartbeat = () => {
    heartbeatTimer = setTimeout(() => {
      void sendNotice(TELEGRAM_VISIBLE_PROGRESS_HEARTBEAT_TEXT).finally(() => {
        if (!stopped) {
          scheduleHeartbeat();
        }
      });
    }, VISIBLE_PROGRESS_HEARTBEAT_MS);
  };
  const initialTimer = setTimeout(() => {
    scheduleHeartbeat();
    void sendNotice(TELEGRAM_VISIBLE_PROGRESS_TEXT);
  }, VISIBLE_PROGRESS_INITIAL_DELAY_MS);
  return () => {
    stopped = true;
    clearTimeout(initialTimer);
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
    }
  };
}

function buildTelegramVisibleNoticeOptions(
  context: NonNullable<Awaited<ReturnType<typeof buildTelegramMessageContext>>>,
) {
  const baseThreadParams = buildTelegramThreadParams(context.threadSpec);
  const replyParams =
    typeof context.msg.message_id === "number"
      ? {
          reply_parameters: {
            message_id: context.msg.message_id,
            allow_sending_without_reply: true,
          },
        }
      : {};
  return {
    ...baseThreadParams,
    ...replyParams,
  };
}

async function sendTelegramVisibleNotice(params: {
  bot: TelegramMessageProcessorDeps["bot"];
  context: NonNullable<Awaited<ReturnType<typeof buildTelegramMessageContext>>>;
  text: string;
  logLabel: string;
}): Promise<void> {
  try {
    await params.bot.api.sendMessage(
      params.context.chatId,
      params.text,
      buildTelegramVisibleNoticeOptions(params.context),
    );
  } catch (err) {
    logVerbose(`${params.logLabel} failed for chat ${params.context.chatId}: ${String(err)}`);
  }
}

export const createTelegramMessageProcessor = (deps: TelegramMessageProcessorDeps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    loadFreshConfig,
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    telegramDeps,
    opts,
  } = deps;
  const sessionRuntime = {
    ...(telegramDeps.buildChannelInboundEventContext
      ? { buildChannelInboundEventContext: telegramDeps.buildChannelInboundEventContext }
      : {}),
    ...(telegramDeps.readSessionUpdatedAt
      ? { readSessionUpdatedAt: telegramDeps.readSessionUpdatedAt }
      : {}),
    ...(telegramDeps.recordInboundSession
      ? { recordInboundSession: telegramDeps.recordInboundSession }
      : {}),
    ...(telegramDeps.resolveInboundLastRouteSessionKey
      ? { resolveInboundLastRouteSessionKey: telegramDeps.resolveInboundLastRouteSessionKey }
      : {}),
    ...(telegramDeps.resolvePinnedMainDmOwnerFromAllowlist
      ? {
          resolvePinnedMainDmOwnerFromAllowlist: telegramDeps.resolvePinnedMainDmOwnerFromAllowlist,
        }
      : {}),
    resolveStorePath: telegramDeps.resolveStorePath,
  };
  const contextRuntime = telegramDeps.recordChannelActivity
    ? { recordChannelActivity: telegramDeps.recordChannelActivity }
    : undefined;

  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: TelegramMessageContextOptions,
    replyMedia?: TelegramMediaRef[],
    replyChain?: TelegramReplyChainEntry[],
    promptContext?: TelegramPromptContextEntry[],
    lifecycle?: TelegramMessageProcessorLifecycle,
  ) => {
    const ingressReceivedAtMs =
      typeof options?.receivedAtMs === "number" && Number.isFinite(options.receivedAtMs)
        ? options.receivedAtMs
        : undefined;
    const ingressDebugEnabled =
      shouldLogVerbose() || process.env.OPENCLAW_DEBUG_TELEGRAM_INGRESS === "1";
    const ingressContextStartMs = ingressReceivedAtMs ? Date.now() : undefined;
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      replyMedia,
      replyChain,
      promptContext,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
      sendChatActionHandler,
      loadFreshConfig,
      runtime: contextRuntime,
      sessionRuntime,
      upsertPairingRequest: telegramDeps.upsertChannelPairingRequest,
    });
    if (!context) {
      if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
        logVerbose(
          `telegram ingress: chatId=${primaryCtx.message.chat.id} dropped after ${Date.now() - ingressReceivedAtMs}ms` +
            (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
        );
      }
      return false;
    }
    if (ingressDebugEnabled && ingressReceivedAtMs && ingressContextStartMs) {
      logVerbose(
        `telegram ingress: chatId=${context.chatId} contextReadyMs=${Date.now() - ingressReceivedAtMs}` +
          ` preDispatchMs=${Date.now() - ingressContextStartMs}` +
          (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
      );
    }
    if (context.ctxPayload.InboundEventKind !== "room_event") {
      void context.sendTyping().catch((err) => {
        logVerbose(`telegram early typing cue failed for chat ${context.chatId}: ${String(err)}`);
      });
    }
    telegramInboundLog.info(
      formatTelegramInboundLogLine({
        from: context.ctxPayload.From,
        to: context.primaryCtx.me?.username
          ? `@${context.primaryCtx.me.username}`
          : context.ctxPayload.To,
        chatType: context.ctxPayload.ChatType,
        body: context.ctxPayload.RawBody,
        mediaType: allMedia[0]?.contentType,
      }),
    );
    if (telegramGatewayShutdownPending || opts.fetchAbortSignal?.aborted) {
      await sendTelegramVisibleNotice({
        bot,
        context,
        text: TELEGRAM_GATEWAY_RESTARTING_TEXT,
        logLabel: "telegram gateway restart notice",
      });
      throw new TelegramGatewayRestartInProgressError();
    }
    const stopVisibleProgressNotices = startTelegramVisibleProgressNotices({ bot, context });
    await lifecycle?.onDispatchStart?.();
    try {
      await dispatchTelegramMessage({
        context,
        bot,
        cfg,
        runtime,
        replyToMode,
        streamMode,
        textLimit,
        telegramCfg,
        telegramDeps,
        opts,
      });
      if (ingressDebugEnabled && ingressReceivedAtMs) {
        logVerbose(
          `telegram ingress: chatId=${context.chatId} dispatchCompleteMs=${Date.now() - ingressReceivedAtMs}` +
            (options?.ingressBuffer ? ` buffer=${options.ingressBuffer}` : ""),
        );
      }
    } catch (err) {
      runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
      try {
        await bot.api.sendMessage(
          context.chatId,
          "Something went wrong while processing your request. Please try again.",
          buildTelegramThreadParams(context.threadSpec),
        );
      } catch {}
    } finally {
      stopVisibleProgressNotices();
    }
    return true;
  };
};

export const __testing = {
  setTelegramGatewayShutdownPendingForTest(value: boolean): void {
    telegramGatewayShutdownPending = value;
  },
};
