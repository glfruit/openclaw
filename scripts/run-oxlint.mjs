import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
  resolveLocalHeavyCheckEnv,
  shouldAcquireLocalHeavyCheckLockForOxlint,
} from "./lib/local-heavy-check-runtime.mjs";
import { runManagedCommand } from "./lib/managed-child-process.mjs";

const oxlintPath = path.resolve("node_modules", ".bin", "oxlint");
const PREPARE_EXTENSION_BOUNDARY_ARGS = [
  path.resolve("scripts", "prepare-extension-package-boundary-artifacts.mjs"),
];
const OXLINT_PREPARE_SKIP_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-V",
  "--print-config",
  "--rules",
  "--init",
  "--lsp",
]);
const OXLINT_VALUE_FLAGS = new Set([
  "--config",
  "--deny",
  "--env",
  "--format",
  "--globals",
  "--ignore-path",
  "--max-warnings",
  "--output-file",
  "--plugin",
  "--rules",
  "--tsconfig",
  "--warn",
]);

export function shouldPrepareExtensionPackageBoundaryArtifacts(args) {
  return !args.some((arg) => OXLINT_PREPARE_SKIP_FLAGS.has(arg));
}

export function filterSparseMissingOxlintTargets(
  args,
  {
    cwd = process.cwd(),
    fileExists = fs.existsSync,
    isSparseCheckoutEnabled = getSparseCheckoutEnabled,
    isTrackedPath = hasTrackedPath,
  } = {},
) {
  if (!isSparseCheckoutEnabled({ cwd })) {
    return { args, hadExplicitTargets: false, remainingExplicitTargets: 0, skippedTargets: [] };
  }

  const targetResult = mapOxlintTargetArgs(args, (arg) => {
    const absoluteTarget = path.resolve(cwd, arg);
    if (!fileExists(absoluteTarget) && isTrackedPath({ cwd, target: arg })) {
      return { replacement: [], skipped: true };
    }

    return { replacement: [arg], kept: true };
  });

  return {
    args: targetResult.args,
    hadExplicitTargets: targetResult.hadExplicitTargets,
    remainingExplicitTargets: targetResult.remainingExplicitTargets,
    skippedTargets: targetResult.skippedTargets,
  };
}

export function expandDirectoryOxlintTargets(
  args,
  { cwd = process.cwd(), stat = fs.statSync, listTrackedFiles = listTrackedFilesUnderTargets } = {},
) {
  const expandedTargets = [];
  const targetResult = mapOxlintTargetArgs(args, (arg) => {
    const absoluteTarget = path.resolve(cwd, arg);
    try {
      if (!stat(absoluteTarget).isDirectory()) {
        return { replacement: [arg], kept: true };
      }
    } catch {
      return { replacement: [arg], kept: true };
    }

    const files = listTrackedFiles({ cwd, targets: [arg] }).filter(isOxlintLintablePath);
    if (files.length === 0) {
      return { replacement: [arg], kept: true };
    }

    expandedTargets.push({ target: arg, fileCount: files.length });
    return { replacement: files, kept: true, count: files.length };
  });

  return {
    args: targetResult.args,
    hadExplicitTargets: targetResult.hadExplicitTargets,
    remainingExplicitTargets: targetResult.remainingExplicitTargets,
    expandedTargets,
  };
}

function mapOxlintTargetArgs(args, mapTarget) {
  const mappedArgs = [];
  const skippedTargets = [];
  let hadExplicitTargets = false;
  let remainingExplicitTargets = 0;
  let consumeNextValue = false;
  let afterSeparator = false;

  for (const arg of args) {
    if (!afterSeparator && consumeNextValue) {
      mappedArgs.push(arg);
      consumeNextValue = false;
      continue;
    }

    if (!afterSeparator && arg === "--") {
      mappedArgs.push(arg);
      afterSeparator = true;
      continue;
    }

    if (!afterSeparator && arg.startsWith("--")) {
      mappedArgs.push(arg);
      if (!arg.includes("=") && OXLINT_VALUE_FLAGS.has(arg)) {
        consumeNextValue = true;
      }
      continue;
    }

    if (!afterSeparator && arg.startsWith("-")) {
      mappedArgs.push(arg);
      continue;
    }

    hadExplicitTargets = true;
    const result = mapTarget(arg);
    if (result.skipped) {
      skippedTargets.push(arg);
      continue;
    }

    remainingExplicitTargets += result.count ?? result.replacement.length;
    mappedArgs.push(...result.replacement);
  }

  return { args: mappedArgs, hadExplicitTargets, remainingExplicitTargets, skippedTargets };
}

