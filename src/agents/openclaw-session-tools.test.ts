import { describe, expect, it } from "vitest";
import { createOpenClawSessionTools } from "./openclaw-session-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawSessionTools", () => {
  it("registers the dedicated session tool lane in the existing order", () => {
    expect(createOpenClawSessionTools().map((tool) => tool.name)).toEqual([
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_yield",
      "sessions_spawn",
    ]);
  });

  it("keeps the omnibus composer exposing the same session tool block", () => {
    const allNames = createOpenClawTools({ disablePluginTools: true }).map((tool) => tool.name);
    const sessionNames = allNames.filter((name) => name.startsWith("sessions_"));
    expect(sessionNames).toEqual([
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_yield",
      "sessions_spawn",
    ]);
  });
});
