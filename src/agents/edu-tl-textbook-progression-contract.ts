import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const CONTRACT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/edu_tl_textbook_progression_contract.json",
);

type EduTlStandingOrderAction = {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  artifact?: unknown;
  notes?: unknown;
  verdict?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
};

type EduTlStandingOrderTask = {
  current_phase?: unknown;
  pending_action?: unknown;
  updated_at?: unknown;
  next_actions?: unknown;
  continuation?: unknown;
};

type EduTlStandingOrder = {
  updated_at?: unknown;
  waiting_on?: unknown;
  stop_gate?: unknown;
  continuation?: unknown;
  task?: unknown;
};

type EduTlTextbookProgressionContract = {
  contract_id: string;
  activation: {
    required_phase: string;
    dispatch_action_pattern: string;
    review_action_pattern: string;
    review_action_template: string;
  };
  timestamps: {
    review_completed_field: string;
    dispatch_started_field: string;
    order_updated_field: string;
    require_dispatch_started_equals_order_updated: boolean;
    max_edge_gap_seconds: number;
  };
  required_action_fields: {
    review: string[];
    dispatch: string[];
  };
};

type EduTlTextbookProgressionInspection =
  | { status: "not_applicable" }
  | { status: "duplicate"; progressionKey: string }
  | {
      status: "repair_needed";
      contractId: string;
      reason: string;
      diagnostics: string[];
      pendingAction?: string;
      reviewAction?: string;
    }
  | {
      status: "matched";
      contractId: string;
      progressionKey: string;
      reviewAction: string;
      reviewArtifact?: string;
      reviewCompletedAt: string;
      reviewNotes?: string;
      reviewLabel: string;
      dispatchAction: string;
      dispatchArtifact?: string;
      dispatchStartedAt: string;
      dispatchLabel: string;
      projectNumber: number;
      previousProjectNumber: number;
      edgeGapSeconds: number;
      passedSummary: string;
      inProgressSummary: string;
      waitingOn?: string;
      stopGate?: string;
      dispatchNotes?: string;
    };

let contractPromise: Promise<EduTlTextbookProgressionContract> | null = null;

async function loadContract(): Promise<EduTlTextbookProgressionContract> {
  contractPromise ??= readFile(CONTRACT_PATH, "utf-8").then(
    (text) => JSON.parse(text) as EduTlTextbookProgressionContract,
  );
  return await contractPromise;
}

