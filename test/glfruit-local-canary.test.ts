import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "canary-openclaw-local-release.mjs");
const tempDirs: string[] = [];

function makeTempDir(prefix = "openclaw-canary-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(file: string) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(command: string, args: string[], options: Parameters<typeof spawnSync>[2] = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function writeFile(file: string, contents: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  if (mode) fs.chmodSync(file, mode);
}

function makeFakeTarball(
  options: {
    releaseReady?: boolean;
    brokenPlugin?: string;
    statusRpcOk?: boolean;
    healthHealthy?: boolean;
    healthzStatus?: number;
    healthzBody?: unknown;
    readyzStatus?: number;
    readyzBody?: unknown;
  } = {},
) {
  const releaseReady = options.releaseReady ?? true;
  const statusRpcOk = options.statusRpcOk ?? true;
  const healthHealthy = options.healthHealthy ?? true;
  const healthzStatus = options.healthzStatus ?? 200;
  const healthzBody = options.healthzBody ?? { ok: true, status: "live" };
  const readyzStatus = options.readyzStatus ?? 200;
  const readyzBody = options.readyzBody ?? { ready: true };
  const root = makeTempDir("openclaw-canary-fake-package-");
  const pkg = path.join(root, "package");
  fs.mkdirSync(path.join(pkg, "dist", "plugin-sdk"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "dist", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    `${JSON.stringify(
      {
        name: "@glfruit/openclaw",
        version: "0.0.0-canary-test",
        type: "module",
        bin: { openclaw: "openclaw.mjs" },
        exports: {
          "./plugin-sdk/runtime": "./dist/plugin-sdk/runtime.js",
          "./plugin-sdk/plugin-runtime": "./dist/plugin-sdk/plugin-runtime.js",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFile(path.join(pkg, "dist", "plugin-sdk", "runtime.js"), "export const runtime = true;\n");
  writeFile(
    path.join(pkg, "dist", "plugin-sdk", "plugin-runtime.js"),
    "export const pluginRuntime = true;\n",
  );
  writeFile(
    path.join(pkg, "dist", "agents", "json-edit-guard.js"),
    `export function assertNoRawJsonEditTarget(targets) {
  for (const target of targets) {
    if (String(target).endsWith(".json") || String(target).endsWith(".jsonl")) throw new Error("json-safe-edit serializer temp validate");
  }
}
export function detectRawJsonExecWrite(command) {
  return { blocked: command.includes("> standing-orders.json") };
}
`,
  );
  if (releaseReady) {
    for (const id of ["telegram", "feishu"]) {
      const contents =
        options.brokenPlugin === id ? 'import "./missing-dependency.js";\n' : "export {};\n";
      writeFile(path.join(pkg, "dist", "extensions", id, "index.js"), contents);
    }
  } else {
    fs.rmSync(path.join(pkg, "dist", "agents", "json-edit-guard.js"), { force: true });
  }
  writeFile(
    path.join(pkg, "openclaw.mjs"),
    `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
const args = process.argv.slice(2);
if (process.env.OPENCLAW_CANARY_ENV_DUMP_FILE) fs.writeFileSync(process.env.OPENCLAW_CANARY_ENV_DUMP_FILE, JSON.stringify(process.env, null, 2));
if (args.includes("status")) { const url = args[args.indexOf("--url") + 1] || ""; const port = Number(new URL(url).port); console.log(JSON.stringify({ok:true,gateway:{port},rpc:{ok:${JSON.stringify(statusRpcOk)},error:${statusRpcOk ? "undefined" : JSON.stringify("device identity required")}},health:{healthy:${JSON.stringify(healthHealthy)},error:${healthHealthy ? "undefined" : JSON.stringify("device identity required")}}})); process.exit(0); }
const port = Number(args[args.indexOf("--port") + 1]);
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(${JSON.stringify(healthzStatus)}, { "content-type": "application/json" }); res.end(${JSON.stringify(JSON.stringify(healthzBody))}); return; }
  if (req.url === "/readyz") { res.writeHead(${JSON.stringify(readyzStatus)}, { "content-type": "application/json" }); res.end(${JSON.stringify(JSON.stringify(readyzBody))}); return; }
  res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" }));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
    0o755,
  );
  const tarball = path.join(root, "glfruit-openclaw-fake.tgz");
  run("tar", ["-czf", tarball, "-C", root, "package"]);
  return { tarball, sha: sha256(tarball) };
}

