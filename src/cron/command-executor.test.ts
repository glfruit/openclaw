import { describe, expect, it } from "vitest";
import { executeCommandPayload, validateCommandPayload } from "./command-executor.js";

const NODE = process.execPath;

describe("validateCommandPayload", () => {
  it("rejects empty command", () => {
    expect(validateCommandPayload({ kind: "command", command: "" })).toBeDefined();
  });

  it("rejects relative command path", () => {
    expect(validateCommandPayload({ kind: "command", command: "echo" })).toMatch(/absolute path/i);
  });

  it("accepts valid absolute path", () => {
    expect(validateCommandPayload({ kind: "command", command: "/usr/bin/echo" })).toBeUndefined();
  });

  it("accepts valid payload with all optional fields", () => {
    expect(
      validateCommandPayload({
        kind: "command",
        command: "/usr/bin/python3",
        args: ["-c", "print('ok')"],
        cwd: "/tmp",
        env: { FOO: "bar" },
        timeoutSeconds: 60,
        successRegex: "^OK",
        failureRegex: "^ERR",
        summaryRegex: "^SUMMARY:(.+)",
        outputMode: "lastLine",
      }),
    ).toBeUndefined();
  });

  it("rejects invalid args (non-string array)", () => {
    expect(
      validateCommandPayload({ kind: "command", command: "/usr/bin/echo", args: [123 as any] }),
    ).toMatch(/string array/);
  });

  it("rejects invalid successRegex", () => {
    expect(
      validateCommandPayload({ kind: "command", command: "/usr/bin/echo", successRegex: "[" }),
    ).toMatch(/not a valid regex/);
  });

  it("rejects invalid failureRegex", () => {
    expect(
      validateCommandPayload({ kind: "command", command: "/usr/bin/echo", failureRegex: "(" }),
    ).toMatch(/not a valid regex/);
  });

  it("rejects invalid summaryRegex", () => {
    expect(
      validateCommandPayload({
        kind: "command",
        command: "/usr/bin/echo",
        summaryRegex: "[invalid",
      }),
    ).toMatch(/not a valid regex/);
  });
});

describe("executeCommandPayload", () => {
  it("returns ok for exit 0", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "console.log('HELLO_OK')"],
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("HELLO_OK");
  });

  it("returns error for non-zero exit", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "process.exit(1)"],
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/exited with code 1/);
  });

  it("returns error for timeout", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      timeoutSeconds: 1,
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/timed out/);
  });

  it("respects successRegex", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "console.log('STATUS_OK')"],
      successRegex: "STATUS_OK",
    });
    expect(result.status).toBe("ok");
  });

  it("fails when successRegex not matched", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "console.log('NO_MATCH')"],
      successRegex: "STATUS_OK",
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/successRegex did not match/);
  });

  it("respects failureRegex", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "console.log('FATAL_ERROR')"],
      failureRegex: "FATAL_ERROR",
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/failureRegex matched/);
  });

  it("extracts summary via summaryRegex", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "console.log('SUMMARY: 42 items')"],
      summaryRegex: "SUMMARY: (.+)",
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("42 items");
  });

  it("returns last line summary by default", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "console.log('line1'); console.log('line2'); console.log('LAST_LINE');"],
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("LAST_LINE");
  });

  it("returns full stdout in stdout outputMode", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "console.log('a'); console.log('b');"],
      outputMode: "stdout",
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("a");
    expect(result.summary).toContain("b");
  });

  it("returns validation error for non-absolute command", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: "echo",
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/absolute path/);
  });

  it("returns spawn error for non-existent command", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: "/nonexistent/binary12345",
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/spawn error/);
  });

  it("respects cwd option", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "console.log(process.cwd())"],
      cwd: "/tmp",
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("tmp");
  });

  it("respects env option", async () => {
    const result = await executeCommandPayload({
      kind: "command",
      command: NODE,
      args: ["-e", "console.log(process.env.OPENCLAW_CRON_TEST_VAR)"],
      env: { OPENCLAW_CRON_TEST_VAR: "hello_env" },
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("hello_env");
  });
});
