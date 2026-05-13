#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function usage() {
  return `Usage: node scripts/promote-openclaw-local-release.mjs [--out-dir <dir>] [--live --confirm-live --canary-report <pass-report.json>] [--dry-run]`;
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
function parseArgs(argv) {
  const args = {
    outDir: path.join(ROOT, ".artifacts", "glfruit-local-release"),
    live: false,
    confirmLive: false,
    canaryReport: "",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--out-dir") {
      args.outDir = path.resolve(argv[++i] || fail("--out-dir requires a value"));
      continue;
    }
    if (arg === "--live") {
      args.live = true;
      continue;
    }
    if (arg === "--confirm-live") {
      args.confirmLive = true;
      continue;
    }
    if (arg === "--canary-report") {
      args.canaryReport = path.resolve(argv[++i] || fail("--canary-report requires a value"));
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    fail(`Unknown argument: ${arg}\n${usage()}`);
  }
  return args;
}
function run(args) {
  const result = spawnSync("node", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `node ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`,
    );
  return result.stdout.trim();
}
function assertLiveAllowed(args) {
  if (!args.live) return;
  if (!args.confirmLive) fail("refusing live promote without --confirm-live");
  if (!args.canaryReport) fail("refusing live promote without --canary-report");
  const report = JSON.parse(fs.readFileSync(args.canaryReport, "utf8"));
  if (report.verdict !== "PASS")
    fail(`refusing live promote without canary PASS report; got ${report.verdict || "<missing>"}`);
}
try {
  const args = parseArgs(process.argv.slice(2));
  assertLiveAllowed(args);
  if (args.live)
    fail("live promote execution is stop-gated in slice 1 after canary PASS verification");
  const packOutput = JSON.parse(
    run([
      "scripts/package-openclaw-glfruit-local.mjs",
      "--out-dir",
      args.outDir,
      ...(args.dryRun ? ["--dry-run"] : []),
    ]),
  );
  const steps = { pack: packOutput };
  if (!args.dryRun) {
    run([
      "scripts/check-openclaw-glfruit-tarball.mjs",
      packOutput.tarballPath,
      "--expected-version",
      packOutput.version,
      "--expected-commit",
      packOutput.sourceCommit,
    ]);
    steps.check = "PASS";
    const canaryReport = path.join(args.outDir, "canary-dry-run-report.json");
    steps.canary = JSON.parse(
      run([
        "scripts/canary-openclaw-local-release.mjs",
        "--tarball",
        packOutput.tarballPath,
        "--sha256",
        packOutput.sha256,
        "--dry-run",
        "--report",
        canaryReport,
      ]),
    );
    steps.rollback = JSON.parse(
      run([
        "scripts/rollback-openclaw-local-release.mjs",
        "--target",
        packOutput.tarballPath,
        "--expected-sha256",
        packOutput.sha256,
      ]),
    );
  }
  console.log(JSON.stringify({ verdict: "PASS", live: false, steps }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
