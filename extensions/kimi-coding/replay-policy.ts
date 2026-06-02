export const KIMI_REPLAY_POLICY = {
  sanitizeMode: "full",
  sanitizeToolCallIds: true,
  toolCallIdMode: "strict",
  repairToolUseResultPairing: true,
  preserveSignatures: false,
  dropThinkingBlocks: true,
  validateAnthropicTurns: true,
  allowSyntheticToolResults: true,
} as const;
