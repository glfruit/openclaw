#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: node scripts/promote-openclaw-local-release.mjs [--out-dir <dir>] [--live --confirm-live --canary-report <pass-report.json>] [--dry-run] [--allow-dirty-for-local-canary]`;
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
    allowDirtyForLocalCanary: false,
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
    if (arg === "--allow-dirty-for-local-canary") {
      args.allowDirtyForLocalCanary = true;
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

function runCommand(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`,
    );
  return result.stdout.trim();
}
function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function normalizeArtifactPath(file) {
  return file ? path.resolve(file) : "";
}
function isGlfruitVersion(version) {
  return /^\d+(?:\.\d+){1,2}-glfruit\.[1-9]\d*$/u.test(String(version || ""));
}
function assertGlfruitArtifactIdentity(identity, label) {
  if (identity?.packageName && identity.packageName !== "@glfruit/openclaw")
    throw new Error(
      `${label} packageName mismatch: expected @glfruit/openclaw, got ${identity.packageName}`,
    );
  if (!isGlfruitVersion(identity?.version))
    throw new Error(
      `${label} version must match <base>-glfruit.N, got ${identity?.version || "<missing>"}`,
    );
}
export function readCanaryReport(reportPath) {
  if (!reportPath) return null;
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!report.tarball || !report.sha256)
    throw new Error("refusing promote with incomplete canary report; missing tarball or sha256");
  if (!path.isAbsolute(report.tarball))
    throw new Error(
      `refusing promote with canary report tarball that is not absolute: ${report.tarball}`,
    );
  return report;
}
function reportArtifactIdentity(report) {
  return report?.artifactIdentity || report?.buildInfo || report?.package || {};
}
export function selectCanaryReportPromoteTarget(report) {
  if (!report) return null;
  const tarballPath = normalizeArtifactPath(report.tarball);
  if (!fs.existsSync(tarballPath))
    throw new Error(`canary report tarball does not exist: ${tarballPath}`);
  const actualSha256 = sha256File(tarballPath);
  if (actualSha256 !== String(report.sha256).toLowerCase())
    throw new Error(
      `canary report tarball sha256 mismatch: expected ${report.sha256}, got ${actualSha256}`,
    );
  const identity = reportArtifactIdentity(report);
  assertGlfruitArtifactIdentity(identity, "canary artifact");
  const version = identity.version || report.package?.version;
  const sourceCommit = identity.sourceCommit || identity.commit || report.buildInfo?.commit || "";
  if (!sourceCommit) throw new Error("canary report artifact identity missing source commit");
  return {
    source: "canary-report",
    repack: false,
    packageName: identity.packageName || report.package?.name || "@glfruit/openclaw",
    version,
    sourceCommit,
    tarballPath,
    sha256: actualSha256,
    reportSha256: report.sha256,
  };
}
export function assertCanaryReportReleaseReady(report) {
  if (!report) throw new Error("refusing live promote without --canary-report");
  if (report.verdict !== "PASS")
    throw new Error(
      `refusing live promote without release-ready canary PASS; got ${report.verdict || "<missing>"}`,
    );
  if (report.releaseReadinessVerdict !== "PASS")
    throw new Error(
      `refusing live promote without releaseReadinessVerdict PASS; got ${report.releaseReadinessVerdict || "<missing>"}`,
    );
  if (report.canaryGatewayVerdict !== "PASS")
    throw new Error(
      `refusing live promote without canaryGatewayVerdict PASS; got ${report.canaryGatewayVerdict || "<missing>"}`,
    );
  if (report.started !== true)
    throw new Error("refusing live promote without a started canary gateway");
  if (report.gateway?.status !== "TCP_READYZ_READY")
    throw new Error(
      `refusing live promote without TCP_READYZ_READY canary gateway; got ${report.gateway?.status || "<missing>"}`,
    );
  if (!report.gateway?.statusProbe)
    throw new Error("refusing live promote without canary gateway status probe");
  if (report.gateway.statusProbe.probeKind !== "gateway-healthz-readyz-local")
    throw new Error(
      `refusing live promote without gateway-healthz-readyz-local canary probe; got ${report.gateway.statusProbe.probeKind || "<missing>"}`,
    );
  if (report.gateway.statusProbe.status !== "PASS")
    throw new Error(
      `refusing live promote without PASS canary gateway status probe; got ${report.gateway.statusProbe.status || "<missing>"}`,
    );
  if (report.gateway.statusProbe.rpc?.ok === false)
    throw new Error("refusing live promote with failed canary gateway RPC probe");
  const healthz = report.gateway.statusProbe.healthz;
  const readyz = report.gateway.statusProbe.readyz;
  if (
    report.gateway.statusProbe.health?.healthy === false ||
    healthz?.ok !== true ||
    healthz?.statusCode !== 200 ||
    healthz?.body?.ok !== true ||
    healthz?.body?.status !== "live"
  )
    throw new Error("refusing live promote without exact canary /healthz contract");
  if (readyz?.ready !== true || readyz?.statusCode !== 200 || readyz?.body?.ready !== true)
    throw new Error("refusing live promote without exact canary /readyz contract");
  if (Array.isArray(report.readinessBlockers) && report.readinessBlockers.length > 0)
    throw new Error(
      `refusing live promote with canary readiness blockers: ${report.readinessBlockers.join(", ")}`,
    );
  if (report.artifactIdentity?.dirtySource?.dirty === true)
    throw new Error("refusing live promote with dirty artifact identity");
  assertGlfruitArtifactIdentity(report.artifactIdentity || report.package, "canary artifact");
}
export function assertCanaryMatchesPack(report, packOutput) {
  if (!report) return;
  if (!packOutput?.tarballPath || !packOutput?.sha256) {
    throw new Error(
      "cannot verify canary report against selected artifact; missing tarballPath or sha256",
    );
  }
  const selectedTarball = normalizeArtifactPath(packOutput.tarballPath);
  const reportTarball = normalizeArtifactPath(report.tarball);
  if (reportTarball !== selectedTarball) {
    throw new Error(
      `refusing stale canary report for different tarball: report=${reportTarball} selected=${selectedTarball}`,
    );
  }
  if (String(report.sha256).toLowerCase() !== String(packOutput.sha256).toLowerCase()) {
    throw new Error(
      `refusing stale canary report sha256 mismatch: report=${report.sha256} selected=${packOutput.sha256}`,
    );
  }
  assertGlfruitArtifactIdentity(packOutput, "selected artifact");
  assertGlfruitArtifactIdentity(reportArtifactIdentity(report), "canary artifact");
  const reportVersion = reportArtifactIdentity(report).version || report.package?.version;
  if (reportVersion !== packOutput.version) {
    throw new Error(
      `refusing stale canary report version mismatch: report=${reportVersion || "<missing>"} selected=${packOutput.version || "<missing>"}`,
    );
  }
}
function assertLiveAllowed(args, report) {
  if (!args.live) return;
  if (args.allowDirtyForLocalCanary)
    throw new Error("refusing live promote with --allow-dirty-for-local-canary");
  if (!args.confirmLive) throw new Error("refusing live promote without --confirm-live");
  assertCanaryReportReleaseReady(report);
}
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const externalCanaryReport = readCanaryReport(args.canaryReport);
  assertLiveAllowed(args, externalCanaryReport);
  let selectedTarget;
  let packOutput = null;
  if (externalCanaryReport) {
    selectedTarget = selectCanaryReportPromoteTarget(externalCanaryReport);
  } else {
    packOutput = JSON.parse(
      run([
        "scripts/package-openclaw-glfruit-local.mjs",
        "--out-dir",
        args.outDir,
        ...(args.dryRun ? ["--dry-run"] : []),
        ...(args.allowDirtyForLocalCanary ? ["--allow-dirty-for-local-canary"] : []),
      ]),
    );
    assertGlfruitArtifactIdentity(packOutput, "selected pack artifact");
    selectedTarget = {
      source: "local-pack",
      repack: true,
      packageName: packOutput.packageName,
      version: packOutput.version,
      sourceCommit: packOutput.sourceCommit,
      tarballPath: packOutput.tarballPath,
      sha256: packOutput.sha256,
    };
  }
  const steps = {
    selectedTarget,
    ...(packOutput ? { pack: packOutput } : {}),
    ...(externalCanaryReport
      ? {
          canaryReport: {
            verdict: externalCanaryReport.verdict,
            canaryGatewayVerdict: externalCanaryReport.canaryGatewayVerdict,
            releaseReadinessVerdict: externalCanaryReport.releaseReadinessVerdict,
            tarball: externalCanaryReport.tarball,
            sha256: externalCanaryReport.sha256,
            packageRoot: externalCanaryReport.packageRoot,
            package: externalCanaryReport.package,
            artifactIdentity: externalCanaryReport.artifactIdentity,
            port: externalCanaryReport.isolated?.port,
          },
        }
      : {}),
  };
  if (externalCanaryReport) assertCanaryMatchesPack(externalCanaryReport, selectedTarget);
  if (!args.dryRun) {
    run([
      "scripts/check-openclaw-glfruit-tarball.mjs",
      selectedTarget.tarballPath,
      "--expected-version",
      selectedTarget.version,
      "--expected-commit",
      selectedTarget.sourceCommit,
    ]);
    steps.check = "PASS";
    if (externalCanaryReport) {
      steps.canary = {
        source: "canary-report",
        verdict: externalCanaryReport.verdict,
        releaseReadinessVerdict: externalCanaryReport.releaseReadinessVerdict,
        canaryGatewayVerdict: externalCanaryReport.canaryGatewayVerdict,
      };
    } else {
      const canaryReport = path.join(args.outDir, "canary-dry-run-report.json");
      const canaryOutput = spawnSync(
        "node",
        [
          "scripts/canary-openclaw-local-release.mjs",
          "--tarball",
          selectedTarget.tarballPath,
          "--sha256",
          selectedTarget.sha256,
          "--dry-run",
          "--report",
          canaryReport,
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
      if (canaryOutput.stdout.trim()) steps.canary = JSON.parse(canaryOutput.stdout.trim());
      if (canaryOutput.status !== 0 && !steps.canary) {
        throw new Error(
          `node scripts/canary-openclaw-local-release.mjs failed: ${canaryOutput.stderr || canaryOutput.status}`,
        );
      }
    }
    steps.rollback = JSON.parse(
      run([
        "scripts/rollback-openclaw-local-release.mjs",
        "--target",
        selectedTarget.tarballPath,
        "--expected-sha256",
        selectedTarget.sha256,
      ]),
    );
  }
  if (args.live) {
    runCommand("npm", ["install", "-g", "--no-audit", "--no-fund", selectedTarget.tarballPath]);
    steps.liveInstall = {
      status: "PASS",
      tarball: selectedTarget.tarballPath,
      sha256: selectedTarget.sha256,
    };
  }
  const releaseReady = externalCanaryReport
    ? externalCanaryReport.releaseReadinessVerdict === "PASS" &&
      externalCanaryReport.verdict === "PASS"
    : false;
  const verdict = args.live || releaseReady ? "PASS" : "BLOCKED";
  console.log(
    JSON.stringify(
      {
        verdict,
        live: args.live,
        releaseReadinessVerdict: releaseReady ? "PASS" : "BLOCKED",
        steps,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
