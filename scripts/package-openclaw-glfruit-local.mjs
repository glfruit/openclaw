#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCOPED_NAME = "@glfruit/openclaw";

function usage() {
  return `Usage: node scripts/package-openclaw-glfruit-local.mjs [--out-dir <dir>] [--dry-run] [--allow-dirty-for-local-canary] [--glfruit-build <n>]\n\nCreates a local ${SCOPED_NAME} tarball from a temporary staging copy. The source tree package.json is never mutated. Dirty package-relevant tracked source is refused unless --allow-dirty-for-local-canary is passed for non-release local canary testing. ${SCOPED_NAME} artifacts are stamped as <baseVersion>-glfruit.N before npm pack.`;
}

function parseArgs(argv) {
  const args = {
    outDir: path.join(SOURCE_ROOT, ".artifacts", "glfruit-local-release"),
    dryRun: false,
    allowDirtyForLocalCanary: false,
    glfruitBuild: process.env.GLFRUIT_BUILD || "1",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--allow-dirty-for-local-canary") {
      args.allowDirtyForLocalCanary = true;
      continue;
    }
    if (arg === "--out-dir") {
      const value = argv[++i];
      if (!value) throw new Error("--out-dir requires a value");
      args.outDir = path.resolve(value);
      continue;
    }
    if (arg === "--glfruit-build") {
      args.glfruitBuild = argv[++i] || "";
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`,
    );
  }
  return result;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertGlfruitBuild(value) {
  if (!/^[1-9]\d*$/u.test(String(value))) {
    throw new Error(
      `--glfruit-build/GLFRUIT_BUILD must be a positive integer, got ${value || "<missing>"}`,
    );
  }
  return String(value);
}

function glfruitVersion(baseVersion, build) {
  const cleanBase = String(baseVersion).replace(/-glfruit\.\d+$/u, "");
  return `${cleanBase}-glfruit.${assertGlfruitBuild(build)}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function trackedDirtyFiles() {
  try {
    const output = run("git", [
      "-C",
      SOURCE_ROOT,
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
    ]).stdout;
    return output
      .split(/\r?\n/u)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^.* -> /u, ""))
      .filter(isPackageRelevantDirtyPath)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function isPackageRelevantDirtyPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (
    normalized.startsWith("test/") ||
    normalized.startsWith("reports/") ||
    normalized === "task_plan.md" ||
    normalized === "progress.md" ||
    normalized === "findings.md"
  ) {
    return false;
  }
  return (
    normalized === "package.json" ||
    normalized === "pnpm-lock.yaml" ||
    normalized === "tsconfig.json" ||
    normalized === "tsdown.config.ts" ||
    normalized === "openclaw.mjs" ||
    normalized === "README.md" ||
    normalized === "CHANGELOG.md" ||
    normalized === "LICENSE" ||
    normalized.startsWith("src/") ||
    normalized.startsWith("dist/") ||
    normalized.startsWith("docs/") ||
    normalized.startsWith("patches/") ||
    normalized.startsWith("skills/") ||
    normalized === "scripts/package-openclaw-glfruit-local.mjs" ||
    normalized === "scripts/check-openclaw-glfruit-tarball.mjs" ||
    normalized === "scripts/openclaw-prepack.ts" ||
    normalized === "scripts/npm-runner.mjs" ||
    normalized === "scripts/preinstall-package-manager-warning.mjs" ||
    normalized === "scripts/postinstall-bundled-plugins.mjs" ||
    normalized === "scripts/windows-cmd-helpers.mjs" ||
    normalized.startsWith("scripts/lib/")
  );
}

function dirtyFileEvidence(relativePath) {
  const absolute = path.join(SOURCE_ROOT, relativePath);
  if (!fs.existsSync(absolute)) {
    return { path: relativePath, state: "deleted" };
  }
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    return { path: relativePath, state: "directory" };
  }
  return {
    path: relativePath,
    state: "modified",
    size: stat.size,
    sha256: sha256(absolute),
  };
}

function dirtySourceIdentity() {
  const files = trackedDirtyFiles().map(dirtyFileEvidence);
  const dirty = files.length > 0;
  return {
    dirty,
    policy: dirty ? "explicit-local-canary-only" : "clean-release",
    files,
    hash: dirty ? crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex") : "",
  };
}

