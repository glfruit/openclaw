import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function writeJson(root: string, relativePath: string, value: unknown) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(root: string, relativePath: string, value: string) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, value, "utf8");
}

type FixtureOptions = {
  rootMirrorsDependency?: boolean;
  rootImporter?: boolean;
  postinstallInventory?: boolean;
  stagedNodeModules?: boolean;
};

function createRuntimeDepsFixture(options: FixtureOptions = {}) {
  const packageRoot = createTempDir("openclaw-built-runtime-deps-");
  writeJson(packageRoot, "package.json", {
    name: "openclaw",
    version: "0.0.0-test",
    dependencies: options.rootMirrorsDependency
      ? {
          "@pierre/diffs": "^0.1.0",
        }
      : {},
  });
  writeJson(packageRoot, "extensions/diffs/package.json", {
    name: "@openclaw/diffs",
    dependencies: {
      "@pierre/diffs": "^0.1.0",
    },
  });
  writeJson(packageRoot, "dist/extensions/diffs/package.json", {
    name: "@openclaw/diffs",
    dependencies: {
      "@pierre/diffs": "^0.1.0",
    },
    openclaw: {
      bundle: {
        stageRuntimeDependencies: true,
      },
    },
  });
  if (options.stagedNodeModules) {
    writeJson(packageRoot, "dist/extensions/diffs/node_modules/@pierre/diffs/package.json", {
      name: "@pierre/diffs",
      version: "0.1.0",
    });
  }
  if (options.rootImporter) {
    writeText(packageRoot, "dist/root-importer.mjs", "import '@pierre/diffs';\n");
  }
  if (options.postinstallInventory) {
    writeJson(packageRoot, "dist/postinstall-inventory.json", {
      files: ["dist/extensions/diffs/package.json"],
    });
  }
  return packageRoot;
}

function runSmoke(packageRoot: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), "scripts/test-built-bundled-runtime-deps.mjs"),
      ...args,
      "--package-root",
      packageRoot,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}

describe("test-built-bundled-runtime-deps smoke modes", () => {
  it("fails default pre-prune validation even when stale postinstall inventory exists", () => {
    const packageRoot = createRuntimeDepsFixture({
      postinstallInventory: true,
      rootMirrorsDependency: true,
    });

    const result = runSmoke(packageRoot);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "built bundled plugin 'diffs' is missing staged runtime dependency '@pierre/diffs: ^0.1.0' under dist/extensions/diffs/node_modules.",
    );
  });

  it("allows explicit post-prepack staged-deps skip but still validates root mirrors", () => {
    const prunedPackageRoot = createRuntimeDepsFixture({
      postinstallInventory: true,
      rootMirrorsDependency: true,
    });

    const prunedResult = runSmoke(prunedPackageRoot, ["--post-prepack"]);

    expect(prunedResult.status).toBe(0);
    expect(prunedResult.stdout).toContain(
      "staged-node_modules check skipped for explicit post-prepack package root",
    );

    const missingRootMirrorPackageRoot = createRuntimeDepsFixture({
      postinstallInventory: true,
      rootImporter: true,
    });

    const missingRootMirrorResult = runSmoke(missingRootMirrorPackageRoot, ["--post-prepack"]);

    expect(missingRootMirrorResult.status).not.toBe(0);
    expect(`${missingRootMirrorResult.stdout}\n${missingRootMirrorResult.stderr}`).toContain(
      "installed package root is missing mirrored bundled runtime dependency '@pierre/diffs' for dist importers: root-importer.mjs",
    );
    expect(`${missingRootMirrorResult.stdout}\n${missingRootMirrorResult.stderr}`).not.toContain(
      "built bundled plugin 'diffs' is missing staged runtime dependency",
    );
  });

  it("allows env-triggered post-prepack staged-deps skip but still validates root mirrors", () => {
    const env = { OPENCLAW_BUNDLED_RUNTIME_DEPS_POST_PREPACK: "true" };
    const prunedPackageRoot = createRuntimeDepsFixture({
      postinstallInventory: true,
      rootMirrorsDependency: true,
    });

    const prunedResult = runSmoke(prunedPackageRoot, [], env);

    expect(prunedResult.status).toBe(0);
    expect(prunedResult.stdout).toContain(
      "staged-node_modules check skipped for explicit post-prepack package root",
    );

    const missingRootMirrorPackageRoot = createRuntimeDepsFixture({
      postinstallInventory: true,
      rootImporter: true,
    });

    const missingRootMirrorResult = runSmoke(missingRootMirrorPackageRoot, [], env);

    expect(missingRootMirrorResult.status).not.toBe(0);
    expect(`${missingRootMirrorResult.stdout}\n${missingRootMirrorResult.stderr}`).toContain(
      "installed package root is missing mirrored bundled runtime dependency '@pierre/diffs' for dist importers: root-importer.mjs",
    );
    expect(`${missingRootMirrorResult.stdout}\n${missingRootMirrorResult.stderr}`).not.toContain(
      "built bundled plugin 'diffs' is missing staged runtime dependency",
    );
  });
});