function parseIsoTimestamp(value: unknown): Date | undefined {
  const normalized = normalizeOptionalString(value)?.replace(/Z$/u, "+00:00");
  if (!normalized) {
    return undefined;
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function getTask(order: EduTlStandingOrder): EduTlStandingOrderTask | undefined {
  return order.task && typeof order.task === "object"
    ? (order.task as EduTlStandingOrderTask)
    : undefined;
}

function getNextActions(task: EduTlStandingOrderTask | undefined): EduTlStandingOrderAction[] {
  return Array.isArray(task?.next_actions)
    ? (task?.next_actions.filter(
        (action): action is EduTlStandingOrderAction =>
          Boolean(action) && typeof action === "object",
      ) ?? [])
    : [];
}

function findAction(
  actions: EduTlStandingOrderAction[],
  actionId: string,
): EduTlStandingOrderAction | undefined {
  return actions.find((action) => normalizeOptionalString(action.id) === actionId);
}

function hasContractSignal(
  task: EduTlStandingOrderTask | undefined,
  actions: EduTlStandingOrderAction[],
): boolean {
  const pendingAction = normalizeOptionalString(task?.pending_action) ?? "";
  if (pendingAction.includes("dispatch_project")) {
    return true;
  }
  return actions.some((action) => {
    const actionId = normalizeOptionalString(action.id) ?? "";
    return actionId.startsWith("dispatch_project") || actionId.startsWith("review_project");
  });
}

function missingRequiredFields(
  action: EduTlStandingOrderAction | undefined,
  fields: string[],
): string[] {
  if (!action) {
    return [...fields];
  }
  return fields.filter(
    (field) => !normalizeOptionalString(action[field as keyof EduTlStandingOrderAction]),
  );
}

function normalizeActionLabel(
  action: EduTlStandingOrderAction | undefined,
  fallbackId?: string,
): string {
  return (
    normalizeOptionalString(action?.title) ?? normalizeOptionalString(fallbackId) ?? "当前动作"
  );
}

function buildRepairInspection(params: {
  contractId: string;
  reason: string;
  diagnostics: string[];
  pendingAction?: string;
  reviewAction?: string;
}): EduTlTextbookProgressionInspection {
  return {
    status: "repair_needed",
    contractId: params.contractId,
    reason: params.reason,
    diagnostics: params.diagnostics,
    pendingAction: params.pendingAction,
    reviewAction: params.reviewAction,
  };
}

export async function inspectEduTlTextbookProgressionContract(
  order: EduTlStandingOrder,
): Promise<EduTlTextbookProgressionInspection> {
  const contract = await loadContract();
  const task = getTask(order);
  const actions = getNextActions(task);
  if (!hasContractSignal(task, actions)) {
    return { status: "not_applicable" };
  }

  const pendingAction = normalizeOptionalString(task?.pending_action) ?? undefined;
  const currentPhase = normalizeOptionalString(task?.current_phase) ?? undefined;
  if (currentPhase !== contract.activation.required_phase) {
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "phase_drift",
      diagnostics: [
        `expected_phase=${contract.activation.required_phase}`,
        `actual_phase=${currentPhase ?? "missing"}`,
      ],
      pendingAction,
    });
  }

  const dispatchMatch = pendingAction?.match(
    new RegExp(contract.activation.dispatch_action_pattern, "u"),
  );
  if (!dispatchMatch) {
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "action_id_drift",
      diagnostics: [
        `expected_dispatch_pattern=${contract.activation.dispatch_action_pattern}`,
        `actual_pending_action=${pendingAction ?? "missing"}`,
      ],
      pendingAction,
    });
  }

  const dispatchActionId = pendingAction ?? dispatchMatch[0] ?? "";
  const projectNumber = Number.parseInt(dispatchMatch[1] ?? "", 10);
  if (!Number.isFinite(projectNumber) || projectNumber <= 1) {
    return { status: "not_applicable" };
  }
  const partNumber = normalizeOptionalString(dispatchMatch[2]);
  const partSuffix = partNumber ? `_part${partNumber}` : "";
  const reviewActionId = contract.activation.review_action_template
    .replace("{project}", String(projectNumber - 1))
    .replace("{part_suffix}", partSuffix);

  const dispatchAction = findAction(actions, dispatchActionId);
  if (!dispatchAction) {
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "missing_required_fields",
      diagnostics: [`missing_action_record=${dispatchActionId}`],
      pendingAction: dispatchActionId,
      reviewAction: reviewActionId,
    });
  }

  const dispatchMissing = missingRequiredFields(
    dispatchAction,
    contract.required_action_fields.dispatch,
  );
  if (dispatchMissing.length > 0) {
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "missing_required_fields",
      diagnostics: [`dispatch_missing=${dispatchMissing.join(",")}`],
      pendingAction,
      reviewAction: reviewActionId,
    });
  }

  const reviewAction = findAction(actions, reviewActionId);
  if (!reviewAction) {
    const reviewCandidates = actions
      .map((action) => normalizeOptionalString(action.id))
      .filter((actionId): actionId is string =>
        Boolean(actionId?.match(new RegExp(contract.activation.review_action_pattern, "u"))),
      );
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "action_id_drift",
      diagnostics: [
        `expected_review_action=${reviewActionId}`,
        `review_candidates=${reviewCandidates.join(",") || "none"}`,
      ],
      pendingAction,
      reviewAction: reviewActionId,
    });
  }

  const reviewMissing = missingRequiredFields(reviewAction, contract.required_action_fields.review);
  if (reviewMissing.length > 0) {
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "missing_required_fields",
      diagnostics: [`review_missing=${reviewMissing.join(",")}`],
      pendingAction,
      reviewAction: reviewActionId,
    });
  }

  const reviewVerdict = normalizeOptionalString(reviewAction.verdict)?.toLowerCase();
  if (reviewVerdict !== "passed") {
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "review_verdict_drift",
      diagnostics: [
        "expected_review_verdict=passed",
        `actual_review_verdict=${reviewVerdict ?? "missing"}`,
      ],
      pendingAction,
      reviewAction: reviewActionId,
    });
  }

  const reviewCompletedAt = parseIsoTimestamp(
    reviewAction[contract.timestamps.review_completed_field as keyof EduTlStandingOrderAction],
  );
  const dispatchStartedAt = parseIsoTimestamp(
    dispatchAction[contract.timestamps.dispatch_started_field as keyof EduTlStandingOrderAction],
  );
  const updatedAt = parseIsoTimestamp(
    task?.[contract.timestamps.order_updated_field as keyof EduTlStandingOrderTask] ??
      order[contract.timestamps.order_updated_field as keyof EduTlStandingOrder],
  );
  const timestampMissing: string[] = [];
  if (!reviewCompletedAt) {
    timestampMissing.push(`review_${contract.timestamps.review_completed_field}`);
  }
  if (!dispatchStartedAt) {
    timestampMissing.push(`dispatch_${contract.timestamps.dispatch_started_field}`);
  }
  if (!updatedAt) {
    timestampMissing.push(`order_${contract.timestamps.order_updated_field}`);
  }
  if (timestampMissing.length > 0) {
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "missing_required_fields",
      diagnostics: [`timestamp_missing=${timestampMissing.join(",")}`],
      pendingAction: dispatchActionId,
      reviewAction: reviewActionId,
    });
  }

  const reviewCompletedDate = reviewCompletedAt!;
  const dispatchStartedDate = dispatchStartedAt!;
  const updatedDate = updatedAt!;

  if (dispatchStartedDate < reviewCompletedDate) {
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "timestamp_misalignment",
      diagnostics: [
        `dispatch_started_at=${dispatchStartedDate.toISOString()}`,
        `review_completed_at=${reviewCompletedDate.toISOString()}`,
        "dispatch_started_before_review_completed=true",
      ],
      pendingAction: dispatchActionId,
      reviewAction: reviewActionId,
    });
  }

  const edgeGapSeconds = Math.floor(
    (dispatchStartedDate.getTime() - reviewCompletedDate.getTime()) / 1000,
  );
  if (edgeGapSeconds > contract.timestamps.max_edge_gap_seconds) {
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "timestamp_misalignment",
      diagnostics: [
        `edge_gap_seconds=${edgeGapSeconds}`,
        `max_edge_gap_seconds=${contract.timestamps.max_edge_gap_seconds}`,
      ],
      pendingAction: dispatchActionId,
      reviewAction: reviewActionId,
    });
  }

  if (
    contract.timestamps.require_dispatch_started_equals_order_updated &&
    dispatchStartedDate.getTime() !== updatedDate.getTime()
  ) {
    return buildRepairInspection({
      contractId: contract.contract_id,
      reason: "timestamp_misalignment",
      diagnostics: [
        `dispatch_started_at=${dispatchStartedDate.toISOString()}`,
        `order_updated_at=${updatedDate.toISOString()}`,
        "dispatch_started_equals_order_updated=false",
      ],
      pendingAction: dispatchActionId,
      reviewAction: reviewActionId,
    });
  }

  const progressionKey = [
    reviewActionId,
    reviewCompletedDate.toISOString(),
    dispatchActionId,
    dispatchStartedDate.toISOString(),
  ].join("|");
  const continuation =
    task?.continuation && typeof task.continuation === "object"
      ? (task.continuation as Record<string, unknown>)
      : order.continuation && typeof order.continuation === "object"
        ? (order.continuation as Record<string, unknown>)
        : undefined;
  if (normalizeOptionalString(continuation?.last_progress_broadcast_key) === progressionKey) {
    return { status: "duplicate", progressionKey };
  }

  const passedSummary =
    actions
      .filter((action) => normalizeOptionalString(action.verdict)?.toLowerCase() === "passed")
      .map((action) =>
        normalizeActionLabel(action, normalizeOptionalString(action.id) ?? undefined),
      )
      .join("；") || "暂无";
  const inProgressSummary = actions
    .filter((action) => {
      const status = normalizeOptionalString(action.status);
      return status === "in_progress" || status === "pending";
    })
    .map((action) => normalizeActionLabel(action, normalizeOptionalString(action.id) ?? undefined))
    .join("；");

  return {
    status: "matched",
    contractId: contract.contract_id,
    progressionKey,
    reviewAction: reviewActionId,
    reviewArtifact: normalizeOptionalString(reviewAction.artifact) ?? undefined,
    reviewCompletedAt: reviewCompletedDate.toISOString(),
    reviewNotes: normalizeOptionalString(reviewAction.notes) ?? undefined,
    reviewLabel: normalizeActionLabel(reviewAction, reviewActionId),
    dispatchAction: dispatchActionId,
    dispatchArtifact: normalizeOptionalString(dispatchAction.artifact) ?? undefined,
    dispatchStartedAt: dispatchStartedDate.toISOString(),
    dispatchLabel: normalizeActionLabel(dispatchAction, dispatchActionId),
    projectNumber,
    previousProjectNumber: projectNumber - 1,
    edgeGapSeconds,
    passedSummary,
    inProgressSummary,
    waitingOn: normalizeOptionalString(order.waiting_on) ?? undefined,
    stopGate: normalizeOptionalString(order.stop_gate) ?? undefined,
    dispatchNotes: normalizeOptionalString(dispatchAction.notes) ?? undefined,
  };
}

