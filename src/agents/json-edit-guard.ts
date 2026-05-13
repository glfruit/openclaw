import path from "node:path";
import { splitShellArgs } from "../utils/shell-argv.js";

const JSON_EDIT_GUIDANCE =
  "Use the json-safe-edit path: parse JSON/JSONL, mutate through a serializer, write through a temp file, and validate before replacing. Emergency repair requires a dedicated repair path with parse-failure evidence, backup, bounded patch, and final parse validation.";

export function buildRawJsonEditRejectionMessage(target: string): string {
  return `Raw JSON/JSONL mutation is blocked for ${target}. ${JSON_EDIT_GUIDANCE}`;
}

export function isJsonOrJsonlPath(filePath: string): boolean {
  const normalized = filePath.trim().replace(/\\+/gu, "/").toLowerCase();
  return normalized.endsWith(".json") || normalized.endsWith(".jsonl");
}

export function assertNoRawJsonEditTarget(targets: Iterable<string | undefined | null>): void {
  for (const target of targets) {
    if (!target) {
      continue;
    }
    if (isJsonOrJsonlPath(target)) {
      throw new Error(buildRawJsonEditRejectionMessage(target));
    }
  }
}

export function isProtectedExecJsonPath(filePath: string): boolean {
  const normalized = filePath
    .trim()
    .replace(/\\+/gu, "/")
    .replace(/^['"]|['"]$/gu, "");
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);
  return (
    base === "standing-orders.json" ||
    base === "current-project.json" ||
    base === "jobs.json" ||
    lower.endsWith("/cron/jobs.json") ||
    base.endsWith(".ledger.json") ||
    base.endsWith(".ledger.jsonl")
  );
}

function tokenizeShell(command: string): string[] {
  const argv = splitShellArgs(command);
  if (argv) {
    return argv;
  }
  return command.match(/[^\s]+/gu) ?? [];
}

function hasProtectedPathToken(text: string): boolean {
  return tokenizeShell(text).some((token) => isProtectedExecJsonPath(token));
}

function hasProtectedPathMention(text: string): boolean {
  const protectedPathPattern =
    /(?:^|[\s'"`(])((?:\.\.?\/|~\/|\/)?[A-Za-z0-9._~\/-]*(?:standing-orders\.json|current-project\.json|(?:cron\/)?jobs\.json|[A-Za-z0-9._~-]+\.ledger\.jsonl?))(?:$|[\s'"`)>,;])/iu;
  return protectedPathPattern.test(text);
}

function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  const push = () => {
    const trimmed = buf.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    buf = "";
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && ch === "\\") {
      buf += ch;
      escaped = true;
      continue;
    }
    if (inSingle) {
      buf += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      buf += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }
    if (
      ch === ";" ||
      ch === "\n" ||
      ch === "\r" ||
      (ch === "&" && next === "&") ||
      (ch === "|" && next === "|")
    ) {
      push();
      if ((ch === "&" || ch === "|") && next === ch) i += 1;
      continue;
    }
    buf += ch;
  }
  push();
  return segments;
}

function segmentExecutable(segment: string): string {
  const argv = tokenizeShell(segment);
  let idx = 0;
  while (idx < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[idx] ?? "")) {
    idx += 1;
  }
  return path.basename((argv[idx] ?? "").toLowerCase()).replace(/\.(?:exe|cmd)$/u, "");
}

function hasInPlaceEditorWrite(segment: string): boolean {
  const argv = tokenizeShell(segment);
  const exe = segmentExecutable(segment);
  if (exe !== "sed" && exe !== "perl") {
    return false;
  }
  const hasInPlace = argv.some(
    (arg) => arg === "-i" || arg.startsWith("-i") || arg === "-pi" || arg.startsWith("-pi"),
  );
  return hasInPlace && argv.some((arg) => isProtectedExecJsonPath(arg));
}

function hasRawRedirectionWrite(segment: string): boolean {
  const redirectionPattern = /(?:^|\s)(?:>>|>|1>|&>)\s*(['"]?)([^\s'";&|]+)\1/gu;
  let match: RegExpExecArray | null;
  while ((match = redirectionPattern.exec(segment)) !== null) {
    if (isProtectedExecJsonPath(match[2] ?? "")) {
      return true;
    }
  }
  return false;
}

function hasPythonRawWrite(command: string): boolean {
  if (!/\bpython(?:3(?:\.\d+)?)?\b/iu.test(command)) {
    return false;
  }
  if (!hasProtectedPathMention(command)) {
    return false;
  }
  return (
    /\.write_text\s*\(/u.test(command) ||
    /\bopen\s*\([^)]*['"]w[bt+]?['"]/u.test(command) ||
    /\bopen\s*\([^)]*['"]a[bt+]?['"]/u.test(command)
  );
}

function hasNodeRawWrite(command: string): boolean {
  if (!/\bnode\b/iu.test(command)) {
    return false;
  }
  if (!hasProtectedPathMention(command)) {
    return false;
  }
  return /(?:\bfs(?:\.promises)?\.writeFile(?:Sync)?\s*\(|\brequire\s*\(\s*['"](?:node:)?fs['"]\s*\)\s*(?:\.promises)?\.writeFile(?:Sync)?\s*\()/u.test(
    command,
  );
}

function hasTeeProtectedWrite(segment: string): boolean {
  const argv = tokenizeShell(segment);
  for (let i = 0; i < argv.length; i += 1) {
    const exe = path.basename(argv[i]?.toLowerCase() ?? "").replace(/\.(?:exe|cmd)$/u, "");
    if (exe !== "tee") {
      continue;
    }
    for (let j = i + 1; j < argv.length; j += 1) {
      const arg = argv[j] ?? "";
      if (arg === "--") {
        continue;
      }
      if (arg.startsWith("-")) {
        continue;
      }
      if (isProtectedExecJsonPath(arg)) {
        return true;
      }
    }
  }
  return false;
}

function hasObviousJqOverwrite(segment: string): boolean {
  return segmentExecutable(segment) === "jq" && hasRawRedirectionWrite(segment);
}

export function detectRawJsonExecWrite(command: string): { blocked: boolean; reason?: string } {
  const raw = command.trim();
  if (!raw) {
    return { blocked: false };
  }
  if (hasPythonRawWrite(raw)) {
    return { blocked: true, reason: "python raw write" };
  }
  if (hasNodeRawWrite(raw)) {
    return { blocked: true, reason: "node fs raw write" };
  }
  for (const segment of shellSegments(raw)) {
    if (hasInPlaceEditorWrite(segment)) {
      return { blocked: true, reason: "in-place editor write" };
    }
    if (hasObviousJqOverwrite(segment)) {
      return { blocked: true, reason: "jq overwrite" };
    }
    if (hasTeeProtectedWrite(segment)) {
      return { blocked: true, reason: "tee raw write" };
    }
    if (hasRawRedirectionWrite(segment) && hasProtectedPathToken(segment)) {
      return { blocked: true, reason: "shell redirection write" };
    }
  }
  return { blocked: false };
}

export function assertNoRawJsonExecWrite(command: string): void {
  const detected = detectRawJsonExecWrite(command);
  if (detected.blocked) {
    throw new Error(buildRawJsonEditRejectionMessage(detected.reason ?? "exec command"));
  }
}
