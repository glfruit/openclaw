import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const PACK_SCRIPT = "scripts/package-openclaw-glfruit-local.mjs";
const CHECK_SCRIPT = "scripts/check-openclaw-glfruit-tarball.mjs";
const PROMOTE_SCRIPT = "scripts/promote-openclaw-local-release.mjs";
const ROLLBACK_SCRIPT = "scripts/rollback-openclaw-local-release.mjs";
const CANARY_SCRIPT = "scripts/canary-openclaw-local-release.mjs";

function runNode(args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync("node", args, {
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function withTemp(body: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-glfruit-release-test-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePackageTarball(
  root: string,
  packageJson: Record<string, unknown>,
  files: Record<string, string>,
) {
  const packageRoot = join(root, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  for (const [relativePath, contents] of Object.entries(files)) {
    const file = join(packageRoot, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  const tarball = join(root, "package.tgz");
  const tar = spawnSync("tar", ["-czf", tarball, "-C", root, "package"], { encoding: "utf8" });
  expect(tar.status, tar.stderr).toBe(0);
  return tarball;
}

const validFiles = {
  "openclaw.mjs": "#!/usr/bin/env node\n",
  "dist/build-info.json": JSON.stringify({ commit: "abc123", packageName: "@glfruit/openclaw" }),
  "dist/glfruit-release-fresh-build.json": JSON.stringify({
    packageName: "@glfruit/openclaw",
    commit: "abc123",
    completedAt: "2026-05-13T00:00:00.000Z",
    prepackEquivalent: true,
    commands: ["node --import tsx scripts/openclaw-prepack.ts"],
    runtimeFileEvidence: { "dist/index.js": { sha256: "abc", mtimeMs: 1, size: 1 } },
  }),
  "dist/plugin-sdk/index.js": "export {};\n",
  "dist/plugin-sdk/runtime.js": "export {};\n",
  "dist/plugin-sdk/plugin-runtime.js": "export {};\n",
};

const validPackageJson = {
  name: "@glfruit/openclaw",
  version: "1.2.3",
  bin: { openclaw: "openclaw.mjs" },
  exports: {
    "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" },
    "./plugin-sdk/runtime": { default: "./dist/plugin-sdk/runtime.js" },
    "./plugin-sdk/plugin-runtime": { default: "./dist/plugin-sdk/plugin-runtime.js" },
  },
};

describe("glfruit local release scripts", () => {
  it("rejects an unscoped tarball for the glfruit path", () => {
    withTemp((dir) => {
      const tarball = writePackageTarball(
        dir,
        { ...validPackageJson, name: "openclaw" },
        validFiles,
      );
      const result = runNode([CHECK_SCRIPT, tarball, "--skip-install-resolve"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("package name mismatch");
    });
  });

  it("check script rejects mismatched version", () => {
    withTemp((dir) => {
      const tarball = writePackageTarball(dir, validPackageJson, validFiles);
      const result = runNode([
        CHECK_SCRIPT,
        tarball,
        "--expected-version",
        "9.9.9",
        "--skip-install-resolve",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("version mismatch");
    });
  });

  it("check script rejects missing build-info commit", () => {
    withTemp((dir) => {
      const tarball = writePackageTarball(dir, validPackageJson, {
        ...validFiles,
        "dist/build-info.json": "{}",
      });
      const result = runNode([CHECK_SCRIPT, tarball, "--skip-install-resolve"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("dist/build-info.json missing commit");
    });
  });

  it("check script rejects missing fresh-build marker", () => {
    withTemp((dir) => {
      const { ["dist/glfruit-release-fresh-build.json"]: _marker, ...files } = validFiles;
      const tarball = writePackageTarball(dir, validPackageJson, files);
      const result = runNode([CHECK_SCRIPT, tarball, "--skip-install-resolve"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing dist/glfruit-release-fresh-build.json");
    });
  });

  it("check script rejects stale fresh-build marker commit", () => {
    withTemp((dir) => {
      const tarball = writePackageTarball(dir, validPackageJson, {
        ...validFiles,
        "dist/glfruit-release-fresh-build.json": JSON.stringify({
          packageName: "@glfruit/openclaw",
          commit: "stale",
          completedAt: "2026-05-13T00:00:00.000Z",
          prepackEquivalent: true,
          commands: ["node --import tsx scripts/openclaw-prepack.ts"],
          runtimeFileEvidence: { "dist/index.js": { sha256: "abc", mtimeMs: 1, size: 1 } },
        }),
      });
      const result = runNode([
        CHECK_SCRIPT,
        tarball,
        "--expected-commit",
        "abc123",
        "--skip-install-resolve",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("fresh build marker commit mismatch");
    });
  });

  it("packaging dry-run proves source package.json is unchanged and manifest is scoped", () => {
    withTemp((dir) => {
      const before = readFileSync("package.json", "utf8");
      const result = runNode([PACK_SCRIPT, "--dry-run", "--out-dir", dir]);
      const after = readFileSync("package.json", "utf8");
      expect(result.status, result.stderr).toBe(0);
      const manifest = JSON.parse(result.stdout);
      expect(after).toBe(before);
      expect(manifest.packageName).toBe("@glfruit/openclaw");
      expect(manifest.sourcePackageJsonUnchanged).toBe(true);
      expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(manifest.buildInfo.packageName).toBe("@glfruit/openclaw");
    });
  });

  it("pack script runs prepack-equivalent fresh build before npm pack", () => {
    const script = readFileSync(PACK_SCRIPT, "utf8");
    expect(script.indexOf("runFreshBuildInStage(stageDir")).toBeGreaterThan(-1);
    expect(script.indexOf("runFreshBuildInStage(stageDir")).toBeLessThan(
      script.indexOf('run("npm", ["pack", "--ignore-scripts"'),
    );
    expect(script).toContain("glfruit-release-fresh-build.json");
  });

  it("promote defaults to pack, check, canary dry-run, and rollback dry-run", () => {
    const script = readFileSync(PROMOTE_SCRIPT, "utf8");
    expect(script.indexOf("scripts/package-openclaw-glfruit-local.mjs")).toBeLessThan(
      script.indexOf("scripts/check-openclaw-glfruit-tarball.mjs"),
    );
    expect(script.indexOf("scripts/check-openclaw-glfruit-tarball.mjs")).toBeLessThan(
      script.indexOf("scripts/canary-openclaw-local-release.mjs"),
    );
    expect(script.indexOf("scripts/canary-openclaw-local-release.mjs")).toBeLessThan(
      script.indexOf("scripts/rollback-openclaw-local-release.mjs"),
    );
    expect(script).toContain('"--dry-run"');
  });

  it("promote refuses live without explicit flags and canary PASS", () => {
    const noConfirm = runNode([PROMOTE_SCRIPT, "--live"]);
    expect(noConfirm.status).not.toBe(0);
    expect(noConfirm.stderr).toContain("--confirm-live");

    withTemp((dir) => {
      const report = join(dir, "canary.json");
      writeFileSync(report, JSON.stringify({ verdict: "DRY_RUN" }));
      const result = runNode([
        PROMOTE_SCRIPT,
        "--live",
        "--confirm-live",
        "--canary-report",
        report,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("canary PASS");
    });
  });

  it("rollback defaults to dry-run and refuses execute", () => {
    const dryRun = runNode([ROLLBACK_SCRIPT, "--target", "@glfruit/openclaw@2026.5.6-glfruit.10"]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(JSON.parse(dryRun.stdout).dryRun).toBe(true);

    const execute = runNode([
      ROLLBACK_SCRIPT,
      "--target",
      "@glfruit/openclaw@2026.5.6-glfruit.10",
      "--execute",
    ]);
    expect(execute.status).not.toBe(0);
    expect(execute.stderr).toContain("stop-gated");
  });

  it("canary records isolated dirs and refuses live credentials by default", () => {
    withTemp((dir) => {
      const tarball = writePackageTarball(dir, validPackageJson, validFiles);
      const shasum = spawnSync("shasum", ["-a", "256", tarball], { encoding: "utf8" });
      expect(shasum.status, shasum.stderr).toBe(0);
      const sha = shasum.stdout.split(/\s+/)[0];
      const refused = runNode([CANARY_SCRIPT, "--tarball", tarball, "--sha256", sha, "--dry-run"], {
        env: { TELEGRAM_BOT_TOKEN: "live-ish" },
      });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("refusing live credentials");

      const report = join(dir, "canary-report.json");
      const result = runNode(
        [CANARY_SCRIPT, "--tarball", tarball, "--sha256", sha, "--dry-run", "--report", report],
        {
          env: { TELEGRAM_BOT_TOKEN: "" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.isolated.home).toContain("openclaw-glfruit-canary-");
      expect(parsed.isolated.prefix).toContain("prefix");
      expect(parsed.isolated.port).toBe(0);
      expect(parsed.pluginRuntimeSmokeHooks.length).toBeGreaterThan(0);
      expect(parsed.jsonGuardSmokeHooks.length).toBeGreaterThan(0);
    });
  });
});
