#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SCOPED_NAME = "@glfruit/openclaw";
const PLUGIN_RUNTIME_EXPORTS = [
  "@glfruit/openclaw/plugin-sdk/runtime",
  "@glfruit/openclaw/plugin-sdk/plugin-runtime",
];
const DEFAULT_PLUGIN_SMOKES = [
  "telegram",
  "feishu",
  "nowledge-mem",
  "pkm-vault",
  "planning-hooks",
  "ai4scholar",
];
const DEFAULT_BUNDLED_REQUIRED_PLUGIN_SMOKES = new Set(["telegram", "feishu"]);
const LIVE_ENV_HINTS = [
  /TELEGRAM/i,
  /FEISHU/i,
  /LARK/i,
  /^OPENCLAW_CONFIG(?:_PATH)?$/i,
  /^OPENCLAW_HOME$/i,
  /^OPENCLAW_STATE_DIR$/i,
  /NOWLEDGE/i,
];
const SAFE_ENV_ALLOW = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME",
];
const STRIPPED_PARENT_ENV = ["NODE_OPTIONS", "NPM_CONFIG_USERCONFIG"];

function usage() {
  return `Usage: node scripts/canary-openclaw-local-release.mjs --tarball <tgz> --sha256 <sha> [--report <file>] [--dry-run] [--no-start] [--allow-live-credentials] [--timeout-ms <ms>] [--port <port>] [--plugin-smoke <id> ...]\n\nInstalls the exact tarball by absolute path/SHA into an isolated npm prefix, creates isolated HOME/state/logs/cache/config, starts an isolated Gateway on an isolated port unless dry-run/no-start is set, runs smoke checks, emits a PASS|FAIL report, and cleans up the process. Live credentials are refused by default and are never inherited by the canary child environment.`;
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
function parseArgs(argv) {
  const args = {
    tarball: "",
    sha256: "",
    report: "",
    dryRun: false,
    noStart: false,
    allowLiveCredentials: false,
    timeoutMs: 30_000,
    port: 0,
    pluginSmokes: [...DEFAULT_PLUGIN_SMOKES],
    explicitPluginSmokes: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--tarball") {
      const value = argv[++i] || fail("--tarball requires a value");
      args.tarball = path.resolve(value);
      continue;
    }
    if (arg === "--sha256") {
      args.sha256 = argv[++i] || fail("--sha256 requires a value");
      continue;
    }
    if (arg === "--report") {
      args.report = path.resolve(argv[++i] || fail("--report requires a value"));
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--no-start") {
      args.noStart = true;
      continue;
    }
    if (arg === "--allow-live-credentials") {
      args.allowLiveCredentials = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++i] || fail("--timeout-ms requires a value"));
      if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1_000)
        fail("--timeout-ms must be >= 1000");
      continue;
    }
    if (arg === "--port") {
      args.port = Number(argv[++i] || fail("--port requires a value"));
      if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535)
        fail("--port must be an integer between 0 and 65535");
      continue;
    }
    if (arg === "--plugin-smoke") {
      const value = argv[++i] || fail("--plugin-smoke requires a value");
      if (!args.explicitPluginSmokes) {
        args.pluginSmokes = [];
        args.explicitPluginSmokes = true;
      }
      args.pluginSmokes.push(value);
      continue;
    }
    fail(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!args.tarball || !args.sha256) fail(usage());
  return args;
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function liveCredentialEnvPresent(env = process.env) {
  return Object.keys(env).filter(
    (key) => LIVE_ENV_HINTS.some((hint) => hint.test(key)) && env[key],
  );
}
function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`,
    );
  }
  return result;
}
function mkdirs(root) {
  const dirs = {
    root,
    home: path.join(root, "home"),
    state: path.join(root, "state"),
    logs: path.join(root, "logs"),
    cache: path.join(root, "cache"),
    prefix: path.join(root, "prefix"),
    npmCache: path.join(root, "npm-cache"),
    npmUserConfig: path.join(root, "npmrc"),
    openclawCache: path.join(root, "openclaw-cache"),
  };
  for (const [key, dir] of Object.entries(dirs)) {
    if (key !== "npmUserConfig") fs.mkdirSync(dir, { recursive: true });
  }
  return dirs;
}
async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
function writeIsolatedNpmrc(dirs) {
  const contents = [
    `prefix=${dirs.prefix}`,
    `cache=${dirs.npmCache}`,
    "audit=false",
    "fund=false",
    "update-notifier=false",
    "",
  ].join("\n");
  fs.writeFileSync(dirs.npmUserConfig, contents);
}
function parentNpmConfigKeys(env = process.env) {
  return Object.keys(env).filter((key) => /^npm_config_/i.test(key));
}
function safeEnv(dirs, configPath, port, allowLiveCredentials) {
  writeIsolatedNpmrc(dirs);
  const env = {};
  for (const key of SAFE_ENV_ALLOW) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENCLAW_CANARY_")) env[key] = process.env[key];
  }
  if (!allowLiveCredentials) {
    for (const key of Object.keys(env)) {
      if (LIVE_ENV_HINTS.some((hint) => hint.test(key)) && !key.startsWith("OPENCLAW_CANARY_")) {
        delete env[key];
      }
    }
  }
  return {
    ...env,
    HOME: dirs.home,
    OPENCLAW_HOME: dirs.home,
    OPENCLAW_STATE_DIR: dirs.state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_LOG_DIR: dirs.logs,
    OPENCLAW_CACHE_DIR: dirs.openclawCache,
    XDG_CACHE_HOME: dirs.cache,
    NPM_CONFIG_PREFIX: dirs.prefix,
    NPM_CONFIG_CACHE: dirs.npmCache,
    NPM_CONFIG_USERCONFIG: dirs.npmUserConfig,
    NO_UPDATE_NOTIFIER: "1",
    OPENCLAW_CANARY: "1",
  };
}
function writeCanaryConfig(file, port) {
  const config = {
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "none" },
      controlUi: { enabled: false },
    },
    channels: {},
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
function assertPackageRoot(dirs) {
  const packageRoot = path.join(dirs.prefix, "node_modules", "@glfruit", "openclaw");
  const pkgPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(pkgPath)) throw new Error(`installed package.json missing: ${pkgPath}`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  if (pkg.name !== SCOPED_NAME) throw new Error(`installed package name mismatch: ${pkg.name}`);
  return { packageRoot, pkg };
}
function installTarball(tarball, dirs, env) {
  runSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", dirs.prefix, tarball],
    { cwd: dirs.root, env },
  );
  return assertPackageRoot(dirs);
}
function runNodeProbe(code, cwd, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd,
    env,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function readArtifactIdentity(packageRoot) {
  const readOptionalJson = (relativePath) => {
    const file = path.join(packageRoot, relativePath);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  const buildInfo = readOptionalJson("dist/build-info.json");
  const freshBuild = readOptionalJson("dist/glfruit-release-fresh-build.json");
  const dirtySource = buildInfo?.dirtySource || freshBuild?.dirtySource || { dirty: false };
  return {
    sourceCommit: buildInfo?.commit || freshBuild?.commit || "",
    dirtySource,
    releaseEligible: dirtySource?.dirty === true ? false : true,
  };
}

function pluginRuntimeSmoke(packageRoot, env) {
  return PLUGIN_RUNTIME_EXPORTS.map((specifier) => {
    const probe = runNodeProbe(
      `import { createRequire } from "node:module"; const require = createRequire(import.meta.url); console.log(require.resolve(${JSON.stringify(specifier)}));`,
      packageRoot,
      env,
    );
    return { specifier, ...probe };
  });
}
function candidatePluginPaths(packageRoot, id) {
  const normalized = id.replace(/^@/, "").replace(/[/\\]+/g, path.sep);
  return [
    path.join(packageRoot, "extensions", normalized),
    path.join(packageRoot, "dist", "extensions", normalized),
    path.join(packageRoot, "dist", "plugins", normalized),
    path.join(packageRoot, "plugins", normalized),
  ];
}
function pluginSmokeSpecs(pluginIds, explicitPluginSmokes) {
  return pluginIds.map((id) => {
    const isDefaultBundledRequired = DEFAULT_BUNDLED_REQUIRED_PLUGIN_SMOKES.has(id);
    return {
      id,
      required: explicitPluginSmokes || isDefaultBundledRequired,
      requirement: explicitPluginSmokes
        ? "configured-required"
        : isDefaultBundledRequired
          ? "bundled-required"
          : "external-compatibility-optional",
    };
  });
}
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function packageJsonEntrypoint(dir) {
  const pkg = readJsonFile(path.join(dir, "package.json"));
  if (!pkg) return null;
  const candidates = [];
  if (typeof pkg.main === "string") candidates.push(pkg.main);
  if (typeof pkg.module === "string") candidates.push(pkg.module);
  if (typeof pkg.exports === "string") candidates.push(pkg.exports);
  if (pkg.exports && typeof pkg.exports === "object") {
    const rootExport = pkg.exports["."] || pkg.exports;
    if (typeof rootExport === "string") candidates.push(rootExport);
    if (rootExport && typeof rootExport === "object") {
      for (const key of ["import", "default", "module", "require"]) {
        if (typeof rootExport[key] === "string") candidates.push(rootExport[key]);
      }
    }
  }
  return candidates
    .map((candidate) => path.resolve(dir, candidate))
    .find((candidate) => fs.existsSync(candidate));
}
function pluginEntrypoint(existing) {
  const stat = fs.statSync(existing);
  if (!stat.isDirectory()) return existing;
  return (
    packageJsonEntrypoint(existing) ||
    ["index.js", "index.mjs", "dist/index.js"]
      .map((file) => path.join(existing, file))
      .find((file) => fs.existsSync(file)) ||
    null
  );
}
function loadOnlyPluginSmoke(packageRoot, pluginIds, explicitPluginSmokes, env) {
  return pluginSmokeSpecs(pluginIds, explicitPluginSmokes).map((spec) => {
    const candidates = candidatePluginPaths(packageRoot, spec.id);
    const existing = candidates.find((candidate) => fs.existsSync(candidate));
    if (!existing)
      return {
        ...spec,
        status: "SKIP",
        readinessImpact: spec.required ? "BLOCKED" : "INFO",
        reason: spec.required
          ? "required plugin not present in installed package"
          : "external compatibility plugin not present in installed package",
        candidates,
      };
    const stat = fs.statSync(existing);
    const entrypoint = pluginEntrypoint(existing);
    if (!entrypoint) {
      return {
        ...spec,
        status: "FAIL",
        readinessImpact: spec.required ? "BLOCKED" : "INFO",
        reason: "plugin entrypoint not found",
        path: existing,
        kind: stat.isDirectory() ? "directory" : "file",
        candidates,
      };
    }
    const probe = runNodeProbe(
      `import { pathToFileURL } from "node:url"; await import(pathToFileURL(${JSON.stringify(entrypoint)}).href);`,
      packageRoot,
      env,
    );
    return {
      ...spec,
      status: probe.ok ? "PASS" : "FAIL",
      readinessImpact: probe.ok ? "PASS" : spec.required ? "BLOCKED" : "INFO",
      reason: probe.ok ? undefined : "plugin entrypoint import failed",
      path: existing,
      entrypoint,
      kind: stat.isDirectory() ? "directory" : "file",
      probe,
    };
  });
}
function jsonGuardSmoke(packageRoot, env) {
  const candidates = [
    path.join(packageRoot, "dist", "agents", "json-edit-guard.js"),
    path.join(packageRoot, "dist", "json-edit-guard.js"),
  ];
  const target = candidates.find((candidate) => fs.existsSync(candidate));
  if (!target) {
    return {
      status: "BLOCKED",
      reason:
        "no installed JSON guard canary entrypoint found; expected dist/agents/json-edit-guard.js",
      candidates,
    };
  }
  const probe = runNodeProbe(
    `import { pathToFileURL } from "node:url";\nconst mod = await import(pathToFileURL(${JSON.stringify(target)}).href);\nlet protectedJsonBlocked = false;\ntry { mod.assertNoRawJsonEditTarget(["standing-orders.json"]); } catch (error) { protectedJsonBlocked = /json-safe-edit/i.test(String(error)); }\nlet markdownAllowed = false;\ntry { mod.assertNoRawJsonEditTarget(["notes/release.md"]); markdownAllowed = true; } catch {}\nconst execProtectedJsonBlocked = mod.detectRawJsonExecWrite("echo '{}' > standing-orders.json").blocked === true;\nconst readOnlyJsonAllowed = mod.detectRawJsonExecWrite("cat standing-orders.json").blocked === false;\nconst safeMarkdownWriteAllowed = mod.detectRawJsonExecWrite("echo ok > notes/release.md").blocked === false;\nconsole.log(JSON.stringify({ protectedJsonBlocked, markdownAllowed, execProtectedJsonBlocked, readOnlyJsonAllowed, safeMarkdownWriteAllowed }));`,
    packageRoot,
    env,
  );
  let checks = {};
  try {
    checks = probe.stdout ? JSON.parse(probe.stdout) : {};
  } catch {
    checks = {};
  }
  const ok =
    probe.ok &&
    checks.protectedJsonBlocked === true &&
    checks.markdownAllowed === true &&
    checks.execProtectedJsonBlocked === true &&
    checks.readOnlyJsonAllowed === true &&
    checks.safeMarkdownWriteAllowed === true;
  return { status: ok ? "PASS" : "BLOCKED", entrypoint: target, checks, probe };
}
async function waitForTcp(port, timeoutMs, child) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null)
      throw new Error(`gateway exited before bind with code ${child.exitCode}`);
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        lastError = "timeout";
        socket.destroy();
        resolve(false);
      });
      socket.once("error", (error) => {
        lastError = error.message;
        resolve(false);
      });
    });
    if (ok) return { status: "PASS", port, waitedMs: Date.now() - startedAt };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `gateway did not listen on 127.0.0.1:${port} within ${timeoutMs}ms (${lastError})`,
  );
}
function readinessBlockers(report) {
  const blockers = [];
  if (!report.pluginRuntimeSmoke.every((item) => item.ok))
    blockers.push("plugin-runtime-smoke-failed");
  for (const item of report.pluginLoadSmoke) {
    if (item.status !== "PASS" && item.required)
      blockers.push(`plugin-load-${item.id}-${String(item.status).toLowerCase()}`);
  }
  if (report.jsonGuardSmoke.status !== "PASS") {
    blockers.push(`json-guard-${String(report.jsonGuardSmoke.status).toLowerCase()}`);
  }
  if (report.artifactIdentity?.dirtySource?.dirty === true) {
    blockers.push("dirty-artifact-identity");
  }
  if (report.started !== true) blockers.push("gateway-not-started");
  if (report.gateway.status === "SKIP") blockers.push("gateway-status-skipped");
  if (report.gateway.status === "FAIL") blockers.push("gateway-process-failed");
  if (report.gateway.status !== "TCP_READYZ_READY" && report.gateway.status !== "SKIP") {
    blockers.push(`gateway-status-${String(report.gateway.status || "missing").toLowerCase()}`);
  }
  const statusProbe = report.gateway?.statusProbe;
  if (!statusProbe) {
    blockers.push("gateway-status-probe-missing");
  } else {
    if (statusProbe.rpc?.ok === false) blockers.push("gateway-rpc-failed");
    if (statusProbe.health?.healthy === false || statusProbe.healthz?.ok === false)
      blockers.push("gateway-healthz-failed");
    if (statusProbe.readyz?.ready === false) blockers.push("gateway-readyz-failed");
    if (statusProbe.status !== "PASS") blockers.push("gateway-status-probe-failed");
  }
  return [...new Set(blockers)];
}
function applyVerdicts(report) {
  const runtimeOk = report.pluginRuntimeSmoke.every((item) => item.ok);
  const gatewayReady =
    report.started === true &&
    report.gatewayProcessVerdict === "PASS" &&
    report.gateway.status === "TCP_READYZ_READY" &&
    report.gateway?.statusProbe?.status === "PASS" &&
    report.gateway.statusProbe.probeKind === "gateway-healthz-readyz-local" &&
    report.gateway.statusProbe.healthz?.ok === true &&
    report.gateway.statusProbe.readyz?.ready === true;
  report.canaryGatewayVerdict = runtimeOk && gatewayReady ? "PASS" : "FAIL";
  report.readinessBlockers = readinessBlockers(report);
  report.releaseReadinessVerdict = report.readinessBlockers.length === 0 ? "PASS" : "BLOCKED";
  report.verdict = report.releaseReadinessVerdict;
}
function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch (error) {
    return { parseError: error instanceof Error ? error.message : String(error) };
  }
}

async function requestLocalJson(port, pathname) {
  return new Promise((resolve) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: pathname, method: "GET", timeout: 1_000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body = `${body}${chunk}`.slice(0, 8_000);
        });
        response.once("end", () => {
          const statusCode = response.statusCode || 0;
          const json = parseJsonBody(body);
          resolve({ statusCode, body: json, rawBody: body });
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve({ error: "timeout" });
    });
    request.once("error", (error) => {
      resolve({ error: error.message });
    });
    request.end();
  });
}

function summarizeHealthz(attempt) {
  const ok =
    attempt.statusCode === 200 && attempt.body?.ok === true && attempt.body?.status === "live";
  return {
    ok,
    statusCode: attempt.statusCode,
    body: attempt.body,
    error: attempt.error,
  };
}

function summarizeReadyz(attempt) {
  const ready = attempt.statusCode === 200 && attempt.body?.ready === true;
  return {
    ready,
    statusCode: attempt.statusCode,
    body: attempt.body,
    error: attempt.error,
  };
}

async function gatewayLocalHealthzReadyzProbe(port, timeoutMs) {
  const startedAt = Date.now();
  let lastHealthz = null;
  let lastReadyz = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastHealthz = summarizeHealthz(await requestLocalJson(port, "/healthz"));
    lastReadyz = summarizeReadyz(await requestLocalJson(port, "/readyz"));
    if (lastHealthz.ok && lastReadyz.ready) {
      return {
        status: "PASS",
        probeKind: "gateway-healthz-readyz-local",
        healthz: lastHealthz,
        readyz: lastReadyz,
        health: { healthy: true, statusCode: lastHealthz.statusCode, body: lastHealthz.body },
        urls: {
          healthz: `http://127.0.0.1:${port}/healthz`,
          readyz: `http://127.0.0.1:${port}/readyz`,
        },
        waitedMs: Date.now() - startedAt,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    status: "FAIL",
    probeKind: "gateway-healthz-readyz-local",
    healthz: lastHealthz || { ok: false, error: "timeout" },
    readyz: lastReadyz || { ready: false, error: "timeout" },
    health: {
      healthy: false,
      statusCode: lastHealthz?.statusCode,
      body: lastHealthz?.body,
      error: lastHealthz?.error,
    },
    urls: {
      healthz: `http://127.0.0.1:${port}/healthz`,
      readyz: `http://127.0.0.1:${port}/readyz`,
    },
    waitedMs: Date.now() - startedAt,
  };
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null)
    return { status: "not_running", exitCode: child?.exitCode ?? null };
  child.kill("SIGTERM");
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (exited) return { status: "terminated", exitCode: child.exitCode, signal: child.signalCode };
  child.kill("SIGKILL");
  return { status: "killed" };
}
async function runCanary(args) {
  if (!fs.existsSync(args.tarball)) throw new Error(`tarball does not exist: ${args.tarball}`);
  if (!path.isAbsolute(args.tarball))
    throw new Error("tarball path must resolve to an absolute path");
  const actualSha = sha256(args.tarball);
  if (actualSha !== args.sha256)
    throw new Error(`tarball sha256 mismatch: expected ${args.sha256}, got ${actualSha}`);
  const liveEnv = liveCredentialEnvPresent();
  if (liveEnv.length && !args.allowLiveCredentials)
    throw new Error(
      `refusing live credentials by default; unset or pass --allow-live-credentials intentionally. Detected: ${liveEnv.join(", ")}`,
    );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-glfruit-canary-"));
  const dirs = mkdirs(root);
  const port = args.port || (await reservePort());
  const configPath = path.join(dirs.state, "openclaw.json");
  writeCanaryConfig(configPath, port);
  const env = safeEnv(dirs, configPath, port, args.allowLiveCredentials);
  const report = {
    verdict: "FAIL",
    tarball: args.tarball,
    sha256: actualSha,
    packageRoot: "",
    isolated: { ...dirs, config: configPath, port },
    install: {
      status: "PENDING",
      command: [
        "npm",
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        dirs.prefix,
        args.tarball,
      ],
    },
    liveCredentialsAllowed: args.allowLiveCredentials,
    liveCredentialsDetected: liveEnv,
    inheritedLiveCredentialPolicy: args.allowLiveCredentials
      ? "explicitly-allowed"
      : "refused-before-start",
    started: false,
    gateway: { status: args.dryRun || args.noStart ? "SKIP" : "PENDING" },
    gatewayProcessVerdict: args.dryRun || args.noStart ? "SKIP" : "PENDING",
    canaryGatewayVerdict: "FAIL",
    releaseReadinessVerdict: "BLOCKED",
    readinessBlockers: [],
    envIsolation: {
      strippedParentEnv: STRIPPED_PARENT_ENV.filter((key) => process.env[key]),
      strippedParentNpmConfig: parentNpmConfigKeys(),
      childEnvHasNodeOptions: Object.hasOwn(env, "NODE_OPTIONS"),
      childEnvHasLowercaseNpmConfig: Object.keys(env).some((key) => /^npm_config_/.test(key)),
      childNpmUserConfig: env.NPM_CONFIG_USERCONFIG,
      npmUserConfig: dirs.npmUserConfig,
      logs: dirs.logs,
      cache: dirs.cache,
      openclawCache: dirs.openclawCache,
    },
    pluginRuntimeSmoke: [],
    pluginLoadSmoke: [],
    jsonGuardSmoke: { status: "PENDING" },
    artifactIdentity: { dirtySource: { dirty: false }, releaseEligible: true },
    processLogs: { stdout: "", stderr: "" },
    cleanup: { status: "PENDING" },
  };
  let child;
  try {
    const installed = installTarball(args.tarball, dirs, env);
    report.install.status = "PASS";
    report.packageRoot = installed.packageRoot;
    report.package = { name: installed.pkg.name, version: installed.pkg.version };
    report.artifactIdentity = readArtifactIdentity(installed.packageRoot);
    report.pluginRuntimeSmoke = pluginRuntimeSmoke(installed.packageRoot, env);
    report.pluginLoadSmoke = loadOnlyPluginSmoke(
      installed.packageRoot,
      args.pluginSmokes,
      args.explicitPluginSmokes,
      env,
    );
    report.jsonGuardSmoke = jsonGuardSmoke(installed.packageRoot, env);
    if (args.dryRun || args.noStart) {
      report.gateway.status = "SKIP";
      report.gatewayProcessVerdict = "SKIP";
      applyVerdicts(report);
      return report;
    }
    const bin = path.join(installed.packageRoot, "openclaw.mjs");
    const startArgs = [
      bin,
      "gateway",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--auth",
      "none",
      "--allow-unconfigured",
      "--verbose",
    ];
    report.gateway.startCommand = [process.execPath, ...startArgs];
    child = spawn(process.execPath, startArgs, {
      cwd: installed.packageRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      report.processLogs.stdout = `${report.processLogs.stdout}${chunk}`.slice(-20_000);
    });
    child.stderr.on("data", (chunk) => {
      report.processLogs.stderr = `${report.processLogs.stderr}${chunk}`.slice(-20_000);
    });
    report.started = true;
    report.gateway.tcp = await waitForTcp(port, args.timeoutMs, child);
    report.gateway.tcpReady = report.gateway.tcp.status === "PASS";
    report.gateway.statusProbe = await gatewayLocalHealthzReadyzProbe(port, args.timeoutMs);
    report.gateway.readinessReady = report.gateway.statusProbe.status === "PASS";
    report.gateway.status = report.gateway.tcpReady
      ? report.gateway.readinessReady
        ? "TCP_READYZ_READY"
        : "TCP_ONLY"
      : "FAIL";
    report.gatewayProcessVerdict = report.gateway.tcpReady ? "PASS" : "FAIL";
    applyVerdicts(report);
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.verdict = "FAIL";
    return report;
  } finally {
    report.cleanup = await stopChild(child);
  }
}

export { gatewayLocalHealthzReadyzProbe, runCanary };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runCanary(args);
    const reportPath = args.report || path.join(report.isolated.root, "canary-report.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
    if (report.verdict !== "PASS") process.exit(1);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
