import { describe, expect, it } from "vitest";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
} from "../../bootstrap-budget.js";
import { composeSystemPromptWithHookContext } from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt bootstrap warning prompt assembly", () => {
  it("computes bootstrap truncation warnings without injecting them into the body prompt", () => {
    const analysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles: [
          {
            name: "AGENTS.md",
            path: "/tmp/openclaw-warning-workspace/AGENTS.md",
            content: "A".repeat(200),
            missing: false,
          },
        ],
        injectedFiles: [{ path: "AGENTS.md", content: "A".repeat(20) }],
      }),
      bootstrapMaxChars: 50,
      bootstrapTotalMaxChars: 50,
    });
    const warning = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });

    // Warning is computed and available for telemetry/report.
    expect(warning.warningShown).toBe(true);
    expect(warning.lines.length).toBeGreaterThan(0);
    expect(warning.lines[0]).toContain("AGENTS.md");

    // Body prompt stays clean — warning is not injected.
    const systemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt: "hello",
      prependSystemContext: "hook context",
    });
    expect(systemPrompt).toContain("hook context");
    expect(systemPrompt).toContain("hello");
    expect(systemPrompt).not.toContain("[Bootstrap truncation warning]");
  });
});
