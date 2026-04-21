import { readFile } from "node:fs/promises";
import path from "node:path";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  buildAnnounceIdFromChildRun,
  buildAnnounceIdempotencyKey,
} from "./announce-idempotency.js";
import {
  buildEduTlStandingOrderRecoveredMilestone,
  buildEduTlStandingOrderRepairNeededMessage,
  inspectEduTlTextbookProgressionContract,
} from "./edu-tl-textbook-progression-contract.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
  runAnnounceDeliveryWithRetry,
  resolveSubagentAnnounceTimeoutMs,
  resolveSubagentCompletionOrigin,
} from "./subagent-announce-delivery.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";
import {
  applySubagentWaitOutcome,
  buildChildCompletionFindings,
  buildCompactAnnounceStatsLine,
  dedupeLatestChildCompletionRows,
  filterCurrentDirectChildCompletionRows,
  readLatestSubagentOutputWithRetry,
  readSubagentOutput,
  type SubagentRunOutcome,
  waitForSubagentRunOutcome,
} from "./subagent-announce-output.js";
import {
  callGateway,
  isEmbeddedPiRunActive,
  loadConfig,
  waitForEmbeddedPiRunEnd,
} from "./subagent-announce.runtime.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";
import { extractAssistantText, sanitizeTextContent } from "./tools/session-message-text.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

type SubagentAnnounceDeps = {
  callGateway: typeof callGateway;
  loadConfig: typeof loadConfig;
  loadSubagentRegistryRuntime: typeof loadSubagentRegistryRuntime;
};

const defaultSubagentAnnounceDeps: SubagentAnnounceDeps = {
  callGateway,
  loadConfig,
  loadSubagentRegistryRuntime,
};

let subagentAnnounceDeps: SubagentAnnounceDeps = defaultSubagentAnnounceDeps;

let subagentRegistryRuntimePromise: Promise<
  typeof import("./subagent-announce.registry.runtime.js")
> | null = null;

function loadSubagentRegistryRuntime() {
  subagentRegistryRuntimePromise ??= import("./subagent-announce.registry.runtime.js");
  return subagentRegistryRuntimePromise;
}

export { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";
export { captureSubagentCompletionReply } from "./subagent-announce-output.js";
export type { SubagentRunOutcome } from "./subagent-announce-output.js";

export type SubagentAnnounceType = "subagent task" | "cron job";

function buildAnnounceReplyInstruction(params: {
  requesterIsSubagent: boolean;
  announceType: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
}): string {
  if (params.requesterIsSubagent) {
    return `Convert this completion into a concise internal orchestration update for your parent agent in your own words. Keep this internal context private (don't mention system/log/stats/session details or announce type). If this result is duplicate or no update is needed, reply ONLY: ${SILENT_REPLY_TOKEN}.`;
  }
  if (params.expectsCompletionMessage) {
    return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type).`;
  }
  return `A completed ${params.announceType} is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.`;
}

function buildAnnounceSteerMessage(events: AgentInternalEvent[]): string {
  return (
    formatAgentInternalEventsForPrompt(events) ||
    "A background task finished. Process the completion update now."
  );
}

function hasUsableSessionEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const sessionId = (entry as { sessionId?: unknown }).sessionId;
  return typeof sessionId !== "string" || sessionId.trim() !== "";
}

function buildDescendantWakeMessage(params: { findings: string; taskLabel: string }): string {
  return [
    "[Subagent Context] Your prior run ended while waiting for descendant subagent completions.",
    "[Subagent Context] All pending descendants for that run have now settled.",
    "[Subagent Context] Continue your workflow using these results. Spawn more subagents if needed, otherwise send your final answer.",
    "",
    `Task: ${params.taskLabel}`,
    "",
    params.findings,
  ].join("\n");
}

function isEduTlWorkspaceDir(workspaceDir: unknown): boolean {
  return (
    typeof workspaceDir === "string" &&
    /(?:^|[\\/])workspace-edu-tl(?:[\\/]|$)/u.test(workspaceDir.trim())
  );
}

function hasEduTlMilestoneSemantics(text: string, taskLabel: string): boolean {
  const combined = `${taskLabel}\n${text}`;
  const hasArtifactPath =
    /(?:^|[\s(])(?:~\/|\.\.?\/|\/)[^\s)]+\.(?:md|docx?|pptx?|xlsx?|pdf|html|txt|json)\b/iu.test(
      combined,
    ) ||
    /(?:^|[\s(])(?:courses|artifacts)\/[^\s)]+\.(?:md|docx?|pptx?|xlsx?|pdf|html|txt|json)\b/iu.test(
      combined,
    );
  const hasMilestoneFieldLabel = EDU_TL_TEXTBOOK_MILESTONE_REQUIRED_FIELDS.some((field) =>
    new RegExp(`(?:^|\\n)(?:[-*]\\s*)?(?:["'])?${field}(?:["'])?\\s*[：:=]`, "iu").test(combined),
  );
  const hasStructuredMilestoneField =
    /(?:^|\n)(?:[-*]\s*)?(?:["'])?(?:completed_items|key_pass_points|major_risks)(?:["'])?\s*[：:=]/iu.test(
      combined,
    );
  const hasExplicitMilestoneCue =
    /\b(?:textbook|course)\b[^\n]{0,40}\bmilestone\b/iu.test(combined) ||
    /\bmilestone\b[^\n]{0,40}\b(?:textbook|course)\b/iu.test(combined) ||
    /(?:教材|课程)(?:[^\n]{0,20})里程碑/u.test(combined) ||
    /里程碑(?:[^\n]{0,20})(?:教材|课程)/u.test(combined);
  return (
    hasArtifactPath &&
    (hasMilestoneFieldLabel || hasStructuredMilestoneField || hasExplicitMilestoneCue)
  );
}

function shouldRecoverEduTlMilestoneReply(params: {
  childEntry: unknown;
  requesterEntry: unknown;
  taskLabel: string;
  rawText: string;
}): boolean {
  const childWorkspaceDir = (params.childEntry as { workspaceDir?: unknown } | undefined)
    ?.workspaceDir;
  const requesterWorkspaceDir = (params.requesterEntry as { workspaceDir?: unknown } | undefined)
    ?.workspaceDir;
  if (!isEduTlWorkspaceDir(childWorkspaceDir) && !isEduTlWorkspaceDir(requesterWorkspaceDir)) {
    return false;
  }
  return hasEduTlMilestoneSemantics(params.rawText, params.taskLabel);
}

const EDU_TL_TEXTBOOK_MILESTONE_REQUIRED_FIELDS = [
  "current_total_progress",
  "state_layering",
  "next_stage",
] as const;

const EDU_TL_TEXTBOOK_MILESTONE_OPTIONAL_FIELDS = [
  "completed_items",
  "key_pass_points",
  "major_risks",
] as const;

const EDU_TL_TEXTBOOK_MILESTONE_COMPLIANCE_FIELDS = [
  ...EDU_TL_TEXTBOOK_MILESTONE_OPTIONAL_FIELDS,
  ...EDU_TL_TEXTBOOK_MILESTONE_REQUIRED_FIELDS,
] as const;

type EduTlTextbookMilestoneField = (typeof EDU_TL_TEXTBOOK_MILESTONE_REQUIRED_FIELDS)[number];
type EduTlTextbookMilestoneComplianceField =
  (typeof EDU_TL_TEXTBOOK_MILESTONE_COMPLIANCE_FIELDS)[number];

function hasEduTlTextbookCourseMilestoneScope(text: string, taskLabel: string): boolean {
  const combined = `${taskLabel}\n${text}`;
  const hasCourseArtifactPath =
    /(?:^|[\s(])courses\/[^\s)]+\/(?:manuscript|output)\/[^\s)]+\.(?:md|docx?|pdf|html|txt|json)\b/iu.test(
      combined,
    );
  const hasRequiredFieldLabel = EDU_TL_TEXTBOOK_MILESTONE_REQUIRED_FIELDS.some((field) =>
    new RegExp(`(?:^|\\n)(?:[-*]\\s*)?(?:["'])?${field}(?:["'])?\\s*[：:=]`, "iu").test(combined),
  );
  const hasStructuredMilestoneField =
    /(?:^|\n)(?:[-*]\s*)?(?:["'])?(?:completed_items|key_pass_points|major_risks)(?:["'])?\s*[：:=]/iu.test(
      combined,
    );
  const hasExplicitMilestoneCue =
    /\b(?:textbook|course)\b[^\n]{0,40}\bmilestone\b/iu.test(combined) ||
    /\bmilestone\b[^\n]{0,40}\b(?:textbook|course)\b/iu.test(combined) ||
    /(?:教材|课程)(?:[^\n]{0,20})里程碑/u.test(combined) ||
    /里程碑(?:[^\n]{0,20})(?:教材|课程)/u.test(combined);
  return (
    hasCourseArtifactPath &&
    (hasRequiredFieldLabel || hasStructuredMilestoneField || hasExplicitMilestoneCue)
  );
}

function isEduTlTextbookCourseMilestone(params: {
  childEntry: unknown;
  requesterEntry: unknown;
  taskLabel: string;
  rawText: string;
}): boolean {
  if (
    !shouldRecoverEduTlMilestoneReply({
      childEntry: params.childEntry,
      requesterEntry: params.requesterEntry,
      taskLabel: params.taskLabel,
      rawText: params.rawText,
    })
  ) {
    return false;
  }
  return hasEduTlTextbookCourseMilestoneScope(params.rawText, params.taskLabel);
}

function extractEduTlTextbookLabeledField(
  text: string,
  field: EduTlTextbookMilestoneComplianceField,
): string | undefined {
  const lines = text.split(/\r?\n/u);
  const pattern = new RegExp(`^(?:[-*]\\s*)?(?:["'])?${field}(?:["'])?\\s*[：:=]\\s*(.+)$`, "iu");
  for (const line of lines) {
    const match = line.match(pattern);
    const value = normalizeOptionalString(match?.[1]);
    if (value) {
      return value;
    }
  }

  const inlinePattern = new RegExp(`(?:["'])?${field}(?:["'])?\\s*[：:=]\\s*([^,;\\n}]+)`, "iu");
  return normalizeOptionalString(text.match(inlinePattern)?.[1]) ?? undefined;
}

function listMissingEduTlTextbookMilestoneFields(text: string): EduTlTextbookMilestoneField[] {
  return EDU_TL_TEXTBOOK_MILESTONE_REQUIRED_FIELDS.filter(
    (field) => !extractEduTlTextbookLabeledField(text, field),
  );
}

function parseEduTlTextbookComplianceFields(
  text: string,
): Partial<Record<EduTlTextbookMilestoneComplianceField, string>> {
  const entries = EDU_TL_TEXTBOOK_MILESTONE_COMPLIANCE_FIELDS.flatMap((field) => {
    const value = extractEduTlTextbookLabeledField(text, field);
    return value ? ([[field, value]] as const) : [];
  });
  return Object.fromEntries(entries) as Partial<
    Record<EduTlTextbookMilestoneComplianceField, string>
  >;
}

function isEduTlTextbookComplianceFieldLine(line: string): boolean {
  return EDU_TL_TEXTBOOK_MILESTONE_COMPLIANCE_FIELDS.some((field) =>
    new RegExp(`^(?:[-*]\\s*)?(?:["'])?${field}(?:["'])?\\s*[：:=]`, "iu").test(line.trim()),
  );
}

function buildEduTlTextbookMilestoneNarrationLead(
  fields: Partial<Record<EduTlTextbookMilestoneComplianceField, string>>,
): string {
  const leadSource =
    fields.completed_items ??
    fields.key_pass_points ??
    fields.current_total_progress ??
    fields.next_stage;
  const trimmedLead = normalizeOptionalString(leadSource)?.replace(/[。.!?；;]+$/u, "") ?? "";
  return trimmedLead
    ? `战况更新：${trimmedLead}。`
    : "战况更新：里程碑推进已完成，详细合规进展如下。";
}

function isEduTlDraftCompleteGuardNoticeLine(line: string): boolean {
  return (
    /当前仅为正文首稿已落盘，不是终稿，尚不可交付/u.test(line) ||
    /This is first-draft landed only, not final, and not deliverable until editorial or publisher gate passes\./iu.test(
      line,
    )
  );
}

function formatEduTlTextbookCourseMilestoneForOutwardDelivery(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  const fields = parseEduTlTextbookComplianceFields(trimmed);
  const complianceBlock = EDU_TL_TEXTBOOK_MILESTONE_COMPLIANCE_FIELDS.flatMap((field) => {
    const value = normalizeOptionalString(fields[field]);
    return value ? [`${field}: ${value}`] : [];
  }).join("\n");
  if (!complianceBlock) {
    return trimmed;
  }

  const narrationLines = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isEduTlTextbookComplianceFieldLine(line));
  const substantiveNarrationLines = narrationLines.filter(
    (line) => !isEduTlDraftCompleteGuardNoticeLine(line),
  );
  const lead =
    substantiveNarrationLines.length > 0
      ? narrationLines.join("\n")
      : [buildEduTlTextbookMilestoneNarrationLead(fields), ...narrationLines].join("\n");

  return `${lead}\n\n${complianceBlock}`.trim();
}

function isEduTlDraftCompleteMilestone(text: string): boolean {
  return (
    /\b(?:draft-complete|draft\s+complete|first\s+draft|body\s+draft|draft\s+landed)\b/iu.test(
      text,
    ) || /(?:首稿|初稿|正文首稿|正文初稿|落盘)/u.test(text)
  );
}

function hasEduTlEditorialOrPublisherGatePassed(text: string): boolean {
  return (
    /\b(?:editorial|publisher)\b[^\n]{0,40}\b(?:passed|approved|accepted|cleared|signed\s+off)\b/iu.test(
      text,
    ) || /(?:编辑|审校|出版社|出版)(?:[^\n]{0,20})(?:通过|已过|已批准|已验收)/u.test(text)
  );
}

function hasEduTlExplicitDraftLanding(text: string): boolean {
  return (
    /\b(?:first\s+draft|body\s+draft|draft\s+landed|draft\s+complete)\b/iu.test(text) ||
    /(?:首稿已落盘|正文首稿已落盘|首稿完成|正文初稿完成|仅完成首稿|仅完成正文首稿)/u.test(text)
  );
}

function hasEduTlExplicitNotFinal(text: string): boolean {
  return /\bnot\s+final\b/iu.test(text) || /(?:不是终稿|非终稿|尚未终稿|未到终稿)/u.test(text);
}

function hasEduTlExplicitNotDeliverable(text: string): boolean {
  return (
    /\bnot\s+deliverable\b/iu.test(text) ||
    /(?:不可交付|尚不可交付|未达交付|不能交付|未到可交付)/u.test(text)
  );
}

function enforceEduTlDraftCompleteMilestoneWording(text: string): string {
  if (!isEduTlDraftCompleteMilestone(text) || hasEduTlEditorialOrPublisherGatePassed(text)) {
    return text;
  }

  if (
    hasEduTlExplicitDraftLanding(text) &&
    hasEduTlExplicitNotFinal(text) &&
    hasEduTlExplicitNotDeliverable(text)
  ) {
    return text;
  }

  const notice = [
    "当前仅为正文首稿已落盘，不是终稿，尚不可交付，仍需编辑审校或出版社流程通过。",
    "This is first-draft landed only, not final, and not deliverable until editorial or publisher gate passes.",
  ].join(" ");
  return `${text.trim()}\n\n${notice}`.trim();
}

function validateEduTlTextbookCourseMilestone(text: string): {
  ok: boolean;
  missingFields: EduTlTextbookMilestoneField[];
} {
  const missingFields = listMissingEduTlTextbookMilestoneFields(text);
  return {
    ok: missingFields.length === 0,
    missingFields,
  };
}

function buildEduTlTextbookMilestoneRepairNeededMessage(params: {
  missingFields: EduTlTextbookMilestoneField[];
  findings: string;
}): string {
  const missing = params.missingFields.join(", ");
  return [
    `Repair needed before sending this edu-tl textbook/course milestone update: missing required field(s): ${missing}.`,
    "Please resend with explicit labeled values for current_total_progress, state_layering, and next_stage as applicable.",
    "Original report:",
    params.findings.trim(),
  ].join("\n\n");
}

function extractSubagentHistoryText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const role = (message as { role?: unknown }).role;
  const content = (message as { content?: unknown }).content;
  if (role === "assistant") {
    return extractAssistantText(message) ?? "";
  }
  if (typeof content === "string") {
    return sanitizeTextContent(content);
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") {
      return sanitizeTextContent(text);
    }
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (
    extractTextFromChatContent(content, {
      sanitizeText: sanitizeTextContent,
      normalizeText: (text) => text,
      joinWith: "\n",
    }) ?? ""
  );
}

function resolveEduTlWorkspaceDir(params: {
  childEntry: unknown;
  requesterEntry: unknown;
}): string | null {
  const childWorkspaceDir = normalizeOptionalString(
    (params.childEntry as { workspaceDir?: unknown } | undefined)?.workspaceDir,
  );
  if (childWorkspaceDir && isEduTlWorkspaceDir(childWorkspaceDir)) {
    return childWorkspaceDir;
  }
  const requesterWorkspaceDir = normalizeOptionalString(
    (params.requesterEntry as { workspaceDir?: unknown } | undefined)?.workspaceDir,
  );
  if (requesterWorkspaceDir && isEduTlWorkspaceDir(requesterWorkspaceDir)) {
    return requesterWorkspaceDir;
  }
  return null;
}

function parseStandingOrderLineField(line: string, field: string): string | undefined {
  const match = line.match(new RegExp(`(?:^|\\s)${field}=([^\\s]+)`, "u"));
  return normalizeOptionalString(match?.[1]) ?? undefined;
}

function parseStandingOrderMilestoneField(line: string, field: string): string | undefined {
  if (field === "payload") {
    const match = line.match(/(?:^|\s)payload=(\{.*\})$/u);
    return normalizeOptionalString(match?.[1]) ?? undefined;
  }
  return parseStandingOrderLineField(line, field);
}

function extractLatestStandingOrderMilestoneLine(texts: string[]): string | undefined {
  return [...texts].toReversed().find((text) => /^STANDING_ORDER_MILESTONE\b/u.test(text));
}

function isStandingOrderMilestoneOnlyReply(text: string | undefined): boolean {
  const normalized = normalizeOptionalString(text);
  return typeof normalized === "string" && /^STANDING_ORDER_MILESTONE\b/u.test(normalized);
}

function isStandingOrderControlOnlyReply(text: string | undefined): boolean {
  const normalized = normalizeOptionalString(text);
  return typeof normalized === "string" && /^STANDING_ORDER_READY\b/u.test(normalized);
}

function buildStandingOrderMilestoneDraft(line: string): string | undefined {
  const payloadRaw = parseStandingOrderMilestoneField(line, "payload");
  if (!payloadRaw) {
    return undefined;
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const fieldOrder = [
    "completed_items",
    "key_pass_points",
    "current_total_progress",
    "state_layering",
    "next_stage",
    "major_risks",
  ] as const;
  const lines = fieldOrder.flatMap((field) => {
    const value = normalizeOptionalString(payload[field]);
    return value ? [`${field}: ${value}`] : [];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

async function maybeRecoverStandingOrderMilestoneAnnouncement(params: {
  sessionKey: string;
}): Promise<string | undefined> {
  const history = await subagentAnnounceDeps.callGateway({
    method: "chat.history",
    params: { sessionKey: params.sessionKey, limit: 100 },
  });
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const texts = messages
    .map((message) => extractSubagentHistoryText(message).trim())
    .filter((text) => text.length > 0);
  const latestMilestoneLine = extractLatestStandingOrderMilestoneLine(texts);
  if (!latestMilestoneLine) {
    return undefined;
  }
  return buildStandingOrderMilestoneDraft(latestMilestoneLine);
}

async function maybeRecoverEduTlStandingOrderProgressMilestone(params: {
  sessionKey: string;
  childEntry: unknown;
  requesterEntry: unknown;
}): Promise<string | undefined> {
  const workspaceDir = resolveEduTlWorkspaceDir(params);
  if (!workspaceDir) {
    return undefined;
  }

  const history = await subagentAnnounceDeps.callGateway({
    method: "chat.history",
    params: { sessionKey: params.sessionKey, limit: 100 },
  });
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const texts = messages
    .map((message) => extractSubagentHistoryText(message).trim())
    .filter((text) => text.length > 0);
  const latestReadyLine = [...texts]
    .toReversed()
    .find((text) => /^STANDING_ORDER_READY\b/u.test(text));
  if (!latestReadyLine) {
    return undefined;
  }
  const wroteStandingOrderThisRun = texts.some((text) =>
    /(?:standing-orders\.json|current-checkpoint\.md)/iu.test(text),
  );
  if (!wroteStandingOrderThisRun) {
    return undefined;
  }
  const pendingAction = parseStandingOrderLineField(latestReadyLine, "pending_action");
  const phase = parseStandingOrderLineField(latestReadyLine, "phase");
  const updatedAt = parseStandingOrderLineField(latestReadyLine, "updated_at");
  if (!pendingAction || !updatedAt) {
    return undefined;
  }

  let order: Record<string, unknown>;
  try {
    order = JSON.parse(
      await readFile(path.join(workspaceDir, "standing-orders.json"), "utf-8"),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const task = order.task;
  if (!task || typeof task !== "object") {
    return undefined;
  }
  const taskData = task as Record<string, unknown>;
  const currentPendingAction = normalizeOptionalString(taskData.pending_action);
  const currentPhase = normalizeOptionalString(taskData.current_phase);
  if (currentPendingAction !== pendingAction || currentPhase !== phase) {
    return buildEduTlStandingOrderRepairNeededMessage({
      inspection: {
        status: "repair_needed",
        contractId: "edu_tl_textbook_progression_v1",
        reason: "control_line_drift",
        diagnostics: [
          `ready_pending_action=${pendingAction}`,
          `order_pending_action=${currentPendingAction ?? "missing"}`,
          `ready_phase=${phase}`,
          `order_phase=${currentPhase ?? "missing"}`,
        ],
        pendingAction,
      },
      readyLine: latestReadyLine,
    });
  }

  const inspection = await inspectEduTlTextbookProgressionContract(order);
  if (inspection.status === "matched") {
    return buildEduTlStandingOrderRecoveredMilestone(inspection);
  }
  if (inspection.status === "repair_needed") {
    return buildEduTlStandingOrderRepairNeededMessage({ inspection, readyLine: latestReadyLine });
  }
  return undefined;
}

const WAKE_RUN_SUFFIX = ":wake";

function stripWakeRunSuffixes(runId: string): string {
  let next = runId.trim();
  while (next.endsWith(WAKE_RUN_SUFFIX)) {
    next = next.slice(0, -WAKE_RUN_SUFFIX.length);
  }
  return next || runId.trim();
}

function isWakeContinuationRun(runId: string): boolean {
  const trimmed = runId.trim();
  if (!trimmed) {
    return false;
  }
  return stripWakeRunSuffixes(trimmed) !== trimmed;
}

async function wakeSubagentRunAfterDescendants(params: {
  runId: string;
  childSessionKey: string;
  taskLabel: string;
  findings: string;
  announceId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (params.signal?.aborted) {
    return false;
  }

  const childEntry = loadSessionEntryByKey(params.childSessionKey);
  if (!hasUsableSessionEntry(childEntry)) {
    return false;
  }

  const cfg = subagentAnnounceDeps.loadConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const wakeMessage = buildDescendantWakeMessage({
    findings: params.findings,
    taskLabel: params.taskLabel,
  });

  let wakeRunId = "";
  try {
    const wakeResponse = await runAnnounceDeliveryWithRetry<{ runId?: string }>({
      operation: "descendant wake agent call",
      signal: params.signal,
      run: async () =>
        await subagentAnnounceDeps.callGateway({
          method: "agent",
          params: {
            sessionKey: params.childSessionKey,
            message: wakeMessage,
            deliver: false,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: params.childSessionKey,
              sourceChannel: INTERNAL_MESSAGE_CHANNEL,
              sourceTool: "subagent_announce",
            },
            idempotencyKey: buildAnnounceIdempotencyKey(`${params.announceId}:wake`),
          },
          timeoutMs: announceTimeoutMs,
        }),
    });
    wakeRunId = normalizeOptionalString(wakeResponse?.runId) ?? "";
  } catch {
    return false;
  }

  if (!wakeRunId) {
    return false;
  }

  const { replaceSubagentRunAfterSteer } = await loadSubagentRegistryRuntime();
  return replaceSubagentRunAfterSteer({
    previousRunId: params.runId,
    nextRunId: wakeRunId,
    preserveFrozenResultFallback: true,
  });
}

export async function runSubagentAnnounceFlow(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  timeoutMs: number;
  cleanup: "delete" | "keep";
  roundOneReply?: string;
  /**
   * Fallback text preserved from the pre-wake run when a wake continuation
   * completes with NO_REPLY despite an earlier final summary already existing.
   */
  fallbackReply?: string;
  waitForCompletion?: boolean;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  outcome?: SubagentRunOutcome;
  announceType?: SubagentAnnounceType;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  wakeOnDescendantSettle?: boolean;
  signal?: AbortSignal;
  bestEffortDeliver?: boolean;
}): Promise<boolean> {
  let didAnnounce = false;
  const expectsCompletionMessage = params.expectsCompletionMessage === true;
  const announceType = params.announceType ?? "subagent task";
  let shouldDeleteChildSession = params.cleanup === "delete";
  try {
    let targetRequesterSessionKey = params.requesterSessionKey;
    let targetRequesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
    const childSessionId = (() => {
      const entry = loadSessionEntryByKey(params.childSessionKey);
      return typeof entry?.sessionId === "string" && entry.sessionId.trim()
        ? entry.sessionId.trim()
        : undefined;
    })();
    const settleTimeoutMs = Math.min(Math.max(params.timeoutMs, 1), 120_000);
    const childEntry = loadSessionEntryByKey(params.childSessionKey);
    let reply = params.roundOneReply;
    let outcome: SubagentRunOutcome | undefined = params.outcome;
    if (childSessionId && isEmbeddedPiRunActive(childSessionId)) {
      const settled = await waitForEmbeddedPiRunEnd(childSessionId, settleTimeoutMs);
      if (!settled && isEmbeddedPiRunActive(childSessionId)) {
        shouldDeleteChildSession = false;
        return false;
      }
    }

    if (!reply && params.waitForCompletion !== false) {
      const wait = await waitForSubagentRunOutcome(params.childRunId, settleTimeoutMs);
      const applied = applySubagentWaitOutcome({
        wait,
        outcome,
        startedAt: params.startedAt,
        endedAt: params.endedAt,
      });
      outcome = applied.outcome;
      params.startedAt = applied.startedAt;
      params.endedAt = applied.endedAt;
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    let requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
    const requesterIsInternalSession = () =>
      requesterDepth >= 1 || isCronSessionKey(targetRequesterSessionKey);

    let childCompletionFindings: string | undefined;
    let subagentRegistryRuntime:
      | Awaited<ReturnType<typeof loadSubagentRegistryRuntime>>
      | undefined;
    try {
      subagentRegistryRuntime = await subagentAnnounceDeps.loadSubagentRegistryRuntime();
      if (
        requesterDepth >= 1 &&
        subagentRegistryRuntime.shouldIgnorePostCompletionAnnounceForSession(
          targetRequesterSessionKey,
        )
      ) {
        return true;
      }

      const pendingChildDescendantRuns = Math.max(
        0,
        subagentRegistryRuntime.countPendingDescendantRuns(params.childSessionKey),
      );
      if (pendingChildDescendantRuns > 0 && announceType !== "cron job") {
        shouldDeleteChildSession = false;
        return false;
      }

      if (typeof subagentRegistryRuntime.listSubagentRunsForRequester === "function") {
        const directChildren = subagentRegistryRuntime.listSubagentRunsForRequester(
          params.childSessionKey,
          {
            requesterRunId: params.childRunId,
          },
        );
        if (Array.isArray(directChildren) && directChildren.length > 0) {
          childCompletionFindings = buildChildCompletionFindings(
            dedupeLatestChildCompletionRows(
              filterCurrentDirectChildCompletionRows(directChildren, {
                requesterSessionKey: params.childSessionKey,
                getLatestSubagentRunByChildSessionKey:
                  subagentRegistryRuntime.getLatestSubagentRunByChildSessionKey,
              }),
            ),
          );
        }
      }
    } catch {
      // Best-effort only.
    }

    const announceId = buildAnnounceIdFromChildRun({
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
    });

    const childRunAlreadyWoken = isWakeContinuationRun(params.childRunId);
    if (
      params.wakeOnDescendantSettle === true &&
      childCompletionFindings?.trim() &&
      !childRunAlreadyWoken
    ) {
      const wakeAnnounceId = buildAnnounceIdFromChildRun({
        childSessionKey: params.childSessionKey,
        childRunId: stripWakeRunSuffixes(params.childRunId),
      });
      const woke = await wakeSubagentRunAfterDescendants({
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        taskLabel: params.label || params.task || "task",
        findings: childCompletionFindings,
        announceId: wakeAnnounceId,
        signal: params.signal,
      });
      if (woke) {
        shouldDeleteChildSession = false;
        return true;
      }
    }

    if (!childCompletionFindings) {
      if (isAnnounceSkip(reply)) {
        return true;
      }
      const fallbackReply = normalizeOptionalString(params.fallbackReply);
      const fallbackIsSilent =
        Boolean(fallbackReply) &&
        (isAnnounceSkip(fallbackReply) || isSilentReplyText(fallbackReply, SILENT_REPLY_TOKEN));
      const requesterEntry = loadSessionEntryByKey(targetRequesterSessionKey);
      const taskLabel = params.label || params.task || "task";
      const preferEduTlMilestoneRawOnSilent = (rawText: string) =>
        shouldRecoverEduTlMilestoneReply({
          childEntry,
          requesterEntry,
          taskLabel,
          rawText,
        });

      if (
        fallbackReply &&
        isWakeContinuationRun(params.childRunId) &&
        reply &&
        isSilentReplyText(reply, SILENT_REPLY_TOKEN) &&
        !fallbackIsSilent
      ) {
        reply = fallbackReply;
      } else if (!reply || isSilentReplyText(reply, SILENT_REPLY_TOKEN)) {
        const recoveredReply = await readSubagentOutput(params.childSessionKey, outcome, {
          preferLatestRawOnSilent: preferEduTlMilestoneRawOnSilent,
        });
        if (recoveredReply?.trim()) {
          reply = recoveredReply;
        }
      }

      if (!reply?.trim()) {
        reply = await readLatestSubagentOutputWithRetry({
          sessionKey: params.childSessionKey,
          maxWaitMs: params.timeoutMs,
          outcome,
          preferLatestRawOnSilent: preferEduTlMilestoneRawOnSilent,
        });
      }

      if (!reply?.trim() && fallbackReply && !fallbackIsSilent) {
        reply = fallbackReply;
      }

      // A worker can finish just after the first wait request timed out.
      // If we already have real completion content, do one cached recheck so
      // the final completion event prefers the authoritative terminal state.
      // This is best-effort; if the recheck fails, keep the known timeout
      // outcome instead of dropping the announcement entirely.
      if (outcome?.status === "timeout" && reply?.trim() && params.waitForCompletion !== false) {
        try {
          const rechecked = await waitForSubagentRunOutcome(params.childRunId, 0);
          const applied = applySubagentWaitOutcome({
            wait: rechecked,
            outcome,
            startedAt: params.startedAt,
            endedAt: params.endedAt,
          });
          outcome = applied.outcome;
          params.startedAt = applied.startedAt;
          params.endedAt = applied.endedAt;
        } catch {
          // Best-effort recheck; keep the existing timeout outcome on failure.
        }
      }

      if (
        isAnnounceSkip(reply) ||
        isSilentReplyText(reply, SILENT_REPLY_TOKEN) ||
        isStandingOrderMilestoneOnlyReply(reply) ||
        isStandingOrderControlOnlyReply(reply)
      ) {
        const recoveredStandingOrderMilestone =
          await maybeRecoverStandingOrderMilestoneAnnouncement({
            sessionKey: params.childSessionKey,
          });
        if (recoveredStandingOrderMilestone) {
          reply = recoveredStandingOrderMilestone;
        } else {
          const recoveredReadyMilestone = await maybeRecoverEduTlStandingOrderProgressMilestone({
            sessionKey: params.childSessionKey,
            childEntry,
            requesterEntry,
          });
          if (recoveredReadyMilestone) {
            reply = recoveredReadyMilestone;
          } else if (fallbackReply && !fallbackIsSilent) {
            reply = fallbackReply;
          } else {
            return true;
          }
        }
      }
    }

    if (!outcome) {
      outcome = { status: "unknown" };
    }

    // Build status label
    const statusLabel =
      outcome.status === "ok"
        ? "completed successfully"
        : outcome.status === "timeout"
          ? "timed out"
          : outcome.status === "error"
            ? `failed: ${outcome.error || "unknown error"}`
            : "finished with unknown status";

    const taskLabel = params.label || params.task || "task";
    const announceSessionId = childSessionId || "unknown";
    let findings = childCompletionFindings || reply || "(no output)";

    let requesterIsSubagent = requesterIsInternalSession();
    if (requesterIsSubagent) {
      const {
        isSubagentSessionRunActive,
        resolveRequesterForChildSession,
        shouldIgnorePostCompletionAnnounceForSession,
      } = subagentRegistryRuntime ?? (await loadSubagentRegistryRuntime());
      if (!isSubagentSessionRunActive(targetRequesterSessionKey)) {
        if (shouldIgnorePostCompletionAnnounceForSession(targetRequesterSessionKey)) {
          return true;
        }
        const parentSessionEntry = loadSessionEntryByKey(targetRequesterSessionKey);
        const parentSessionAlive = hasUsableSessionEntry(parentSessionEntry);

        if (!parentSessionAlive) {
          const fallback = resolveRequesterForChildSession(targetRequesterSessionKey);
          if (!fallback?.requesterSessionKey) {
            shouldDeleteChildSession = false;
            return false;
          }
          targetRequesterSessionKey = fallback.requesterSessionKey;
          targetRequesterOrigin =
            normalizeDeliveryContext(fallback.requesterOrigin) ?? targetRequesterOrigin;
          requesterDepth = getSubagentDepthFromSessionStore(targetRequesterSessionKey);
          requesterIsSubagent = requesterIsInternalSession();
        }
      }
    }

    const requesterEntry = loadSessionEntryByKey(targetRequesterSessionKey);
    if (
      expectsCompletionMessage &&
      !requesterIsSubagent &&
      isEduTlTextbookCourseMilestone({
        childEntry,
        requesterEntry,
        taskLabel,
        rawText: findings,
      })
    ) {
      findings = enforceEduTlDraftCompleteMilestoneWording(findings);
      const validation = validateEduTlTextbookCourseMilestone(findings);
      if (!validation.ok) {
        defaultRuntime.error?.(
          `Blocked edu-tl milestone outward announce for run ${params.childRunId}: missing ${validation.missingFields.join(", ")}`,
        );
        findings = buildEduTlTextbookMilestoneRepairNeededMessage({
          missingFields: validation.missingFields,
          findings,
        });
      } else {
        findings = formatEduTlTextbookCourseMilestoneForOutwardDelivery(findings);
      }
    }

    const replyInstruction = buildAnnounceReplyInstruction({
      requesterIsSubagent,
      announceType,
      expectsCompletionMessage,
    });
    const statsLine = await buildCompactAnnounceStatsLine({
      sessionKey: params.childSessionKey,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
    });
    const internalEvents: AgentInternalEvent[] = [
      {
        type: "task_completion",
        source: announceType === "cron job" ? "cron" : "subagent",
        childSessionKey: params.childSessionKey,
        childSessionId: announceSessionId,
        announceType,
        taskLabel,
        status: outcome.status,
        statusLabel,
        result: findings,
        statsLine,
        replyInstruction,
      },
    ];
    const triggerMessage = buildAnnounceSteerMessage(internalEvents);

    // Send to the requester session. For nested subagents this is an internal
    // follow-up injection (deliver=false) so the orchestrator receives it.
    let directOrigin = targetRequesterOrigin;
    if (!requesterIsSubagent) {
      const { entry } = loadRequesterSessionEntry(targetRequesterSessionKey);
      directOrigin = resolveAnnounceOrigin(entry, targetRequesterOrigin);
    }
    const completionDirectOrigin =
      expectsCompletionMessage && !requesterIsSubagent
        ? await resolveSubagentCompletionOrigin({
            childSessionKey: params.childSessionKey,
            requesterSessionKey: targetRequesterSessionKey,
            requesterOrigin: directOrigin,
            childRunId: params.childRunId,
            spawnMode: params.spawnMode,
            expectsCompletionMessage,
          })
        : targetRequesterOrigin;
    const directIdempotencyKey = buildAnnounceIdempotencyKey(announceId);
    const delivery = await deliverSubagentAnnouncement({
      requesterSessionKey: targetRequesterSessionKey,
      announceId,
      triggerMessage,
      steerMessage: triggerMessage,
      internalEvents,
      summaryLine: taskLabel,
      requesterSessionOrigin: targetRequesterOrigin,
      requesterOrigin:
        expectsCompletionMessage && !requesterIsSubagent
          ? completionDirectOrigin
          : targetRequesterOrigin,
      completionDirectOrigin,
      directOrigin,
      sourceSessionKey: params.childSessionKey,
      sourceChannel: INTERNAL_MESSAGE_CHANNEL,
      sourceTool: "subagent_announce",
      targetRequesterSessionKey,
      requesterIsSubagent,
      expectsCompletionMessage: expectsCompletionMessage,
      bestEffortDeliver: params.bestEffortDeliver,
      directIdempotencyKey,
      signal: params.signal,
    });
    didAnnounce = delivery.delivered;
    if (!delivery.delivered && delivery.path === "direct" && delivery.error) {
      defaultRuntime.error?.(
        `Subagent completion direct announce failed for run ${params.childRunId}: ${delivery.error}`,
      );
    }
  } catch (err) {
    defaultRuntime.error?.(`Subagent announce failed: ${String(err)}`);
    // Best-effort follow-ups; ignore failures to avoid breaking the caller response.
  } finally {
    // Patch label after all writes complete
    if (params.label) {
      try {
        await subagentAnnounceDeps.callGateway({
          method: "sessions.patch",
          params: { key: params.childSessionKey, label: params.label },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort
      }
    }
    if (shouldDeleteChildSession) {
      try {
        await subagentAnnounceDeps.callGateway({
          method: "sessions.delete",
          params: {
            key: params.childSessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: params.spawnMode === "session",
          },
          timeoutMs: 10_000,
        });
      } catch {
        // ignore
      }
    }
  }
  return didAnnounce;
}

export const __testing = {
  enforceEduTlDraftCompleteMilestoneWording,
  buildEduTlTextbookMilestoneRepairNeededMessage,
  formatEduTlTextbookCourseMilestoneForOutwardDelivery,
  hasEduTlTextbookCourseMilestoneScope,
  validateEduTlTextbookCourseMilestone,
  setDepsForTest(overrides?: Partial<SubagentAnnounceDeps>) {
    subagentAnnounceDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeps,
          ...overrides,
        }
      : defaultSubagentAnnounceDeps;
  },
};
