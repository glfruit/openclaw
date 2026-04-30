import { describe, expect, it } from "vitest";
import { classifyRuntimeTurnLane, isAutonomousTurnLane } from "./turn-lane.js";

describe("classifyRuntimeTurnLane", () => {
  it("classifies normal provider inbound messages as live_user", () => {
    expect(classifyRuntimeTurnLane({ Provider: "telegram" })).toBe("live_user");
    expect(classifyRuntimeTurnLane({ Provider: "whatsapp", Surface: "webchat" })).toBe("live_user");
  });

  it("classifies autonomous providers without overloading session keys", () => {
    expect(classifyRuntimeTurnLane({ Provider: "heartbeat" })).toBe("heartbeat");
    expect(classifyRuntimeTurnLane({ Provider: "cron-event" })).toBe("cron");
    expect(classifyRuntimeTurnLane({ Provider: "exec-event" })).toBe("maintenance");
  });

  it("honors trusted explicit runtime lane metadata", () => {
    expect(
      classifyRuntimeTurnLane({ Provider: "telegram", RuntimeTurnLane: "operator_recovery" }),
    ).toBe("operator_recovery");
  });

  it("marks only autonomous lanes as autonomous", () => {
    expect(isAutonomousTurnLane("heartbeat")).toBe(true);
    expect(isAutonomousTurnLane("cron")).toBe(true);
    expect(isAutonomousTurnLane("maintenance")).toBe(true);
    expect(isAutonomousTurnLane("live_user")).toBe(false);
  });
});