function assertCleanOrAllowedForLocalCanary(identity, allowDirtyForLocalCanary) {
  if (!identity.dirty) return;
  if (allowDirtyForLocalCanary) return;
  throw new Error(
    `refusing to package dirty package-relevant tracked source without --allow-dirty-for-local-canary: ${identity.files
      .map((file) => file.path)
      .join(", ")}`,
  );
}

function copySourceToStage(stageDir) {
  const excluded = new Set([".git", "node_modules", ".artifacts"]);
  fs.cpSync(SOURCE_ROOT, stageDir, {
    recursive: true,
    dereference: false,
    filter(source) {
      const relative = path.relative(SOURCE_ROOT, source).split(path.sep)[0];
      return !excluded.has(relative);
    },
  });
}

function writeScopedPackageJson(stageDir, sourcePackage, version) {
  const scopedPackage = {
    ...sourcePackage,
    name: SCOPED_NAME,
    version,
  };
  fs.writeFileSync(
    path.join(stageDir, "package.json"),
    `${JSON.stringify(scopedPackage, null, 2)}\n`,
  );
  return scopedPackage;
}

function getCommit() {
  try {
    return run("git", ["-C", SOURCE_ROOT, "rev-parse", "HEAD"]).stdout.trim();
  } catch {
    return "unknown";
  }
}

