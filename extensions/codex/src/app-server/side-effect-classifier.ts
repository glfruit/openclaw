import type { CodexDynamicToolDiagnosticTerminalType } from "./protocol.js";

type DynamicToolSideEffectParams = {
  toolName: string;
  args: unknown;
  terminalType: CodexDynamicToolDiagnosticTerminalType;
  asyncStarted: boolean;
  terminate: boolean;
};

const READ_ONLY_ACTIONS = new Set([
  "audit",
  "check",
  "describe",
  "doctor",
  "fetch",
  "find",
  "get",
  "inspect",
  "list",
  "probe",
  "query",
  "read",
  "search",
  "show",
  "status",
  "view",
  "version",
]);

const MUTATING_ACTIONS = new Set([
  "add",
  "archive",
  "apply",
  "build",
  "cleanup",
  "commit",
  "create",
  "delete",
  "deploy",
  "dispatch",
  "download",
  "edit",
  "generate",
  "install",
  "kill",
  "merge",
  "move",
  "open",
  "patch",
  "post",
  "publish",
  "push",
  "remove",
  "render",
  "reply",
  "restart",
  "save",
  "send",
  "spawn",
  "start",
  "stop",
  "submit",
  "sync",
  "terminate",
  "update",
  "upload",
  "write",
  "yield",
]);

const SIDE_EFFECTING_TOOL_NAMES = new Set([
  "apply_patch",
  "browser",
  "chrome",
  "computer",
  "email",
  "file_write",
  "image_generate",
  "mail",
  "message",
  "music_generate",
  "process",
  "send_email",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "video_generate",
  "write",
]);

export function isLikelySideEffectingDynamicToolCall({
  toolName,
  args,
  terminalType,
  asyncStarted,
  terminate,
}: DynamicToolSideEffectParams): boolean {
  if (terminalType === "blocked") {
    return false;
  }
  if (asyncStarted || terminate) {
    return true;
  }

  const normalizedName = normalizeToken(toolName);
  const action = readToolAction(args);

  if (action && MUTATING_ACTIONS.has(action)) {
    return true;
  }
  if (normalizedName === "exec" || normalizedName === "bash" || normalizedName === "shell") {
    const command = readToolCommand(args);
    return command ? isLikelyMutatingShellCommand(command) : true;
  }
  if (SIDE_EFFECTING_TOOL_NAMES.has(normalizedName)) {
    return true;
  }
  if (toolNameContainsAction(normalizedName, MUTATING_ACTIONS)) {
    return true;
  }
  if (action && READ_ONLY_ACTIONS.has(action)) {
    return false;
  }
  if (toolNameContainsAction(normalizedName, READ_ONLY_ACTIONS)) {
    return false;
  }

  return true;
}

export function isLikelyMutatingShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (hasObviousShellMutation(lower)) {
    return true;
  }
  return !isReadOnlyShellCommand(lower);
}

function readToolAction(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const action = args.action;
  return typeof action === "string" ? normalizeToken(action) : undefined;
}

