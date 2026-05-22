import { isSessionWriteLockTimeoutError } from "./session-write-lock-error.js";

const TAKEOVER_ERROR_NAME = "EmbeddedAttemptSessionTakeoverError";
const TAKEOVER_MESSAGE = "session file changed while embedded prompt lock was released";

function readErrorName(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function readErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) {
    return err.message;
  }
  if (!err || typeof err !== "object") {
    return typeof err === "string" ? err : undefined;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function hasProviderFailureMetadata(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const candidate = err as { status?: unknown; code?: unknown; reason?: unknown };
  return (
    typeof candidate.status === "number" ||
    typeof candidate.code === "string" ||
    typeof candidate.reason === "string"
  );
}

export function isSessionContentionError(err: unknown, seen: Set<object> = new Set()): boolean {
  if (isSessionWriteLockTimeoutError(err)) {
    return true;
  }
  if (readErrorName(err) === TAKEOVER_ERROR_NAME) {
    return true;
  }
  if (readErrorMessage(err)?.includes(TAKEOVER_MESSAGE)) {
    return true;
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  if (hasProviderFailureMetadata(err)) {
    return false;
  }
  if (seen.has(err)) {
    return false;
  }
  seen.add(err);
  const candidate = err as { error?: unknown; cause?: unknown; reason?: unknown };
  return (
    isSessionContentionError(candidate.error, seen) ||
    isSessionContentionError(candidate.cause, seen) ||
    isSessionContentionError(candidate.reason, seen)
  );
}
