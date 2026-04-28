import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectPreparedPrepackErrors,
  prunePrepackBundledExtensionNodeModules,
  runPrepack,
} from "../scripts/openclaw-prepack.ts";

describe("collectPreparedPrepackErrors", () => {
  it("accepts prepared release artifacts", () => {
    expect(
      collectPreparedPrepackErrors(
        ["dist/index.mjs", "dist/control-ui/index.html"],
        ["dist/control-ui/assets/index-Bu8rSoJV.js"],
      ),
    ).toEqual([]);
  });

  it("reports missing build and control ui artifacts", () => {
    expect(collectPreparedPrepackErrors([], [])).toEqual([
      "missing required prepared artifact: dist/index.js or dist/index.mjs",
      "missing required prepared artifact: dist/control-ui/index.html",
      "missing prepared Control UI asset payload under dist/control-ui/assets/",
    ]);
  });
});

describe("runPrepack", () => {
  it("runs final prune after smoke and writes inventory from the pruned package tree", async () => {
    const calls: string[] = [];

    await runPrepack({
      pnpmCommand: "pnpm-test",
      run: (command, args) => calls.push(`run:${command} ${args.join(" ")}`),
      ensurePreparedArtifacts: () => calls.push("ensure-prepared-artifacts"),
      prunePrepackBundledExtensionNodeModules: () => {
        calls.push("prune-dist-extension-node-modules");
        return ["dist/extensions/discord/node_modules"];
      },
      writeDistInventory: async () => {
        calls.push("write-dist-inventory");
      },
      runBuildSmoke: () => calls.push("built-channel-smoke"),
      logger: { error: (message) => calls.push(`log:${message}`) },
    });

    expect(calls).toEqual([
      "run:pnpm-test build",
      "run:pnpm-test ui:build",
      "ensure-prepared-artifacts",
      "built-channel-smoke",
      "prune-dist-extension-node-modules",
      "log:prepack: pruned bundled extension node_modules: 1",
      "write-dist-inventory",
    ]);
    expect(calls.indexOf("built-channel-smoke")).toBeLessThan(
      calls.indexOf("prune-dist-extension-node-modules"),
    );
    expect(calls.indexOf("prune-dist-extension-node-modules")).toBeLessThan(
      calls.indexOf("write-dist-inventory"),
    );
  });
});

describe("prunePrepackBundledExtensionNodeModules", () => {
  function createTempPackageRoot(): string {
    return mkdtempSync(path.join(tmpdir(), "openclaw-prepack-cleanup-"));
  }

  it("removes bundled dist extension node_modules before pack file walking", () => {
    const packageRoot = createTempPackageRoot();
    try {
      mkdirSync(path.join(packageRoot, "dist", "extensions", "discord", "node_modules", "zod"), {
        recursive: true,
      });
      mkdirSync(path.join(packageRoot, "dist", "extensions", "telegram", "node_modules"), {
        recursive: true,
      });
      mkdirSync(path.join(packageRoot, "dist", "extensions", "node_modules", "openclaw"), {
        recursive: true,
      });
      writeFileSync(
        path.join(packageRoot, "dist", "extensions", "discord", "package.json"),
        "{}\n",
      );

      expect(prunePrepackBundledExtensionNodeModules(packageRoot)).toEqual([
        "dist/extensions/discord/node_modules",
        "dist/extensions/node_modules",
        "dist/extensions/telegram/node_modules",
      ]);

      expect(
        existsSync(path.join(packageRoot, "dist", "extensions", "discord", "node_modules")),
      ).toBe(false);
      expect(
        existsSync(path.join(packageRoot, "dist", "extensions", "telegram", "node_modules")),
      ).toBe(false);
      expect(existsSync(path.join(packageRoot, "dist", "extensions", "node_modules"))).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("skips symlinked extension entries", () => {
    const packageRoot = createTempPackageRoot();
    const targetRoot = createTempPackageRoot();
    try {
      mkdirSync(path.join(packageRoot, "dist", "extensions"), { recursive: true });
      mkdirSync(path.join(targetRoot, "node_modules", "dep"), { recursive: true });
      symlinkSync(targetRoot, path.join(packageRoot, "dist", "extensions", "linked"), "dir");

      expect(prunePrepackBundledExtensionNodeModules(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });
});
