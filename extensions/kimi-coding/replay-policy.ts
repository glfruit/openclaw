export const KIMI_REPLAY_POLICY = {
  sanitizeMode: "full",
  sanitizeToolCallIds: true,
  toolCallIdMode: "strict",
  preserveSignatures: false,
  repairToolUseResultPairing: true,
  validateAnthropicTurns: true,
  allowSyntheticToolResults: true,
} as const;
