#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function usage() {
  return `Usage: node scripts/canary-openclaw-local-release.mjs --tarball <tgz> --sha256 <sha> [--report <file>] [--dry-run] [--no-start] [--allow-live-credentials]\n\nCreates an isolated canary plan with HOME/state/logs/cache/prefix/port. By default it refuses live credentials and does not start a gateway unless future code explicitly implements a safe start path.`;
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
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--tarball") {
      args.tarball = path.resolve(argv[++i] || fail("--tarball requires a value"));
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
    fail(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!args.tarball || !args.sha256) fail(usage());
  return args;
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function liveCredentialEnvPresent() {
  const liveHints = [
    /TELEGRAM/i,
    /FEISHU/i,
    /LARK/i,
    /OPENCLAW_CONFIG/i,
    /OPENCLAW_HOME/i,
    /NOWLEDGE/i,
  ];
  return Object.keys(process.env).filter(
    (key) => liveHints.some((hint) => hint.test(key)) && process.env[key],
  );
}
try {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.tarball)) fail(`tarball does not exist: ${args.tarball}`);
  const actualSha = sha256(args.tarball);
  if (actualSha !== args.sha256)
    fail(`tarball sha256 mismatch: expected ${args.sha256}, got ${actualSha}`);
  const liveEnv = liveCredentialEnvPresent();
  if (liveEnv.length && !args.allowLiveCredentials)
    fail(
      `refusing live credentials by default; unset or pass --allow-live-credentials intentionally. Detected: ${liveEnv.join(", ")}`,
    );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-glfruit-canary-"));
  const dirs = {
    root,
    home: path.join(root, "home"),
    state: path.join(root, "state"),
    logs: path.join(root, "logs"),
    cache: path.join(root, "cache"),
    prefix: path.join(root, "prefix"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const report = {
    verdict: args.dryRun || args.noStart ? "DRY_RUN" : "BLOCKED",
    tarball: args.tarball,
    sha256: actualSha,
    isolated: { ...dirs, port: 0 },
    liveCredentialsAllowed: args.allowLiveCredentials,
    started: false,
    pluginRuntimeSmokeHooks: [
      "resolve @glfruit/openclaw/plugin-sdk/runtime",
      "resolve @glfruit/openclaw/plugin-sdk/plugin-runtime",
      "load configured plugins without live credentials",
    ],
    jsonGuardSmokeHooks: [
      "blocked write to forbidden json path",
      "allowed read-only/markdown path",
    ],
    note: "Slice 1 records an isolated canary plan and SHA gate; live gateway start is intentionally not implemented here.",
  };
  if (!args.dryRun && !args.noStart)
    fail("canary start is not implemented in slice 1; rerun with --dry-run or --no-start");
  const reportPath = args.report || path.join(root, "canary-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
