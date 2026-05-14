import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { gatewayLocalHealthzReadyzProbe } from "../../scripts/canary-openclaw-local-release.mjs";
import {
  assertCanaryMatchesPack,
  assertCanaryReportReleaseReady,
} from "../../scripts/promote-openclaw-local-release.mjs";

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

function withHttpServer(
  routes: Record<string, { statusCode: number; body: unknown }>,
  body: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    const route = routes[request.url || ""];
    if (route) {
      response.writeHead(route.statusCode, { "content-type": "application/json" });
      response.end(JSON.stringify(route.body));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        await body(port);
        server.close((error) => (error ? reject(error) : resolve()));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function withDirtyTrackedPackageFile(body: () => void) {
  const file = "package.json";
  const before = readFileSync(file, "utf8");
  try {
    appendFileSync(file, "\n");
    body();
  } finally {
    writeFileSync(file, before);
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
  "dist/build-info.json": JSON.stringify({
    commit: "abc123",
    packageName: "@glfruit/openclaw",
    version: "2026.5.7-glfruit.1",
  }),
  "dist/glfruit-release-fresh-build.json": JSON.stringify({
    packageName: "@glfruit/openclaw",
    version: "2026.5.7-glfruit.1",
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
  version: "2026.5.7-glfruit.1",
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

  it("check script rejects plain upstream version for scoped glfruit artifact", () => {
    withTemp((dir) => {
      const tarball = writePackageTarball(
        dir,
        { ...validPackageJson, version: "2026.5.7" },
        {
          ...validFiles,
          "dist/build-info.json": JSON.stringify({
            commit: "abc123",
            packageName: "@glfruit/openclaw",
            version: "2026.5.7",
          }),
          "dist/glfruit-release-fresh-build.json": JSON.stringify({
            packageName: "@glfruit/openclaw",
            version: "2026.5.7",
            commit: "abc123",
            completedAt: "2026-05-13T00:00:00.000Z",
            prepackEquivalent: true,
            commands: ["node --import tsx scripts/openclaw-prepack.ts"],
            runtimeFileEvidence: { "dist/index.js": { sha256: "abc", mtimeMs: 1, size: 1 } },
          }),
        },
      );
      const result = runNode([
        CHECK_SCRIPT,
        tarball,
        "--expected-version",
        "2026.5.7-glfruit.1",
        "--skip-install-resolve",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("version mismatch");
      expect(result.stderr).toContain("glfruit scoped package version must match");
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
          version: "2026.5.7-glfruit.1",
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

  it("check script rejects dirty artifact identity as not release-ready", () => {
    withTemp((dir) => {
      const dirtySource = {
        dirty: true,
        policy: "explicit-local-canary-only",
        hash: "a".repeat(64),
        files: [{ path: "package.json", state: "modified", sha256: "b".repeat(64), size: 1 }],
      };
      const tarball = writePackageTarball(dir, validPackageJson, {
        ...validFiles,
        "dist/build-info.json": JSON.stringify({
          commit: "abc123",
          packageName: "@glfruit/openclaw",
          version: "2026.5.7-glfruit.1",
          dirtySource,
        }),
        "dist/glfruit-release-fresh-build.json": JSON.stringify({
          packageName: "@glfruit/openclaw",
          version: "2026.5.7-glfruit.1",
          commit: "abc123",
          completedAt: "2026-05-13T00:00:00.000Z",
          prepackEquivalent: true,
          commands: ["node --import tsx scripts/openclaw-prepack.ts"],
          runtimeFileEvidence: { "dist/index.js": { sha256: "abc", mtimeMs: 1, size: 1 } },
          dirtySource,
        }),
      });
      const result = runNode([CHECK_SCRIPT, tarball, "--skip-install-resolve"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("dirty artifact identity");
      expect(result.stderr).toContain("cannot be release-ready");
    });
  });

  it("packaging dry-run proves source package.json is unchanged and manifest is scoped", () => {
    withTemp((dir) => {
      const before = readFileSync("package.json", "utf8");
      const result = runNode([
        PACK_SCRIPT,
        "--dry-run",
        "--out-dir",
        dir,
        "--allow-dirty-for-local-canary",
      ]);
      const after = readFileSync("package.json", "utf8");
      expect(result.status, result.stderr).toBe(0);
      const manifest = JSON.parse(result.stdout);
      expect(after).toBe(before);
      expect(manifest.packageName).toBe("@glfruit/openclaw");
      expect(manifest.version).toBe("2026.5.7-glfruit.1");
      expect(manifest.baseVersion).toBe("2026.5.7");
      expect(manifest.packageMetadata.version).toBe("2026.5.7-glfruit.1");
      expect(manifest.sourcePackageJsonUnchanged).toBe(true);
      expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(manifest.buildInfo.packageName).toBe("@glfruit/openclaw");
      expect(manifest.buildInfo.version).toBe("2026.5.7-glfruit.1");
    });
  });

  it("packaging refuses dirty package-relevant tracked source by default", () => {
    withTemp((dir) => {
      withDirtyTrackedPackageFile(() => {
        const result = runNode([PACK_SCRIPT, "--dry-run", "--out-dir", dir]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "refusing to package dirty package-relevant tracked source",
        );
        expect(result.stderr).toContain("--allow-dirty-for-local-canary");
      });
    });
  });

  it("explicit local canary dirty override records non-release artifact identity", () => {
    withTemp((dir) => {
      withDirtyTrackedPackageFile(() => {
        const result = runNode([
          PACK_SCRIPT,
          "--dry-run",
          "--out-dir",
          dir,
          "--allow-dirty-for-local-canary",
        ]);
        expect(result.status, result.stderr).toBe(0);
        const manifest = JSON.parse(result.stdout);
        expect(manifest.dirtySource.dirty).toBe(true);
        expect(manifest.dirtySource.policy).toBe("explicit-local-canary-only");
        expect(manifest.dirtySource.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(manifest.dirtySource.files.map((file: { path: string }) => file.path)).toContain(
          "package.json",
        );
        expect(manifest.buildInfo.dirtySource).toEqual(manifest.dirtySource);
      });
    });
  });

  it("package manifest includes bundled feishu and JSON guard canary artifact", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.files).toContain("dist/");
    expect(pkg.files).not.toContain("!dist/extensions/feishu/**");

    const buildConfig = readFileSync("tsdown.config.ts", "utf8");
    expect(buildConfig).toContain('"agents/json-edit-guard": "src/agents/json-edit-guard.ts"');
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

  it("promote dry-run exposes the expected glfruit version identity", () => {
    withTemp((dir) => {
      const result = runNode([
        PROMOTE_SCRIPT,
        "--dry-run",
        "--out-dir",
        dir,
        "--allow-dirty-for-local-canary",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.verdict).toBe("BLOCKED");
      expect(parsed.steps.pack).toMatchObject({
        packageName: "@glfruit/openclaw",
        version: "2026.5.7-glfruit.1",
        baseVersion: "2026.5.7",
      });
      expect(parsed.steps.pack.packageMetadata.version).toBe("2026.5.7-glfruit.1");
    });
  });

  it("promote refuses live without explicit flags and canary PASS", () => {
    const noConfirm = runNode([PROMOTE_SCRIPT, "--live"]);
    expect(noConfirm.status).not.toBe(0);
    expect(noConfirm.stderr).toContain("--confirm-live");

    withTemp((dir) => {
      const report = join(dir, "canary.json");
      writeFileSync(
        report,
        JSON.stringify({
          verdict: "DRY_RUN",
          canaryGatewayVerdict: "PASS",
          releaseReadinessVerdict: "BLOCKED",
          tarball: "/tmp/fake.tgz",
          sha256: "a",
        }),
      );
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

  it("canary local healthz+readyz probe passes only exact gateway contracts", async () => {
    await withHttpServer(
      {
        "/healthz": { statusCode: 200, body: { ok: true, status: "live" } },
        "/readyz": { statusCode: 200, body: { ready: true } },
      },
      async (port) => {
        const probe = await gatewayLocalHealthzReadyzProbe(port, 1_000);
        expect(probe.status).toBe("PASS");
        expect(probe.probeKind).toBe("gateway-healthz-readyz-local");
        expect(probe.healthz).toMatchObject({ ok: true, statusCode: 200 });
        expect(probe.readyz).toMatchObject({ ready: true, statusCode: 200 });
      },
    );
  });

  it("canary local healthz+readyz probe rejects 4xx and non-gateway healthz bodies", async () => {
    await withHttpServer(
      {
        "/healthz": { statusCode: 404, body: { ok: true, status: "live" } },
        "/readyz": { statusCode: 200, body: { ready: true } },
      },
      async (port) => {
        const probe = await gatewayLocalHealthzReadyzProbe(port, 300);
        expect(probe.status).toBe("FAIL");
        expect(probe.healthz).toMatchObject({ ok: false, statusCode: 404 });
      },
    );

    await withHttpServer(
      {
        "/healthz": { statusCode: 200, body: { ok: true, status: "wrong" } },
        "/readyz": { statusCode: 200, body: { ready: true } },
      },
      async (port) => {
        const probe = await gatewayLocalHealthzReadyzProbe(port, 300);
        expect(probe.status).toBe("FAIL");
        expect(probe.healthz).toMatchObject({ ok: false, statusCode: 200 });
      },
    );
  });

  it("canary local healthz+readyz probe rejects readyz 503 or ready false", async () => {
    await withHttpServer(
      {
        "/healthz": { statusCode: 200, body: { ok: true, status: "live" } },
        "/readyz": { statusCode: 503, body: { ready: false } },
      },
      async (port) => {
        const probe = await gatewayLocalHealthzReadyzProbe(port, 300);
        expect(probe.status).toBe("FAIL");
        expect(probe.readyz).toMatchObject({ ready: false, statusCode: 503 });
      },
    );

    await withHttpServer(
      {
        "/healthz": { statusCode: 200, body: { ok: true, status: "live" } },
        "/readyz": { statusCode: 200, body: { ready: false } },
      },
      async (port) => {
        const probe = await gatewayLocalHealthzReadyzProbe(port, 300);
        expect(probe.status).toBe("FAIL");
        expect(probe.readyz).toMatchObject({ ready: false, statusCode: 200 });
      },
    );
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
      expect(result.status).not.toBe(0);
      expect(result.stdout, result.stderr).toContain("releaseReadinessVerdict");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.isolated.home).toContain("openclaw-glfruit-canary-");
      expect(parsed.isolated.prefix).toContain("prefix");
      expect(parsed.isolated.port).toBeGreaterThan(0);
      expect(parsed.package).toMatchObject({
        name: "@glfruit/openclaw",
        version: "2026.5.7-glfruit.1",
      });
      expect(parsed.artifactIdentity).toMatchObject({
        packageName: "@glfruit/openclaw",
        version: "2026.5.7-glfruit.1",
      });
      expect(parsed.readinessBlockers).not.toContain("artifact-version-missing-glfruit-suffix");
      expect(parsed.pluginRuntimeSmoke.length).toBeGreaterThan(0);
      expect(parsed.jsonGuardSmoke.status).toBe("BLOCKED");
      expect(parsed.canaryGatewayVerdict).toBe("FAIL");
      expect(parsed.releaseReadinessVerdict).toBe("BLOCKED");
      expect(parsed.readinessBlockers).toContain("gateway-not-started");
      expect(parsed.readinessBlockers).toContain("gateway-status-skipped");
    });
  });
});

describe("promote live gate report binding", () => {
  it("rejects stale canary reports for a different tarball or sha256", () => {
    expect(() =>
      assertCanaryMatchesPack(
        {
          tarball: "/tmp/stale.tgz",
          sha256: "a",
          package: { name: "@glfruit/openclaw", version: "2026.5.7-glfruit.1" },
        },
        {
          packageName: "@glfruit/openclaw",
          version: "2026.5.7-glfruit.1",
          tarballPath: "/tmp/selected.tgz",
          sha256: "a",
        },
      ),
    ).toThrow("different tarball");

    expect(() =>
      assertCanaryMatchesPack(
        {
          tarball: "/tmp/selected.tgz",
          sha256: "a",
          package: { name: "@glfruit/openclaw", version: "2026.5.7-glfruit.1" },
        },
        {
          packageName: "@glfruit/openclaw",
          version: "2026.5.7-glfruit.1",
          tarballPath: "/tmp/selected.tgz",
          sha256: "b",
        },
      ),
    ).toThrow("sha256 mismatch");

    expect(() =>
      assertCanaryMatchesPack(
        {
          tarball: "/tmp/selected.tgz",
          sha256: "b",
          package: { name: "@glfruit/openclaw", version: "2026.5.7-glfruit.1" },
        },
        {
          packageName: "@glfruit/openclaw",
          version: "2026.5.7-glfruit.1",
          tarballPath: resolve("/tmp/selected.tgz"),
          sha256: "b",
        },
      ),
    ).not.toThrow();
  });

  it("rejects canary binding when selected or reported versions are not glfruit-local", () => {
    expect(() =>
      assertCanaryMatchesPack(
        {
          tarball: "/tmp/selected.tgz",
          sha256: "a",
          package: { name: "@glfruit/openclaw", version: "2026.5.7-glfruit.1" },
        },
        {
          packageName: "@glfruit/openclaw",
          version: "2026.5.7",
          tarballPath: "/tmp/selected.tgz",
          sha256: "a",
        },
      ),
    ).toThrow("selected pack artifact version must match");

    expect(() =>
      assertCanaryMatchesPack(
        {
          tarball: "/tmp/selected.tgz",
          sha256: "a",
          package: { name: "@glfruit/openclaw", version: "2026.5.7" },
        },
        {
          packageName: "@glfruit/openclaw",
          version: "2026.5.7-glfruit.1",
          tarballPath: "/tmp/selected.tgz",
          sha256: "a",
        },
      ),
    ).toThrow("canary artifact version must match");
  });

  it("does not allow gateway-only or blocked readiness reports to satisfy live promote", () => {
    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "BLOCKED",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "BLOCKED",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
      }),
    ).toThrow("release-ready canary PASS");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "BLOCKED",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
      }),
    ).toThrow("releaseReadinessVerdict PASS");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: { status: "SKIP" },
        gatewayProcessVerdict: "SKIP",
        started: false,
      }),
    ).toThrow("started canary gateway");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: {
          status: "TCP_ONLY",
          statusProbe: {
            probeKind: "gateway-healthz-readyz-local",
            status: "FAIL",
            exitCode: 0,
            rpc: { ok: false, error: "device identity required" },
            health: { healthy: false, error: "device identity required" },
          },
        },
        started: true,
      }),
    ).toThrow("TCP_READYZ_READY canary gateway");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: {
          status: "TCP_HEALTHZ_READY",
          statusProbe: {
            probeKind: "gateway-healthz-local",
            status: "PASS",
            health: { healthy: true },
          },
        },
        started: true,
      }),
    ).toThrow("TCP_READYZ_READY canary gateway");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: { status: "TCP_READYZ_READY" },
        started: true,
      }),
    ).toThrow("gateway status probe");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: {
          status: "TCP_READYZ_READY",
          statusProbe: {
            probeKind: "gateway-healthz-readyz-local",
            status: "FAIL",
            exitCode: 0,
            rpc: { ok: false, error: "device identity required" },
            health: { healthy: false, error: "device identity required" },
          },
        },
        started: true,
      }),
    ).toThrow("PASS canary gateway status probe");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: {
          status: "TCP_READYZ_READY",
          statusProbe: {
            probeKind: "gateway-healthz-readyz-local",
            status: "PASS",
            exitCode: 0,
            rpc: { ok: false, error: "device identity required" },
            health: { healthy: true },
          },
        },
        started: true,
      }),
    ).toThrow("failed canary gateway RPC probe");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: {
          status: "TCP_READYZ_READY",
          statusProbe: {
            probeKind: "gateway-healthz-readyz-local",
            status: "PASS",
            exitCode: 0,
            rpc: { ok: true },
            health: { healthy: false, error: "device identity required" },
          },
        },
        started: true,
      }),
    ).toThrow("exact canary /healthz contract");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: {
          status: "TCP_READYZ_READY",
          statusProbe: {
            probeKind: "gateway-healthz-readyz-local",
            status: "PASS",
            healthz: { ok: true, statusCode: 404, body: { ok: true, status: "live" } },
            readyz: { ready: true, statusCode: 200, body: { ready: true } },
          },
        },
        started: true,
      }),
    ).toThrow("exact canary /healthz contract");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: {
          status: "TCP_READYZ_READY",
          statusProbe: {
            probeKind: "gateway-healthz-readyz-local",
            status: "PASS",
            healthz: { ok: true, statusCode: 200, body: { ok: true, status: "wrong" } },
            readyz: { ready: true, statusCode: 200, body: { ready: true } },
          },
        },
        started: true,
      }),
    ).toThrow("exact canary /healthz contract");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: {
          status: "TCP_READYZ_READY",
          statusProbe: {
            probeKind: "gateway-healthz-readyz-local",
            status: "PASS",
            healthz: { ok: true, statusCode: 200, body: { ok: true, status: "live" } },
            readyz: { ready: false, statusCode: 200, body: { ready: false } },
          },
        },
        started: true,
      }),
    ).toThrow("exact canary /readyz contract");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: {
          status: "TCP_READYZ_READY",
          statusProbe: {
            status: "PASS",
            probeKind: "gateway-healthz-readyz-local",
            rpc: { ok: true },
            health: { healthy: true },
            healthz: { ok: true, statusCode: 200, body: { ok: true, status: "live" } },
            readyz: { ready: true, statusCode: 200, body: { ready: true } },
          },
        },
        started: true,
        readinessBlockers: ["gateway-status-skipped"],
      }),
    ).toThrow("canary readiness blockers");

    expect(() =>
      assertCanaryReportReleaseReady({
        verdict: "PASS",
        canaryGatewayVerdict: "PASS",
        releaseReadinessVerdict: "PASS",
        tarball: "/tmp/selected.tgz",
        sha256: "b",
        gateway: {
          status: "TCP_READYZ_READY",
          statusProbe: {
            status: "PASS",
            probeKind: "gateway-healthz-readyz-local",
            rpc: { ok: true },
            health: { healthy: true },
            healthz: { ok: true, statusCode: 200, body: { ok: true, status: "live" } },
            readyz: { ready: true, statusCode: 200, body: { ready: true } },
          },
        },
        started: true,
        artifactIdentity: { dirtySource: { dirty: true } },
      }),
    ).toThrow("dirty artifact identity");
  });
});
