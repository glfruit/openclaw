import { describe, expect, it } from "vitest";
import { createOpenClawMessageTools } from "./openclaw-message-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawMessageTools", () => {
  it("registers the dedicated message tool lane", () => {
    expect(createOpenClawMessageTools().map((tool) => tool.name)).toEqual(["message"]);
  });

  it("keeps the omnibus composer exposing the same message tool", () => {
    const allNames = createOpenClawTools({ disablePluginTools: true }).map((tool) => tool.name);
    expect(allNames.filter((name) => name === "message")).toEqual(["message"]);
  });

  it("preserves disableMessageTool gating through the dedicated lane", () => {
    expect(createOpenClawMessageTools({ disableMessageTool: true })).toEqual([]);
  });
});
