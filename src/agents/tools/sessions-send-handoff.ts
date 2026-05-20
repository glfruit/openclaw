import fs from "node:fs/promises";
import path from "node:path";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN, isSilentReplyText } from "../../auto-reply/tokens.js";
import { resolveStateDir } from "../../config/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { ANNOUNCE_SKIP_TOKEN, REPLY_SKIP_TOKEN } from "./sessions-send-tokens.js";

export const SESSIONS_SEND_HANDOFF_LEDGER_RELATIVE_PATH = "handoffs/sessions-send.jsonl";
export const SESSIONS_SEND_HANDOFF_INBOX_RELATIVE_DIR = "handoffs/inbox";
export const SESSIONS_SEND_HANDOFF_OUTBOX_RELATIVE_DIR = "handoffs/outbox";

export type SessionsSendHandoffStatus = "queued" | "accepted" | "delivered" | "rejected";

export type SessionsSendHandoffControlOutcome =
  | "announce_skip"
  | "heartbeat_ok"
  | "no_reply"
  | "reply_skip";

export type SessionsSendHandoffDelivery = {
  mode: "announce";
  status: "pending" | "skipped";
};

export type SessionsSendHandoffReceipt =
  | {
      status: "recorded";
      inbox: { path: string };
      outbox: { path: string };
    }
  | {
      status: "failed";
      error: string;
    };

export type SessionsSendHandoffAck = {
  id: string;
  status: SessionsSendHandoffStatus;
  delivery: SessionsSendHandoffDelivery;
  ledger: {
    path: typeof SESSIONS_SEND_HANDOFF_LEDGER_RELATIVE_PATH;
  };
  receipt?: SessionsSendHandoffReceipt | undefined;
};

export type SessionsSendHandoffEventType =
  | "accepted"
  | "announce_delivered"
  | "announce_delivery_failed"
  | "control_outcome_observed"
  | "created"
  | "failed"
  | "receipt_failed"
  | "receipt_recorded"
  | "rejected"
  | "target_reply_missing"
  | "target_reply_observed";

export type SessionsSendHandoffEvent = {
  handoffId: string;
  type: SessionsSendHandoffEventType;
  status: SessionsSendHandoffStatus;
  runId?: string | undefined;
  requesterSessionKey?: string | undefined;
  requesterChannel?: string | undefined;
  targetSessionKey?: string | undefined;
  targetDisplayKey?: string | undefined;
  targetChannel?: string | undefined;
  controlOutcome?: SessionsSendHandoffControlOutcome | undefined;
  error?: string | undefined;
  timestamp?: string | undefined;
};

export function buildSessionsSendHandoffAck(params: {
  id: string;
  status: SessionsSendHandoffStatus;
  delivery: SessionsSendHandoffDelivery;
  receipt?: SessionsSendHandoffReceipt;
}): SessionsSendHandoffAck {
  return {
    id: params.id,
    status: params.status,
    delivery: params.delivery,
    ledger: {
      path: SESSIONS_SEND_HANDOFF_LEDGER_RELATIVE_PATH,
    },
    ...(params.receipt ? { receipt: params.receipt } : {}),
  };
}

export function resolveSessionsSendHandoffLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), SESSIONS_SEND_HANDOFF_LEDGER_RELATIVE_PATH);
}

function mailboxKeyForSession(sessionKey: string | undefined, fallback: string): string {
  const agentId = sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : "";
  const source = agentId || sessionKey || fallback;
  const normalized = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return normalized || fallback;
}

function mailboxRelativePath(params: {
  kind: "inbox" | "outbox";
  sessionKey: string | undefined;
}): string {
  const dir =
    params.kind === "inbox"
      ? SESSIONS_SEND_HANDOFF_INBOX_RELATIVE_DIR
      : SESSIONS_SEND_HANDOFF_OUTBOX_RELATIVE_DIR;
  const key = mailboxKeyForSession(params.sessionKey, "unknown");
  return path.join(dir, `${key}.jsonl`);
}

export function resolveSessionsSendHandoffInboxPath(
  sessionKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), mailboxRelativePath({ kind: "inbox", sessionKey }));
}

export function resolveSessionsSendHandoffOutboxPath(
  sessionKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), mailboxRelativePath({ kind: "outbox", sessionKey }));
}

export async function recordSessionsSendHandoffReceipt(
  params: {
    handoffId: string;
    message: string;
    requesterSessionKey?: string | undefined;
    requesterChannel?: string | undefined;
    targetSessionKey: string;
    targetDisplayKey?: string | undefined;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionsSendHandoffReceipt> {
  const inboxRelativePath = mailboxRelativePath({
    kind: "inbox",
    sessionKey: params.targetSessionKey,
  });
  const outboxRelativePath = mailboxRelativePath({
    kind: "outbox",
    sessionKey: params.requesterSessionKey,
  });
  const stateDir = resolveStateDir(env);
  const inboxPath = path.join(stateDir, inboxRelativePath);
  const outboxPath = path.join(stateDir, outboxRelativePath);
  const timestamp = new Date().toISOString();
  const record = {
    handoffId: params.handoffId,
    type: "sessions_send",
    status: "queued",
    timestamp,
    requesterSessionKey: params.requesterSessionKey,
    requesterChannel: params.requesterChannel,
    targetSessionKey: params.targetSessionKey,
    targetDisplayKey: params.targetDisplayKey,
    message: params.message,
  };
  const line = `${JSON.stringify(record)}\n`;
  try {
    await fs.mkdir(path.dirname(inboxPath), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(outboxPath), { recursive: true, mode: 0o700 });
    await fs.appendFile(inboxPath, line, { encoding: "utf-8", mode: 0o600 });
    await fs.appendFile(outboxPath, line, { encoding: "utf-8", mode: 0o600 });
    return {
      status: "recorded",
      inbox: { path: inboxRelativePath },
      outbox: { path: outboxRelativePath },
    };
  } catch (err) {
    return {
      status: "failed",
      error: formatErrorMessage(err),
    };
  }
}

export function classifySessionsSendControlOutcome(
  text?: string,
): SessionsSendHandoffControlOutcome | undefined {
  if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
    return "no_reply";
  }
  if (isSilentReplyText(text, REPLY_SKIP_TOKEN)) {
    return "reply_skip";
  }
  if (isSilentReplyText(text, ANNOUNCE_SKIP_TOKEN)) {
    return "announce_skip";
  }
  if (isSilentReplyText(text, HEARTBEAT_TOKEN)) {
    return "heartbeat_ok";
  }
  return undefined;
}

export async function recordSessionsSendHandoffEvent(
  event: SessionsSendHandoffEvent,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const ledgerPath = resolveSessionsSendHandoffLedgerPath(env);
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
    await fs.appendFile(
      ledgerPath,
      `${JSON.stringify({
        ...event,
        timestamp: event.timestamp ?? new Date().toISOString(),
      })}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    // Handoff ledger writes are audit best-effort; tool delivery must not fail
    // because the local state directory is temporarily unavailable.
  }
}
