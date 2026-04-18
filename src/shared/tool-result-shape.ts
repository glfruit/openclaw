import crypto from "node:crypto";

export type ToolResultCompatibilityMode = "legacy-read-only" | "enforced" | "disabled";
export type ToolResultPathFamily = "sessions_send" | "review_qa" | "runtime_coherence";
export type ToolResultStatus = "accepted" | "completed" | "blocked" | "failed" | "requires_human";
export type ToolFailureSemantics =
  | "retryable"
  | "blocked"
  | "requires_human"
  | "partial_commit"
  | "permanent_failure";

export type ToolResultShapeKernel = {
  artifact_id: string;
  artifact_type: string;
  schema_version: 1;
  producer: string;
  consumer: string;
  result_status: ToolResultStatus;
  failure_semantics: ToolFailureSemantics | null;
  evidence_pointers: string[];
  validation_commands: string[];
  timestamp: string;
};

export type SessionsSendResultShape = ToolResultShapeKernel & {
  artifact_type: "sessions_send_result";
  delivery_status: string;
  reply_window_status: string;
  run_id: string;
  session_key: string;
  note?: string;
};

export type ReviewQaResultShape = ToolResultShapeKernel & {
  artifact_type: "review_verdict";
  verdict: string;
  top_blockers: string[];
  remaining_risks: string[];
  gate_decision: string;
  candidate_label?: string;
  baseline_label?: string;
  candidate_metrics?: unknown;
  baseline_metrics?: unknown;
  scenario_comparisons?: unknown;
  failures?: string[];
  notes?: string[];
};

export type RuntimeCoherenceResultShape = ToolResultShapeKernel & {
  artifact_type: "patrol_summary";
  check_name: string;
  exit_code: number;
  finding_level: string;
  finding_count: number;
  overall?: unknown;
  findings?: unknown[];
  mode?: string;
  static_manifest_path?: string;
  runtime_snapshot_path?: string;
};

export type ToolResultShape =
  | SessionsSendResultShape
  | ReviewQaResultShape
  | RuntimeCoherenceResultShape;

const TOOL_RESULT_MODES = new Set<ToolResultCompatibilityMode>([
  "legacy-read-only",
  "enforced",
  "disabled",
]);
const TOOL_RESULT_STATUSES = new Set<ToolResultStatus>([
  "accepted",
  "completed",
  "blocked",
  "failed",
  "requires_human",
]);
const TOOL_FAILURE_SEMANTICS = new Set<ToolFailureSemantics>([
  "retryable",
  "blocked",
  "requires_human",
  "partial_commit",
  "permanent_failure",
]);

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function makeArtifactId(parts: unknown[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    const chunk =
      typeof part === "string" ? part : part === undefined ? "__undefined__" : JSON.stringify(part);
    hash.update(chunk);
    hash.update("\u001f");
  }
  return hash.digest("hex").slice(0, 32);
}

function inferSessionsReplyWindowStatus(raw: Record<string, unknown>): string {
  const note = typeof raw.note === "string" ? raw.note : "";
  if (note.includes("still pending")) {
    return "pending";
  }
  if (note.includes("not ready before timeout")) {
    return "timed_out";
  }
  return "not_waited";
}

function inferSessionsFailureSemantics(raw: Record<string, unknown>): ToolFailureSemantics | null {
  const note = typeof raw.note === "string" ? raw.note : "";
  if (note.includes("still pending") || note.includes("not ready before timeout")) {
    return "requires_human";
  }
  return null;
}

export function resolveToolResultCompatibilityMode(
  pathFamily: ToolResultPathFamily,
  env: NodeJS.ProcessEnv = process.env,
): ToolResultCompatibilityMode {
  const raw =
    (pathFamily === "sessions_send"
      ? env.OPENCLAW_TOOL_RESULT_SHAPE_SESSIONS_SEND_MODE
      : pathFamily === "review_qa"
        ? env.OPENCLAW_TOOL_RESULT_SHAPE_REVIEW_QA_MODE
        : env.OPENCLAW_TOOL_RESULT_SHAPE_RUNTIME_COHERENCE_MODE) ??
    env.OPENCLAW_TOOL_RESULT_SHAPE_MODE ??
    "legacy-read-only";
  return TOOL_RESULT_MODES.has(raw as ToolResultCompatibilityMode)
    ? (raw as ToolResultCompatibilityMode)
    : "legacy-read-only";
}

