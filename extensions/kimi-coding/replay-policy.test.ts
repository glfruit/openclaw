import { describe, expect, it } from "vitest";
import { KIMI_REPLAY_POLICY } from "./replay-policy.js";

describe("kimi replay policy", () => {
  it("uses full transcript repair for Kimi replay compatibility", () => {
    expect(KIMI_REPLAY_POLICY).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      repairToolUseResultPairing: true,
      preserveSignatures: false,
      dropThinkingBlocks: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });
  });
});
