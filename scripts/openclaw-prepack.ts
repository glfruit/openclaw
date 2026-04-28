#!/usr/bin/env -S node --import tsx

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { writePackageDistInventory } from "../src/infra/package-dist-inventory.ts";
const requiredPreparedPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  ["dist/control-ui/index.html"],
];
const requiredControlUiAssetPrefix = "dist/control-ui/assets/";

type PreparedFileReader = {
  existsSync: typeof existsSync;
  readdirSync: typeof readdirSync;
};

type PrepackCleanupReader = {
  existsSync: typeof existsSync;
  readdirSync: typeof readdirSync;
  rmSync: typeof rmSync;
};

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function prunePrepackBundledExtensionNodeModules(
  packageRoot = process.cwd(),
  reader: PrepackCleanupReader = { existsSync, readdirSync, rmSync },
): string[] {
  const distExtensionsDir = join(packageRoot, "dist", "extensions");
  if (!reader.existsSync(distExtensionsDir)) {
    return [];
  }

  const removed: string[] = [];
  const sharedNodeModulesDir = join(distExtensionsDir, "node_modules");
  if (reader.existsSync(sharedNodeModulesDir)) {
    reader.rmSync(sharedNodeModulesDir, { recursive: true, force: true });
    removed.push(normalizeRelativePath(relative(packageRoot, sharedNodeModulesDir)));
  }

  for (const entry of reader.readdirSync(distExtensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "node_modules") {
      continue;
    }
    const nodeModulesDir = join(distExtensionsDir, entry.name, "node_modules");
    if (!reader.existsSync(nodeModulesDir)) {
      continue;
    }
    reader.rmSync(nodeModulesDir, { recursive: true, force: true });
    removed.push(normalizeRelativePath(relative(packageRoot, nodeModulesDir)));
  }

  return removed.toSorted((left, right) => left.localeCompare(right));
}

function normalizeFiles(files: Iterable<string>): Set<string> {
  return new Set(Array.from(files, (file) => file.replace(/\\/g, "/")));
}

export function collectPreparedPrepackErrors(
  files: Iterable<string>,
  assetPaths: Iterable<string>,
): string[] {
  const normalizedFiles = normalizeFiles(files);
  const normalizedAssets = normalizeFiles(assetPaths);
  const errors: string[] = [];

  for (const group of requiredPreparedPathGroups) {
    if (group.some((path) => normalizedFiles.has(path))) {
      continue;
    }
    errors.push(`missing required prepared artifact: ${group.join(" or ")}`);
  }

  if (!normalizedAssets.values().next().done) {
    return errors;
  }

  errors.push(`missing prepared Control UI asset payload under ${requiredControlUiAssetPrefix}`);
  return errors;
}

function collectPreparedFilePaths(reader: PreparedFileReader = { existsSync, readdirSync }): {
  files: Set<string>;
  assets: string[];
} {
  const assets = reader
    .readdirSync("dist/control-ui/assets", { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? [] : [`${requiredControlUiAssetPrefix}${entry.name}`],
    );

  const files = new Set<string>();
  for (const group of requiredPreparedPathGroups) {
    for (const path of group) {
      if (reader.existsSync(path)) {
        files.add(path);
      }
    }
  }

  return {
    files,
    assets,
  };
}

function ensurePreparedArtifacts(): void {
  try {
    const preparedFiles = collectPreparedFilePaths();
    const errors = collectPreparedPrepackErrors(preparedFiles.files, preparedFiles.assets);
    if (errors.length === 0) {
      console.error("prepack: using existing prepared artifacts.");
      return;
    }
    for (const error of errors) {
      console.error(`prepack: ${error}`);
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    console.error(`prepack: failed to verify prepared artifacts: ${message}`);
  }

  console.error(
    "prepack: requires an existing build and Control UI bundle. Run `pnpm build && pnpm ui:build` before packing or publishing.",
  );
  process.exit(1);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status === 0) {
    return;
  }
  process.exit(result.status ?? 1);
}

function runBuildSmoke(): void {
  run(process.execPath, ["scripts/test-built-bundled-channel-entry-smoke.mjs"]);
}

async function writeDistInventory(): Promise<void> {
  await writePackageDistInventory(process.cwd());
}

type PrepackRun = (command: string, args: string[]) => void;

type RunPrepackOptions = {
  pnpmCommand?: string;
  run?: PrepackRun;
  ensurePreparedArtifacts?: () => void;
  prunePrepackBundledExtensionNodeModules?: () => string[];
  writeDistInventory?: () => Promise<void>;
  runBuildSmoke?: () => void;
  logger?: Pick<Console, "error">;
};

export async function runPrepack(options: RunPrepackOptions = {}): Promise<void> {
  const pnpmCommand = options.pnpmCommand ?? (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  const runCommand = options.run ?? run;
  const verifyPreparedArtifacts = options.ensurePreparedArtifacts ?? ensurePreparedArtifacts;
  const pruneBundledExtensionNodeModules =
    options.prunePrepackBundledExtensionNodeModules ?? prunePrepackBundledExtensionNodeModules;
  const writeInventory = options.writeDistInventory ?? writeDistInventory;
  const runSmoke = options.runBuildSmoke ?? runBuildSmoke;
  const logger = options.logger ?? console;

  runCommand(pnpmCommand, ["build"]);
  runCommand(pnpmCommand, ["ui:build"]);
  verifyPreparedArtifacts();
  runSmoke();
  const removedNodeModules = pruneBundledExtensionNodeModules();
  if (removedNodeModules.length > 0) {
    logger.error(`prepack: pruned bundled extension node_modules: ${removedNodeModules.length}`);
  }
  await writeInventory();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runPrepack();
}