function ensureScopedBuildInfo(stageDir, sourcePackage, version, commit, builtAt, dirtySource) {
  const distDir = path.join(stageDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const buildInfoPath = path.join(distDir, "build-info.json");
  let existing = {};
  if (fs.existsSync(buildInfoPath)) {
    try {
      existing = readJson(buildInfoPath);
    } catch {
      existing = {};
    }
  }
  const buildInfo = {
    ...existing,
    packageName: SCOPED_NAME,
    version,
    baseVersion: sourcePackage.version,
    commit,
    sourceRoot: SOURCE_ROOT,
    builtAt,
    dirtySource,
  };
  fs.writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  return buildInfo;
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function runStage(command, args, stageDir, env = {}) {
  return run(command, args, {
    cwd: stageDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

function prepareStageDependencies(stageDir) {
  const sourceNodeModules = path.join(SOURCE_ROOT, "node_modules");
  const stageNodeModules = path.join(stageDir, "node_modules");
  if (fs.existsSync(sourceNodeModules) && !fs.existsSync(stageNodeModules)) {
    fs.symlinkSync(sourceNodeModules, stageNodeModules, "dir");
    return {
      command: "symlink node_modules",
      source: sourceNodeModules,
      target: stageNodeModules,
      reason:
        "reuse the already-installed repo dependency graph without copying dependencies or reaching the network",
    };
  }
  const pnpm = commandName("pnpm");
  runStage(pnpm, ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], stageDir);
  return {
    command: "pnpm install --frozen-lockfile --offline --ignore-scripts",
    reason:
      "hydrate staging dependencies from the local pnpm store when source node_modules is unavailable",
  };
}

function collectFileEvidence(stageDir, relativeFiles) {
  return Object.fromEntries(
    relativeFiles.map((relativePath) => {
      const file = path.join(stageDir, relativePath);
      if (!fs.existsSync(file)) {
        throw new Error(`fresh build missing expected runtime artifact: ${relativePath}`);
      }
      const stat = fs.statSync(file);
      return [
        relativePath,
        {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: sha256(file),
        },
      ];
    }),
  );
}

function writeFreshBuildMarker(stageDir, marker) {
  const markerPath = path.join(stageDir, "dist", "glfruit-release-fresh-build.json");
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return markerPath;
}

function runFreshBuildInStage(stageDir, sourcePackage, version, commit, builtAt, dirtySource) {
  const dependencyPreparation = prepareStageDependencies(stageDir);
  const prepackCommand = [process.execPath, "--import", "tsx", "scripts/openclaw-prepack.ts"];
  const prepackStartedAt = new Date().toISOString();
  runStage(prepackCommand[0], prepackCommand.slice(1), stageDir, {
    GIT_COMMIT: commit,
    GIT_SHA: commit,
  });
  const prepackCompletedAt = new Date().toISOString();
  const buildInfo = ensureScopedBuildInfo(
    stageDir,
    sourcePackage,
    version,
    commit,
    prepackCompletedAt,
    dirtySource,
  );
  const markerBase = {
    packageName: SCOPED_NAME,
    version,
    baseVersion: sourcePackage.version,
    commit,
    startedAt: prepackStartedAt,
    completedAt: prepackCompletedAt,
    prepackEquivalent: true,
    commands: [
      dependencyPreparation.command,
      "node --import tsx scripts/openclaw-prepack.ts",
      "npm pack --ignore-scripts --pack-destination <out-dir>",
    ],
    dependencyPreparation,
    buildInfo,
    dirtySource,
  };
  const markerPath = writeFreshBuildMarker(stageDir, markerBase);
  const runtimeFileEvidence = collectFileEvidence(stageDir, [
    "openclaw.mjs",
    "dist/index.js",
    "dist/build-info.json",
    "dist/plugin-sdk/index.js",
  ]);
  const marker = { ...markerBase, runtimeFileEvidence };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

function findPackedTarball(packOutput, outDir, version) {
  const candidates = packOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".tgz"))
    .map((line) => (path.isAbsolute(line) ? line : path.join(outDir, line)));
  const expected = path.join(outDir, `glfruit-openclaw-${version}.tgz`);
  for (const candidate of [expected, ...candidates]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`npm pack completed but no tarball was found in ${outDir}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePackagePath = path.join(SOURCE_ROOT, "package.json");
  const beforePackageJson = fs.readFileSync(sourcePackagePath, "utf8");
  const sourcePackage = JSON.parse(beforePackageJson);
  const version = glfruitVersion(sourcePackage.version, args.glfruitBuild);
  const commit = getCommit();
  const builtAt = new Date().toISOString();
  const dirtySource = dirtySourceIdentity();
  assertCleanOrAllowedForLocalCanary(dirtySource, args.allowDirtyForLocalCanary);
  const outDir = args.outDir;
  fs.mkdirSync(outDir, { recursive: true });

  const dryRunBuildInfo = {
    packageName: SCOPED_NAME,
    version,
    baseVersion: sourcePackage.version,
    commit,
    sourceRoot: SOURCE_ROOT,
    builtAt,
    dirtySource,
  };
  const manifestBase = {
    packageName: SCOPED_NAME,
    version,
    baseVersion: sourcePackage.version,
    glfruitBuild: assertGlfruitBuild(args.glfruitBuild),
    sourceCommit: commit,
    sourceRoot: SOURCE_ROOT,
    buildTime: builtAt,
    dirtySource,
    buildInfo: dryRunBuildInfo,
    packageMetadata: {
      name: SCOPED_NAME,
      version,
      baseVersion: sourcePackage.version,
      bin: sourcePackage.bin,
      exports: sourcePackage.exports,
      files: sourcePackage.files,
    },
    sourcePackageJsonUnchanged: fs.readFileSync(sourcePackagePath, "utf8") === beforePackageJson,
  };

  if (args.dryRun) {
    const manifestPath = path.join(outDir, `glfruit-openclaw-${version}.dry-run.manifest.json`);
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifestBase, dryRun: true }, null, 2)}\n`,
    );
    console.log(JSON.stringify({ ...manifestBase, dryRun: true, manifestPath }, null, 2));
    return;
  }

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-glfruit-pack-stage-"));
  try {
    copySourceToStage(stageDir);
    const scopedPackage = writeScopedPackageJson(stageDir, sourcePackage, version);
    const freshBuild = runFreshBuildInStage(
      stageDir,
      sourcePackage,
      version,
      commit,
      builtAt,
      dirtySource,
    );
    const pack = run("npm", ["pack", "--ignore-scripts", "--pack-destination", outDir], {
      cwd: stageDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarballPath = findPackedTarball(pack.stdout, outDir, version);
    const manifest = {
      ...manifestBase,
      buildInfo: freshBuild.buildInfo,
      freshBuild,
      packageMetadata: {
        name: scopedPackage.name,
        version: scopedPackage.version,
        bin: scopedPackage.bin,
        exports: scopedPackage.exports,
        files: scopedPackage.files,
      },
      dryRun: false,
      tarballPath,
      sha256: sha256(tarballPath),
    };
    const manifestPath = path.join(outDir, `glfruit-openclaw-${version}.manifest.json`);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (fs.readFileSync(sourcePackagePath, "utf8") !== beforePackageJson) {
      throw new Error("source package.json changed during packaging");
    }
    console.log(JSON.stringify({ ...manifest, manifestPath }, null, 2));
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