function runCanary(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("glfruit local canary script", () => {
  it("refuses live credential environment by default", () => {
    const { tarball, sha } = makeFakeTarball();
    const result = runCanary(["--tarball", tarball, "--sha256", sha, "--no-start"], {
      TELEGRAM_BOT_TOKEN: "live-token",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing live credentials by default");
    expect(result.stderr).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("enforces the exact tarball SHA before install", () => {
    const { tarball } = makeFakeTarball();
    const result = runCanary(["--tarball", tarball, "--sha256", "0".repeat(64), "--no-start"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("tarball sha256 mismatch");
  });

  it("does not inherit NODE_OPTIONS, NPM_CONFIG_USERCONFIG, or arbitrary npm_config_*", () => {
    const { tarball, sha } = makeFakeTarball();
    const reportPath = path.join(makeTempDir(), "report.json");
    const result = runCanary(
      ["--tarball", tarball, "--sha256", sha, "--no-start", "--report", reportPath],
      {
        NODE_OPTIONS: "--throw-deprecation",
        NPM_CONFIG_USERCONFIG: "/tmp/live-npmrc",
        npm_config_registry: "https://example.invalid/",
      },
    );
    expect(result.status, result.stderr).not.toBe(0);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.releaseReadinessVerdict).toBe("BLOCKED");
    expect(report.readinessBlockers).toContain("gateway-not-started");
    expect(report.readinessBlockers).toContain("gateway-status-skipped");
    expect(report.envIsolation.strippedParentEnv).toEqual([
      "NODE_OPTIONS",
      "NPM_CONFIG_USERCONFIG",
    ]);
    expect(report.envIsolation.strippedParentNpmConfig).toContain("npm_config_registry");
    expect(report.envIsolation.childEnvHasNodeOptions).toBe(false);
    expect(report.envIsolation.childEnvHasLowercaseNpmConfig).toBe(false);
    expect(report.envIsolation.childNpmUserConfig).toBe(report.envIsolation.npmUserConfig);
    expect(report.envIsolation.childNpmUserConfig).toContain(report.isolated.root);
  });

  it("installs into an isolated prefix and blocks no-start release readiness", () => {
    const { tarball, sha } = makeFakeTarball();
    const reportPath = path.join(makeTempDir(), "report.json");
    const result = runCanary([
      "--tarball",
      tarball,
      "--sha256",
      sha,
      "--no-start",
      "--report",
      reportPath,
    ]);
    expect(result.status, result.stderr).not.toBe(0);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.verdict).toBe("BLOCKED");
    expect(report.canaryGatewayVerdict).toBe("FAIL");
    expect(report.releaseReadinessVerdict).toBe("BLOCKED");
    expect(report.readinessBlockers).toEqual(
      expect.arrayContaining([
        "gateway-not-started",
        "gateway-status-skipped",
        "gateway-status-probe-missing",
      ]),
    );
    expect(report.sha256).toBe(sha);
    expect(report.packageRoot).toContain(path.join(report.isolated.prefix, "node_modules"));
    expect(report.install.command).toContain("--prefix");
    expect(report.install.command).not.toContain("--global");
    expect(report.pluginRuntimeSmoke.every((item: { ok: boolean }) => item.ok)).toBe(true);
    expect(
      report.pluginLoadSmoke
        .filter((item: { required: boolean }) => item.required)
        .map((item: { id: string }) => item.id),
    ).toEqual(["telegram", "feishu"]);
    expect(
      report.pluginLoadSmoke
        .filter(
          (item: { requirement: string }) => item.requirement === "external-compatibility-optional",
        )
        .every((item: { status: string }) => item.status === "SKIP"),
    ).toBe(true);
    expect(report.jsonGuardSmoke.checks).toMatchObject({
      protectedJsonBlocked: true,
      markdownAllowed: true,
      execProtectedJsonBlocked: true,
      readOnlyJsonAllowed: true,
      safeMarkdownWriteAllowed: true,
    });
    expect(report.gateway.status).toBe("SKIP");
    expect(report.cleanup.status).toBe("not_running");
  });

  it("blocks release readiness when JSON guard or required plugin smokes are incomplete", () => {
    const { tarball, sha } = makeFakeTarball({ releaseReady: false });
    const reportPath = path.join(makeTempDir(), "report.json");
    const result = runCanary([
      "--tarball",
      tarball,
      "--sha256",
      sha,
      "--no-start",
      "--report",
      reportPath,
    ]);
    expect(result.status).not.toBe(0);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.canaryGatewayVerdict).toBe("FAIL");
    expect(report.releaseReadinessVerdict).toBe("BLOCKED");
    expect(report.verdict).toBe("BLOCKED");
    expect(report.readinessBlockers).toContain("json-guard-blocked");
    expect(report.readinessBlockers).toContain("plugin-load-telegram-skip");
    expect(report.readinessBlockers).toContain("plugin-load-feishu-skip");
  });

  it("blocks explicitly configured external plugin smokes when absent", () => {
    const { tarball, sha } = makeFakeTarball();
    const reportPath = path.join(makeTempDir(), "report.json");
    const result = runCanary([
      "--tarball",
      tarball,
      "--sha256",
      sha,
      "--no-start",
      "--plugin-smoke",
      "pkm-vault",
      "--report",
      reportPath,
    ]);
    expect(result.status).not.toBe(0);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.pluginLoadSmoke).toMatchObject([
      { id: "pkm-vault", required: true, requirement: "configured-required", status: "SKIP" },
    ]);
    expect(report.readinessBlockers).toContain("plugin-load-pkm-vault-skip");
  });

  it("starts the isolated gateway command, labels TCP/healthz+readyz semantics, and cleans it up", () => {
    const { tarball, sha } = makeFakeTarball();
    const reportPath = path.join(makeTempDir(), "report.json");
    const envDump = path.join(makeTempDir(), "gateway-env.json");
    const result = runCanary(
      ["--tarball", tarball, "--sha256", sha, "--timeout-ms", "3000", "--report", reportPath],
      {
        OPENCLAW_CANARY_ENV_DUMP_FILE: envDump,
        NODE_OPTIONS: "--throw-deprecation",
        npm_config_registry: "https://example.invalid/",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.verdict).toBe("PASS");
    expect(report.started).toBe(true);
    expect(report.gateway.startCommand.join(" ")).toContain("gateway --port");
    expect(report.gateway.status).toBe("TCP_READYZ_READY");
    expect(report.gatewayProcessVerdict).toBe("PASS");
    expect(report.gateway.tcpReady).toBe(true);
    expect(report.gateway.statusProbe.probeKind).toBe("gateway-healthz-readyz-local");
    expect(report.gateway.readinessReady).toBe(true);
    expect(report.gateway.statusProbe.healthz).toMatchObject({
      ok: true,
      statusCode: 200,
      body: { ok: true, status: "live" },
    });
    expect(report.gateway.statusProbe.readyz).toMatchObject({
      ready: true,
      statusCode: 200,
      body: { ready: true },
    });
    expect(["terminated", "not_running"]).toContain(report.cleanup.status);
    expect(report.isolated.home).not.toBe(os.homedir());
    const childEnv = JSON.parse(fs.readFileSync(envDump, "utf8"));
    expect(childEnv.NODE_OPTIONS).toBeUndefined();
    expect(childEnv.npm_config_registry).toBeUndefined();
    expect(childEnv.NPM_CONFIG_USERCONFIG).toBe(report.isolated.npmUserConfig);
    expect(childEnv.OPENCLAW_LOG_DIR).toBe(report.isolated.logs);
    expect(childEnv.OPENCLAW_CACHE_DIR).toBe(report.isolated.openclawCache);
  });
  it("blocks release readiness and labels TCP-only when local healthz contract fails", () => {
    const { tarball, sha } = makeFakeTarball({
      healthzStatus: 404,
      healthzBody: { ok: true, status: "live" },
    });
    const reportPath = path.join(makeTempDir(), "report.json");
    const result = runCanary([
      "--tarball",
      tarball,
      "--sha256",
      sha,
      "--timeout-ms",
      "3000",
      "--report",
      reportPath,
    ]);
    expect(result.status).not.toBe(0);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.gateway.status).toBe("TCP_ONLY");
    expect(report.gateway.statusProbe).toMatchObject({
      status: "FAIL",
      probeKind: "gateway-healthz-readyz-local",
      healthz: { ok: false, statusCode: 404 },
    });
    expect(report.canaryGatewayVerdict).toBe("FAIL");
    expect(report.releaseReadinessVerdict).toBe("BLOCKED");
    expect(report.verdict).toBe("BLOCKED");
    expect(report.readinessBlockers).toContain("gateway-status-tcp_only");
    expect(report.readinessBlockers).toContain("gateway-healthz-failed");
    expect(report.readinessBlockers).toContain("gateway-status-probe-failed");
  });

  it("blocks release readiness and labels TCP-only when local readyz contract fails", () => {
    const { tarball, sha } = makeFakeTarball({ readyzStatus: 503, readyzBody: { ready: false } });
    const reportPath = path.join(makeTempDir(), "report.json");
    const result = runCanary([
      "--tarball",
      tarball,
      "--sha256",
      sha,
      "--timeout-ms",
      "3000",
      "--report",
      reportPath,
    ]);
    expect(result.status).not.toBe(0);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    expect(report.gateway.status).toBe("TCP_ONLY");
    expect(report.gateway.statusProbe).toMatchObject({
      status: "FAIL",
      probeKind: "gateway-healthz-readyz-local",
      healthz: { ok: true, statusCode: 200 },
      readyz: { ready: false, statusCode: 503 },
    });
    expect(report.readinessBlockers).toContain("gateway-status-tcp_only");
    expect(report.readinessBlockers).toContain("gateway-readyz-failed");
    expect(report.readinessBlockers).toContain("gateway-status-probe-failed");
  });

  it("blocks release readiness when a bundled required plugin entrypoint import fails", () => {
    const { tarball, sha } = makeFakeTarball({ brokenPlugin: "feishu" });
    const reportPath = path.join(makeTempDir(), "report.json");
    const result = runCanary([
      "--tarball",
      tarball,
      "--sha256",
      sha,
      "--no-start",
      "--report",
      reportPath,
    ]);
    expect(result.status).not.toBe(0);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const feishu = report.pluginLoadSmoke.find((item: { id: string }) => item.id === "feishu");
    expect(feishu).toMatchObject({
      id: "feishu",
      required: true,
      requirement: "bundled-required",
      status: "FAIL",
      readinessImpact: "BLOCKED",
      reason: "plugin entrypoint import failed",
    });
    expect(feishu.entrypoint).toContain(path.join("dist", "extensions", "feishu", "index.js"));
    expect(feishu.probe.ok).toBe(false);
    expect(report.releaseReadinessVerdict).toBe("BLOCKED");
    expect(report.verdict).toBe("BLOCKED");
    expect(report.readinessBlockers).toContain("plugin-load-feishu-fail");
  });
});
