import { describe, expect, it } from "vitest";
import { KIMI_REPLAY_POLICY } from "./replay-policy.js";

describe("kimi replay policy", () => {
  it("enables strict Anthropic-compatible replay repair without signature preservation", () => {
    expect(KIMI_REPLAY_POLICY).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveSignatures: false,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });
  });
});
