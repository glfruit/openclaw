#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const SCOPED_NAME = "@glfruit/openclaw";
const REQUIRED_EXPORTS = ["plugin-sdk", "plugin-sdk/runtime", "plugin-sdk/plugin-runtime"];
const REQUIRED_FILES = [
  "package.json",
  "openclaw.mjs",
  "dist/build-info.json",
  "dist/glfruit-release-fresh-build.json",
  "dist/plugin-sdk/index.js",
  "dist/plugin-sdk/runtime.js",
  "dist/plugin-sdk/plugin-runtime.js",
];

function usage() {
  return `Usage: node scripts/check-openclaw-glfruit-tarball.mjs <tarball.tgz> [--expected-version <version>] [--expected-commit <sha>] [--skip-install-resolve]`;
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
function parseArgs(argv) {
  const args = { tarball: "", expectedVersion: "", expectedCommit: "", skipInstallResolve: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--expected-version") {
      args.expectedVersion = argv[++i] || fail("--expected-version requires a value");
      continue;
    }
    if (arg === "--expected-commit") {
      args.expectedCommit = argv[++i] || fail("--expected-commit requires a value");
      continue;
    }
    if (arg === "--skip-install-resolve") {
      args.skipInstallResolve = true;
      continue;
    }
    if (!args.tarball) {
      args.tarball = path.resolve(arg);
      continue;
    }
    fail(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!args.tarball) fail(usage());
  return args;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`,
    );
  return result;
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function assertInstalledResolves(tarball) {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-glfruit-install-"));
  try {
    fs.writeFileSync(path.join(prefix, "package.json"), '{"type":"module"}\n');
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
      cwd: prefix,
    });
    const require = createRequire(path.join(prefix, "resolve-check.cjs"));
    for (const surface of REQUIRED_EXPORTS) {
      require.resolve(`${SCOPED_NAME}/${surface}`);
    }
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.tarball)) fail(`tarball does not exist: ${args.tarball}`);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-glfruit-check-"));
  try {
    run("tar", ["-xzf", args.tarball, "-C", extractDir]);
    const packageRoot = path.join(extractDir, "package");
    const errors = [];
    for (const required of REQUIRED_FILES) {
      if (!fs.existsSync(path.join(packageRoot, required))) errors.push(`missing ${required}`);
    }
    const pkg = fs.existsSync(path.join(packageRoot, "package.json"))
      ? readJson(path.join(packageRoot, "package.json"))
      : {};
    if (pkg.name !== SCOPED_NAME)
      errors.push(`package name mismatch: expected ${SCOPED_NAME}, got ${pkg.name || "<missing>"}`);
    if (args.expectedVersion && pkg.version !== args.expectedVersion)
      errors.push(
        `version mismatch: expected ${args.expectedVersion}, got ${pkg.version || "<missing>"}`,
      );
    if (pkg.bin?.openclaw !== "openclaw.mjs") errors.push("bin.openclaw must equal openclaw.mjs");
    for (const surface of REQUIRED_EXPORTS) {
      const key = `./${surface}`;
      const target = pkg.exports?.[key]?.default || pkg.exports?.[key];
      if (!target) errors.push(`missing export ${key}`);
    }
    const buildInfoPath = path.join(packageRoot, "dist", "build-info.json");
    let buildInfo = {};
    if (fs.existsSync(buildInfoPath)) {
      buildInfo = readJson(buildInfoPath);
      if (!buildInfo.commit) errors.push("dist/build-info.json missing commit");
      if (buildInfo.packageName !== SCOPED_NAME)
        errors.push(
          `dist/build-info.json packageName mismatch: expected ${SCOPED_NAME}, got ${buildInfo.packageName || "<missing>"}`,
        );
      if (args.expectedCommit && buildInfo.commit !== args.expectedCommit)
        errors.push(
          `commit mismatch: expected ${args.expectedCommit}, got ${buildInfo.commit || "<missing>"}`,
        );
    }
    const freshBuildPath = path.join(packageRoot, "dist", "glfruit-release-fresh-build.json");
    if (fs.existsSync(freshBuildPath)) {
      const freshBuild = readJson(freshBuildPath);
      if (freshBuild.packageName !== SCOPED_NAME)
        errors.push(
          `fresh build marker packageName mismatch: expected ${SCOPED_NAME}, got ${freshBuild.packageName || "<missing>"}`,
        );
      if (!freshBuild.completedAt) errors.push("fresh build marker missing completedAt");
      if (!freshBuild.prepackEquivalent)
        errors.push("fresh build marker missing prepackEquivalent=true");
      if (!Array.isArray(freshBuild.commands) || freshBuild.commands.length === 0)
        errors.push("fresh build marker missing commands");
      if (!freshBuild.runtimeFileEvidence?.["dist/index.js"]?.sha256)
        errors.push("fresh build marker missing dist/index.js sha256 evidence");
      if (args.expectedCommit && freshBuild.commit !== args.expectedCommit)
        errors.push(
          `fresh build marker commit mismatch: expected ${args.expectedCommit}, got ${freshBuild.commit || "<missing>"}`,
        );
    }
    if (errors.length) fail(errors.join("\n"));
    if (!args.skipInstallResolve) assertInstalledResolves(args.tarball);
    console.log(`OpenClaw glfruit tarball check passed: ${args.tarball}`);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
