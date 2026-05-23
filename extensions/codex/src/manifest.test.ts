import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MANAGED_CODEX_APP_SERVER_PACKAGE,
  MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION,
} from "./app-server/version.js";

type CodexPackageManifest = {
  dependencies?: Record<string, string>;
};

describe("codex package manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as CodexPackageManifest;

    expect(packageJson.dependencies).toHaveProperty("@earendil-works/pi-coding-agent");
    expect(packageJson.dependencies?.[MANAGED_CODEX_APP_SERVER_PACKAGE]).toBe(
      MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION,
    );
  });

  it("keeps the managed Codex CLI dependency in the root package manifest", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as CodexPackageManifest;

    expect(packageJson.dependencies?.[MANAGED_CODEX_APP_SERVER_PACKAGE]).toBe(
      MANAGED_CODEX_APP_SERVER_PACKAGE_VERSION,
    );
  });
});