function isOxlintLintablePath(target) {
  return /\.(?:[cm]?[jt]sx?|vue)$/u.test(target);
}

function listTrackedFilesUnderTargets({ cwd, targets }) {
  const result = spawnSync("git", ["ls-files", "-z", "--", ...targets], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    return [];
  }

  return result.stdout.split("\0").filter(Boolean);
}

function getSparseCheckoutEnabled({ cwd }) {
  const result = spawnSync("git", ["config", "--get", "--bool", "core.sparseCheckout"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  return result.status === 0 && result.stdout.trim() === "true";
}

function hasTrackedPath({ cwd, target }) {
  const result = spawnSync("git", ["ls-files", "--", target], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  return result.status === 0 && result.stdout.trim().length > 0;
}

async function prepareExtensionPackageBoundaryArtifacts(env) {
  const releaseArtifactsLock = acquireLocalHeavyCheckLockSync({
    cwd: process.cwd(),
    env,
    toolName: "extension-package-boundary-artifacts",
    lockName: "extension-package-boundary-artifacts",
  });

  try {
    const status = await runManagedCommand({
      bin: process.execPath,
      args: PREPARE_EXTENSION_BOUNDARY_ARGS,
      env,
    });

    if (status !== 0) {
      throw new Error(
        `prepare-extension-package-boundary-artifacts failed with exit code ${status}`,
      );
    }
  } finally {
    releaseArtifactsLock();
  }
}

export async function main(argv = process.argv.slice(2), runtimeEnv = process.env) {
  const { args: policyArgs, env } = applyLocalOxlintPolicy(
    argv,
    resolveLocalHeavyCheckEnv(runtimeEnv),
  );
  const sparseTargets = filterSparseMissingOxlintTargets(policyArgs);
  if (sparseTargets.skippedTargets.length > 0) {
    console.error(
      `[oxlint] sparse checkout is missing tracked target(s); skipping ${sparseTargets.skippedTargets.join(", ")}`,
    );
  }
  if (sparseTargets.hadExplicitTargets && sparseTargets.remainingExplicitTargets === 0) {
    console.error("[oxlint] no present sparse-checkout targets remain; skipping oxlint.");
    return;
  }

  const expandedTargets = expandDirectoryOxlintTargets(sparseTargets.args);
  const finalArgs = expandedTargets.args;
  for (const target of expandedTargets.expandedTargets) {
    console.error(`[oxlint] expanded ${target.target} to ${target.fileCount} tracked lint file(s)`);
  }

  const releaseLock =
    env.OPENCLAW_OXLINT_SKIP_LOCK === "1"
      ? () => {}
      : shouldAcquireLocalHeavyCheckLockForOxlint(sparseTargets.args, {
            cwd: process.cwd(),
            env,
          })
        ? acquireLocalHeavyCheckLockSync({
            cwd: process.cwd(),
            env,
            toolName: "oxlint",
          })
        : () => {};

  try {
    if (
      env.OPENCLAW_OXLINT_SKIP_PREPARE !== "1" &&
      shouldPrepareExtensionPackageBoundaryArtifacts(finalArgs)
    ) {
      await prepareExtensionPackageBoundaryArtifacts(env);
    }

    const status = await runManagedCommand({
      bin: oxlintPath,
      args: finalArgs,
      env,
    });
    process.exitCode = status;
  } finally {
    releaseLock();
  }
}

if (import.meta.main) {
  await main();
}
