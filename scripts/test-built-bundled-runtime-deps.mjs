import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  collectBuiltBundledPluginStagedRuntimeDependencyErrors,
  collectBundledPluginRootRuntimeMirrorErrors,
  collectBundledPluginRuntimeDependencySpecs,
  collectRootDistBundledRuntimeMirrors,
} from "./lib/bundled-plugin-root-runtime-mirrors.mjs";
import { parsePackageRootArg } from "./lib/package-root-args.mjs";

function parseSmokeArgs(argv) {
  const packageRootArgs = [];
  let postPrepack = ["1", "true"].includes(
    String(process.env.OPENCLAW_BUNDLED_RUNTIME_DEPS_POST_PREPACK ?? "").toLowerCase(),
  );

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--post-prepack") {
      postPrepack = true;
      continue;
    }
    packageRootArgs.push(arg);
  }

  const { packageRoot } = parsePackageRootArg(
    packageRootArgs,
    "OPENCLAW_BUNDLED_RUNTIME_DEPS_ROOT",
  );
  return { packageRoot, postPrepack };
}

const { packageRoot, postPrepack } = parseSmokeArgs(process.argv.slice(2));
const rootPackageJsonPath = path.join(packageRoot, "package.json");
const builtPluginsDir = path.join(packageRoot, "dist", "extensions");

assert.ok(fs.existsSync(rootPackageJsonPath), `package.json missing from ${packageRoot}`);
assert.ok(fs.existsSync(builtPluginsDir), `built bundled plugins missing from ${builtPluginsDir}`);

const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8"));
const bundledRuntimeDependencySpecs = collectBundledPluginRuntimeDependencySpecs(
  path.join(packageRoot, "extensions"),
);
const requiredRootMirrors = collectRootDistBundledRuntimeMirrors({
  bundledRuntimeDependencySpecs,
  distDir: path.join(packageRoot, "dist"),
});
const rootMirrorErrors = collectBundledPluginRootRuntimeMirrorErrors({
  bundledRuntimeDependencySpecs,
  requiredRootMirrors,
  rootPackageJson,
});
const stagedRuntimeDependencyErrors = collectBuiltBundledPluginStagedRuntimeDependencyErrors({
  bundledPluginsDir: builtPluginsDir,
});
if (postPrepack && stagedRuntimeDependencyErrors.length > 0) {
  assert.deepEqual(rootMirrorErrors, [], rootMirrorErrors.join("\n"));
  process.stdout.write(
    `[build-smoke] bundled runtime dependency staged-node_modules check skipped for explicit post-prepack package root; prepack intentionally prunes dist/extensions/*/node_modules. Run this smoke without --post-prepack before prepack to validate staged workspace deps. packageRoot=${packageRoot}\n`,
  );
} else {
  const errors = [...rootMirrorErrors, ...stagedRuntimeDependencyErrors];
  assert.deepEqual(errors, [], errors.join("\n"));
  process.stdout.write(
    `[build-smoke] bundled runtime dependency smoke passed packageRoot=${packageRoot}\n`,
  );
}
