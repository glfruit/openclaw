import type { CronPayload } from "../types.js";
import {
  booleanToInteger,
  integerToBoolean,
  normalizeNumber,
  parseJsonArray,
  parseJsonObject,
  parseJsonValue,
  serializeJson,
} from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";

type CommandPayloadExtras = {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  successRegex?: string;
  failureRegex?: string;
  summaryRegex?: string;
  outputMode?: "lastLine" | "stdout" | "json" | "summary";
};

function parseExternalContentSource(raw: string | null): "gmail" | "webhook" | undefined {
  const parsed = raw ? parseJsonValue<unknown>(raw, undefined) : undefined;
  return parsed === "gmail" || parsed === "webhook" ? parsed : undefined;
}

function commandPayloadExtras(payload: Extract<CronPayload, { kind: "command" }>) {
  const extras: CommandPayloadExtras = {};
  if (payload.args) {
    extras.args = payload.args;
  }
  if (payload.cwd) {
    extras.cwd = payload.cwd;
  }
  if (payload.env) {
    extras.env = payload.env;
  }
  if (payload.successRegex) {
    extras.successRegex = payload.successRegex;
  }
  if (payload.failureRegex) {
    extras.failureRegex = payload.failureRegex;
  }
  if (payload.summaryRegex) {
    extras.summaryRegex = payload.summaryRegex;
  }
  if (payload.outputMode) {
    extras.outputMode = payload.outputMode;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      typeof entry[0] === "string" && typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseOutputMode(value: unknown): CommandPayloadExtras["outputMode"] | undefined {
  return value === "lastLine" || value === "stdout" || value === "json" || value === "summary"
    ? value
    : undefined;
}

/** Maps cron payload variants into normalized SQLite columns. */
export function bindPayloadColumns(
  payload: CronPayload,
): Pick<
  CronJobInsert,
  | "payload_allow_unsafe_external_content"
  | "payload_external_content_source_json"
  | "payload_fallbacks_json"
  | "payload_kind"
  | "payload_light_context"
  | "payload_message"
  | "payload_model"
  | "payload_thinking"
  | "payload_timeout_seconds"
  | "payload_tools_allow_json"
> {
  if (payload.kind === "systemEvent") {
    return {
      payload_kind: "systemEvent",
      payload_message: payload.text,
      payload_model: null,
      payload_fallbacks_json: null,
      payload_thinking: null,
      payload_timeout_seconds: null,
      payload_allow_unsafe_external_content: null,
      payload_external_content_source_json: null,
      payload_light_context: null,
      payload_tools_allow_json: null,
    };
  }
  if (payload.kind === "command") {
    return {
      payload_kind: "command",
      payload_message: payload.command,
      payload_model: null,
      payload_fallbacks_json: null,
      payload_thinking: null,
      payload_timeout_seconds: payload.timeoutSeconds ?? null,
      payload_allow_unsafe_external_content: null,
      payload_external_content_source_json: serializeJson(commandPayloadExtras(payload)),
      payload_light_context: null,
      payload_tools_allow_json: null,
    };
  }
  return {
    payload_kind: "agentTurn",
    payload_message: payload.message,
    payload_model: payload.model ?? null,
    payload_fallbacks_json: serializeJson(payload.fallbacks),
    payload_thinking: payload.thinking ?? null,
    payload_timeout_seconds: payload.timeoutSeconds ?? null,
    payload_allow_unsafe_external_content: booleanToInteger(payload.allowUnsafeExternalContent),
    payload_external_content_source_json: serializeJson(payload.externalContentSource),
    payload_light_context: booleanToInteger(payload.lightContext),
    payload_tools_allow_json: serializeJson(payload.toolsAllow),
  };
}

/** Reconstructs cron payload variants from SQLite columns, returning null for invalid rows. */
export function payloadFromRow(row: CronJobRow): CronPayload | null {
  if (row.payload_kind === "systemEvent") {
    return row.payload_message == null ? null : { kind: "systemEvent", text: row.payload_message };
  }
  if (row.payload_kind === "agentTurn") {
    if (row.payload_message == null) {
      return null;
    }
    const fallbacks = row.payload_fallbacks_json
      ? parseJsonArray(row.payload_fallbacks_json)
      : undefined;
    const timeoutSeconds = normalizeNumber(row.payload_timeout_seconds);
    const allowUnsafeExternalContent =
      row.payload_allow_unsafe_external_content != null
        ? integerToBoolean(row.payload_allow_unsafe_external_content)
        : undefined;
    const externalContentSource = parseExternalContentSource(
      row.payload_external_content_source_json,
    );
    const lightContext =
      row.payload_light_context != null ? integerToBoolean(row.payload_light_context) : undefined;
    const toolsAllow = row.payload_tools_allow_json
      ? parseJsonArray(row.payload_tools_allow_json)
      : undefined;
    return {
      kind: "agentTurn",
      message: row.payload_message,
      ...(row.payload_model ? { model: row.payload_model } : {}),
      ...(fallbacks ? { fallbacks } : {}),
      ...(row.payload_thinking ? { thinking: row.payload_thinking } : {}),
      ...(timeoutSeconds != null ? { timeoutSeconds } : {}),
      ...(allowUnsafeExternalContent != null ? { allowUnsafeExternalContent } : {}),
      ...(externalContentSource ? { externalContentSource } : {}),
      ...(lightContext != null ? { lightContext } : {}),
      ...(toolsAllow ? { toolsAllow } : {}),
    };
  }
  if (row.payload_kind === "command") {
    if (row.payload_message == null) {
      return null;
    }
    const extras = row.payload_external_content_source_json
      ? parseJsonObject<Record<string, unknown>>(row.payload_external_content_source_json, {})
      : {};
    const args = Array.isArray(extras.args)
      ? extras.args.filter((item): item is string => typeof item === "string")
      : undefined;
    const env = parseStringRecord(extras.env);
    const outputMode = parseOutputMode(extras.outputMode);
    const timeoutSeconds = normalizeNumber(row.payload_timeout_seconds);
    return {
      kind: "command",
      command: row.payload_message,
      ...(args && args.length > 0 ? { args } : {}),
      ...(typeof extras.cwd === "string" ? { cwd: extras.cwd } : {}),
      ...(env ? { env } : {}),
      ...(timeoutSeconds != null ? { timeoutSeconds } : {}),
      ...(typeof extras.successRegex === "string" ? { successRegex: extras.successRegex } : {}),
      ...(typeof extras.failureRegex === "string" ? { failureRegex: extras.failureRegex } : {}),
      ...(typeof extras.summaryRegex === "string" ? { summaryRegex: extras.summaryRegex } : {}),
      ...(outputMode ? { outputMode } : {}),
    };
  }
  return null;
}