function readToolCommand(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  for (const key of ["command", "cmd", "script"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function toolNameContainsAction(name: string, actions: Set<string>): boolean {
  return name.split("_").some((part) => actions.has(part));
}

function hasObviousShellMutation(command: string): boolean {
  if (hasWriteRedirection(command)) {
    return true;
  }
  return [
    /\b(?:apply_patch|chmod|chown|dd|kill|launchctl|mkdir|mv|osascript|pkill|rm|rmdir|rsync|scp|sftp|tee|touch|trash|xattr)\b/,
    /\b(?:npm|pnpm|yarn)\s+(?:add|build|install|link|publish|remove|run|uninstall|update)\b/,
    /\bgit\s+(?:am|apply|checkout|clean|commit|merge|pull|push|rebase|reset|stash|switch|tag)\b/,
    /\b(?:curl|wget)\b.*\s-o\s+\S+/,
  ].some((pattern) => pattern.test(command));
}

function hasWriteRedirection(command: string): boolean {
  const withoutDevNull = command.replace(/\b[012]?>\s*\/dev\/null\b/g, "");
  return /(^|[\s;&|])(?:[0-9])?>{1,2}\s*\S/.test(withoutDevNull);
}

function isReadOnlyShellCommand(command: string): boolean {
  const normalizedCommand = stripReadOnlyWrappers(command);
  return normalizedCommand
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .filter((segment) => segment.trim().length > 0)
    .every((segment) => isReadOnlyShellSegment(segment.trim()));
}

function isReadOnlyShellSegment(segment: string): boolean {
  const normalized = stripReadOnlyWrappers(segment);
  if (isReadOnlyInlinePythonCommand(normalized)) {
    return true;
  }
  return [
    /^(?:pwd|ls|cat|sed|awk|grep|rg|head|tail|stat|file|wc|jq|ps|pgrep|lsof|df|du)\b/,
    /^find\b(?!.*\s-(?:delete|exec|execdir|ok)\b)/,
    /^git\s+(?:status|diff|show|log|rev-parse|describe)\b/,
    /^git\s+branch\s+--show-current\b/,
    /^npm\s+(?:list|view|--version|version\b)/,
    /^pnpm\s+(?:list|--version|version\b)/,
    /^node\s+--version\b/,
    /^openclaw\s+--version\b/,
    /^curl\b(?=.*\breadyz\b)(?!.*\b(?:-x|--request)\s+(?:post|put|patch|delete)\b)/,
    /^bash\s+scripts\/tmux-run\.sh\s+--(?:status|list)\b/,
    /^python3?\s+-m\s+json\.tool\b/,
    /^python3?\s+\S*(?:audit|check|status|probe|doctor|inspect)[\w-]*\.py\b/,
    /^uv\s+run\b.*\bpython3?\s+\S*(?:audit|check|status|probe|doctor|inspect)[\w-]*\.py\b/,
  ].some((pattern) => pattern.test(normalized));
}

function stripReadOnlyWrappers(segment: string): string {
  let value = segment.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const previous = value;
    value = value.replace(/^(?:env\s+)?(?:[A-Z_][A-Z0-9_]*=\S+\s+)*/i, "");
    value = value.replace(/^(?:g?timeout|command)\s+(?:-\S+\s+)*\d+(?:\.\d+)?\s+/, "");
    value = stripShellCommandWrapper(value);
    if (value === previous) {
      break;
    }
  }
  return value.trim();
}

function stripShellCommandWrapper(segment: string): string {
  const match = segment.match(
    /^(?:(?:\/(?:usr\/)?bin\/)?(?:bash|zsh|sh))\s+-[a-z]*c\s+([\s\S]+)$/i,
  );
  if (!match) {
    return segment;
  }
  return unquoteShellCommandArgument(match[1] ?? "").trim() || segment;
}

function unquoteShellCommandArgument(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"') || trimmed[trimmed.length - 1] !== quote) {
    return trimmed;
  }
  const body = trimmed.slice(1, -1);
  return quote === '"' ? body.replace(/\\(["\\$`])/g, "$1").replace(/\\n/g, "\n") : body;
}

function isReadOnlyInlinePythonCommand(command: string): boolean {
  const match = command.match(/^python3?\s+-\s*<<\s*['"]?([a-z0-9_]+)['"]?\s*\n([\s\S]*)\n\1\s*$/i);
  if (!match) {
    return false;
  }
  const script = match[2] ?? "";
  return !hasLikelyMutatingPythonCode(script);
}

function hasLikelyMutatingPythonCode(script: string): boolean {
  return [
    /\b(?:subprocess|shutil)\./,
    /\bos\.(?:system|popen|remove|unlink|rename|replace|rmdir|mkdir|makedirs|chmod|chown|kill|spawn|fork|exec)\b/,
    /\.(?:save|write|write_text|write_bytes|unlink|remove|rename|replace|mkdir|rmdir|touch|chmod|chown)\s*\(/,
    /\bopen\s*\([^)]*,\s*['"][^'"]*[wax+]/,
    /\b(?:json|pickle)\.dump\s*\(/,
    /\b(?:requests|httpx)\.(?:post|put|patch|delete)\s*\(/,
    /\burllib\.request\.request\s*\([^)]*method\s*=\s*['"](?:post|put|patch|delete)['"]/,
  ].some((pattern) => pattern.test(script));
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