export function buildEduTlStandingOrderRecoveredMilestone(
  inspection: Extract<EduTlTextbookProgressionInspection, { status: "matched" }>,
): string {
  const completedItems = [
    `${inspection.reviewLabel}已验收通过，verdict: passed${inspection.reviewArtifact ? `，artifact: ${inspection.reviewArtifact}` : ""}。`,
    `${inspection.dispatchLabel}已启动${inspection.dispatchArtifact ? `，artifact: ${inspection.dispatchArtifact}` : ""}。`,
  ].join("");
  const keyPassPoints =
    inspection.reviewNotes || `${inspection.reviewLabel}通过后已切到${inspection.dispatchLabel}。`;
  const currentTotalProgress = `已过 TL 结构验收: ${inspection.passedSummary}。当前推进: ${inspection.dispatchLabel}。`;
  const stateLayering = `已过审/强制门通过=${inspection.passedSummary}；editorial精修中或未完成=${inspection.inProgressSummary || inspection.dispatchLabel}；终稿可交付=暂无。`;
  const nextStage = inspection.dispatchNotes || `继续推进${inspection.dispatchLabel}。`;
  const majorRisks =
    inspection.stopGate ||
    inspection.waitingOn ||
    `${inspection.dispatchLabel}仍待正文首稿落盘后再进入下一门。`;

  return [
    `completed_items: ${completedItems}`,
    `key_pass_points: ${keyPassPoints}`,
    `current_total_progress: ${currentTotalProgress}`,
    `state_layering: ${stateLayering}`,
    `next_stage: ${nextStage}`,
    `major_risks: ${majorRisks}`,
  ].join("\n");
}

export function buildEduTlStandingOrderRepairNeededMessage(params: {
  inspection: Extract<EduTlTextbookProgressionInspection, { status: "repair_needed" }>;
  readyLine?: string;
}): string {
  const diagnostics = params.inspection.diagnostics.join("; ") || "none";
  return [
    `Repair needed before sending this edu-tl textbook/course milestone update: contract drift detected (${params.inspection.reason}).`,
    `Shared contract: ${params.inspection.contractId}.`,
    `Diagnostics: ${diagnostics}.`,
    params.inspection.pendingAction
      ? `Pending action: ${params.inspection.pendingAction}.`
      : undefined,
    params.inspection.reviewAction
      ? `Expected review action: ${params.inspection.reviewAction}.`
      : undefined,
    params.readyLine ? `Original standing-order control line:\n${params.readyLine}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}