export function mapLegacyToShape(
  raw: unknown,
  pathFamily: ToolResultPathFamily,
  options: {
    producer: string;
    consumer: string;
    evidencePointers?: string[];
    validationCommands?: string[];
    timestamp?: string;
    artifactType?: string;
    exitCode?: number;
    checkName?: string;
  },
): ToolResultShape {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const evidencePointers = normalizeStringArray(options.evidencePointers);
  const validationCommands = normalizeStringArray(options.validationCommands);

  if (pathFamily === "sessions_send") {
    const payload = (raw ?? {}) as Record<string, unknown>;
    return {
      artifact_id: makeArtifactId([
        "sessions_send_result",
        options.producer,
        options.consumer,
        payload.runId,
        payload.sessionKey,
        payload.status,
        payload.note,
      ]),
      artifact_type: "sessions_send_result",
      schema_version: 1,
      producer: options.producer,
      consumer: options.consumer,
      result_status: "accepted",
      failure_semantics: inferSessionsFailureSemantics(payload),
      evidence_pointers: evidencePointers,
      validation_commands: validationCommands,
      timestamp,
      delivery_status:
        typeof (payload.delivery as { status?: unknown } | undefined)?.status === "string"
          ? (payload.delivery as { status: string }).status
          : typeof payload.status === "string"
            ? payload.status
            : "accepted",
      reply_window_status: inferSessionsReplyWindowStatus(payload),
      run_id: typeof payload.runId === "string" ? payload.runId : "",
      session_key: typeof payload.sessionKey === "string" ? payload.sessionKey : "",
      ...(typeof payload.note === "string" ? { note: payload.note } : {}),
    } satisfies SessionsSendResultShape;
  }

  if (pathFamily === "review_qa") {
    const payload = (raw ?? {}) as Record<string, unknown>;
    const pass = payload.pass === true;
    const failures = normalizeStringArray(payload.failures);
    const notes = normalizeStringArray(payload.notes);
    return {
      artifact_id: makeArtifactId([
        "review_verdict",
        options.producer,
        options.consumer,
        payload.candidateLabel,
        payload.baselineLabel,
        payload.comparedAt,
        failures,
      ]),
      artifact_type: "review_verdict",
      schema_version: 1,
      producer: options.producer,
      consumer: options.consumer,
      result_status: pass ? "completed" : "blocked",
      failure_semantics: pass ? null : "blocked",
      evidence_pointers: evidencePointers,
      validation_commands: validationCommands,
      timestamp,
      verdict: pass ? "pass" : "fail",
      top_blockers: failures,
      remaining_risks: notes,
      gate_decision: pass ? "pass" : "blocked",
      ...(typeof payload.candidateLabel === "string"
        ? { candidate_label: payload.candidateLabel }
        : {}),
      ...(typeof payload.baselineLabel === "string"
        ? { baseline_label: payload.baselineLabel }
        : {}),
      ...(payload.candidateMetrics !== undefined
        ? { candidate_metrics: payload.candidateMetrics }
        : {}),
      ...(payload.baselineMetrics !== undefined
        ? { baseline_metrics: payload.baselineMetrics }
        : {}),
      ...(payload.scenarioComparisons !== undefined
        ? { scenario_comparisons: payload.scenarioComparisons }
        : {}),
      ...(failures.length > 0 ? { failures } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    } satisfies ReviewQaResultShape;
  }

  const payload = (raw ?? {}) as Record<string, unknown>;
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const overall = (payload.overall ?? {}) as Record<string, unknown>;
  const highestSeverity =
    typeof overall.highest_severity === "string"
      ? overall.highest_severity
      : typeof overall.status === "string"
        ? overall.status
        : findings.length > 0
          ? "warn"
          : "ok";
  const resultStatus: ToolResultStatus = findings.length === 0 ? "completed" : "blocked";
  return {
    artifact_id: makeArtifactId([
      "patrol_summary",
      options.producer,
      options.consumer,
      payload.generated_at,
      highestSeverity,
      findings.length,
    ]),
    artifact_type: "patrol_summary",
    schema_version: 1,
    producer: options.producer,
    consumer: options.consumer,
    result_status: resultStatus,
    failure_semantics: findings.length === 0 ? null : "blocked",
    evidence_pointers: evidencePointers,
    validation_commands: validationCommands,
    timestamp,
    check_name: options.checkName ?? "runtime_coherence",
    exit_code:
      typeof options.exitCode === "number" ? options.exitCode : findings.length > 0 ? 10 : 0,
    finding_level: highestSeverity,
    finding_count: findings.length,
    ...(payload.overall !== undefined ? { overall: payload.overall } : {}),
    ...(findings.length > 0 ? { findings } : { findings: [] }),
    ...(typeof payload.mode === "string" ? { mode: payload.mode } : {}),
    ...(typeof payload.static_manifest_path === "string"
      ? { static_manifest_path: payload.static_manifest_path }
      : {}),
    ...(typeof payload.runtime_snapshot_path === "string"
      ? { runtime_snapshot_path: payload.runtime_snapshot_path }
      : {}),
  } satisfies RuntimeCoherenceResultShape;
}

export function shapeResult(
  raw: unknown,
  pathFamily: ToolResultPathFamily,
  options: {
    producer: string;
    consumer: string;
    compatibilityMode?: ToolResultCompatibilityMode;
    evidencePointers?: string[];
    validationCommands?: string[];
    timestamp?: string;
    artifactType?: string;
    exitCode?: number;
    checkName?: string;
  },
): unknown {
  const compatibilityMode =
    options.compatibilityMode ?? resolveToolResultCompatibilityMode(pathFamily);
  if (compatibilityMode !== "enforced") {
    return raw;
  }
  return mapLegacyToShape(raw, pathFamily, options);
}

export function validateResultShape(payload: unknown): payload is ToolResultShape {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.artifact_id !== "string" || !candidate.artifact_id) {
    return false;
  }
  if (typeof candidate.artifact_type !== "string" || !candidate.artifact_type) {
    return false;
  }
  if (candidate.schema_version !== 1) {
    return false;
  }
  if (typeof candidate.producer !== "string" || !candidate.producer) {
    return false;
  }
  if (typeof candidate.consumer !== "string" || !candidate.consumer) {
    return false;
  }
  if (!TOOL_RESULT_STATUSES.has(candidate.result_status as ToolResultStatus)) {
    return false;
  }
  if (
    candidate.failure_semantics !== null &&
    !TOOL_FAILURE_SEMANTICS.has(candidate.failure_semantics as ToolFailureSemantics)
  ) {
    return false;
  }
  if (
    !Array.isArray(candidate.evidence_pointers) ||
    !candidate.evidence_pointers.every((entry) => typeof entry === "string")
  ) {
    return false;
  }
  if (
    !Array.isArray(candidate.validation_commands) ||
    !candidate.validation_commands.every((entry) => typeof entry === "string")
  ) {
    return false;
  }
  if (typeof candidate.timestamp !== "string" || !candidate.timestamp) {
    return false;
  }
  return true;
}
