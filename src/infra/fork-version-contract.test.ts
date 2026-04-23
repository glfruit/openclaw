import { describe, expect, it } from "vitest";
import {
  isValidSemver,
  stripVPrefix,
  deriveVersionFromTag,
  deriveTagFromVersion,
  normalizeReleaseTag,
  deriveTarballName,
  resolveVersionContract,
  tarballMatchesContract,
} from "./fork-version-contract.js";

describe("fork-version-contract", () => {
  describe("isValidSemver", () => {
    it("accepts standard semver", () => {
      expect(isValidSemver("2026.4.21")).toBe(true);
      expect(isValidSemver("1.0.0")).toBe(true);
      expect(isValidSemver("0.0.1")).toBe(true);
    });

    it("accepts semver with pre-release", () => {
      expect(isValidSemver("2026.4.21-beta.1")).toBe(true);
      expect(isValidSemver("1.0.0-alpha")).toBe(true);
    });

    it("accepts semver with build metadata", () => {
      expect(isValidSemver("1.0.0+build.123")).toBe(true);
    });

    it("rejects non-semver", () => {
      expect(isValidSemver("v2026.4.21")).toBe(false);
      expect(isValidSemver("latest")).toBe(false);
      expect(isValidSemver("")).toBe(false);
      expect(isValidSemver("2026.4")).toBe(false);
    });
  });

  describe("stripVPrefix", () => {
    it("strips v prefix", () => {
      expect(stripVPrefix("v2026.4.21")).toBe("2026.4.21");
    });

    it("passes through without prefix", () => {
      expect(stripVPrefix("2026.4.21")).toBe("2026.4.21");
    });
  });

  describe("deriveVersionFromTag", () => {
    it("derives version from v-prefixed tag", () => {
      expect(deriveVersionFromTag("v2026.4.21")).toBe("2026.4.21");
    });

    it("derives version from bare semver tag by normalizing to v-prefixed form", () => {
      expect(deriveVersionFromTag("2026.4.21")).toBe("2026.4.21");
    });

    it("returns null for invalid tag", () => {
      expect(deriveVersionFromTag("latest")).toBeNull();
      expect(deriveVersionFromTag("")).toBeNull();
    });
  });

  describe("deriveTagFromVersion", () => {
    it("adds v prefix", () => {
      expect(deriveTagFromVersion("2026.4.21")).toBe("v2026.4.21");
    });
  });

  describe("normalizeReleaseTag", () => {
    it("canonicalizes bare semver tags to v-prefixed tags", () => {
      expect(normalizeReleaseTag("2026.4.21")).toBe("v2026.4.21");
    });

    it("preserves already canonical v-prefixed tags", () => {
      expect(normalizeReleaseTag("v2026.4.21")).toBe("v2026.4.21");
    });
  });

  describe("deriveTarballName", () => {
    it("produces correct tarball filename", () => {
      expect(deriveTarballName("openclaw", "2026.4.21")).toBe("openclaw-2026.4.21.tgz");
    });
  });

  describe("resolveVersionContract", () => {
    it("derives all fields from version override alone", () => {
      const result = resolveVersionContract({
        versionOverride: "2026.4.21",
        packageName: "openclaw",
      });
      if (!result.ok) {
        throw new Error(result.errors.join(", "));
      }
      expect(result.contract).toEqual({
        releaseTag: "v2026.4.21",
        packageVersion: "2026.4.21",
        tarballFilename: "openclaw-2026.4.21.tgz",
        githubAssetName: "openclaw-2026.4.21.tgz",
      });
    });

    it("derives all fields from release tag alone", () => {
      const result = resolveVersionContract({
        releaseTag: "v2026.4.21",
        packageName: "openclaw",
      });
      if (!result.ok) {
        throw new Error(result.errors.join(", "));
      }
      expect(result.contract).toEqual({
        releaseTag: "v2026.4.21",
        packageVersion: "2026.4.21",
        tarballFilename: "openclaw-2026.4.21.tgz",
        githubAssetName: "openclaw-2026.4.21.tgz",
      });
    });

    it("derives all fields from package version alone", () => {
      const result = resolveVersionContract({
        packageVersion: "2026.4.21",
        packageName: "openclaw",
      });
      if (!result.ok) {
        throw new Error(result.errors.join(", "));
      }
      expect(result.contract).toEqual({
        releaseTag: "v2026.4.21",
        packageVersion: "2026.4.21",
        tarballFilename: "openclaw-2026.4.21.tgz",
        githubAssetName: "openclaw-2026.4.21.tgz",
      });
    });

    it("accepts matching tag + version override", () => {
      const result = resolveVersionContract({
        releaseTag: "v2026.4.21",
        versionOverride: "2026.4.21",
        packageName: "openclaw",
      });
      if (!result.ok) {
        throw new Error(result.errors.join(", "));
      }
      expect(result.contract.releaseTag).toBe("v2026.4.21");
    });

    it("normalizes bare semver release tags to canonical v-prefixed tags", () => {
      const result = resolveVersionContract({
        releaseTag: "2026.4.21",
        versionOverride: "2026.4.21",
        packageName: "openclaw",
      });
      if (!result.ok) {
        throw new Error(result.errors.join(", "));
      }
      expect(result.contract.releaseTag).toBe("v2026.4.21");
      expect(result.contract.packageVersion).toBe("2026.4.21");
    });

    it("rejects mismatched tag + version override", () => {
      const result = resolveVersionContract({
        releaseTag: "v2026.4.22",
        versionOverride: "2026.4.21",
        packageName: "openclaw",
      });
      if (result.ok) {
        throw new Error("expected failure");
      }
      expect(result.errors).toContain(
        "version contract mismatch: release tag implies 2026.4.22 but effective version is 2026.4.21",
      );
    });

    it("version override takes precedence over package version", () => {
      const result = resolveVersionContract({
        packageVersion: "2026.4.15-beta.1",
        versionOverride: "2026.4.21",
        releaseTag: "v2026.4.21",
        packageName: "openclaw",
      });
      if (!result.ok) {
        throw new Error(result.errors.join(", "));
      }
      expect(result.contract.packageVersion).toBe("2026.4.21");
      expect(result.contract.tarballFilename).toBe("openclaw-2026.4.21.tgz");
    });

    it("rejects when no version source is available", () => {
      const result = resolveVersionContract({
        packageName: "openclaw",
      });
      if (result.ok) {
        throw new Error("expected failure");
      }
      expect(result.errors).toContain(
        "cannot determine release version: supply releaseTag, versionOverride, or packageVersion",
      );
    });

    it("rejects invalid semver in version override", () => {
      const result = resolveVersionContract({
        versionOverride: "latest",
        packageName: "openclaw",
      });
      if (result.ok) {
        throw new Error("expected failure");
      }
      expect(result.errors).toContain("effective version is not valid semver: latest");
    });

    it("rejects invalid release tag", () => {
      const result = resolveVersionContract({
        releaseTag: "not-a-tag",
        versionOverride: "2026.4.21",
        packageName: "openclaw",
      });
      if (result.ok) {
        throw new Error("expected failure");
      }
      expect(result.errors).toContain("release tag is not a valid semver tag: not-a-tag");
    });
  });

  describe("tarballMatchesContract", () => {
    it("returns true when names match", () => {
      const result = resolveVersionContract({
        versionOverride: "2026.4.21",
        packageName: "openclaw",
      });
      if (!result.ok) {
        throw new Error(result.errors.join(", "));
      }
      expect(tarballMatchesContract("openclaw-2026.4.21.tgz", result.contract)).toBe(true);
    });

    it("returns false when names differ", () => {
      const result = resolveVersionContract({
        versionOverride: "2026.4.21",
        packageName: "openclaw",
      });
      if (!result.ok) {
        throw new Error(result.errors.join(", "));
      }
      expect(tarballMatchesContract("openclaw-2026.4.15-beta.1.tgz", result.contract)).toBe(false);
    });
  });

  describe("round-trip with buildForkReleaseAssetUrl", () => {
    it("contract tarball name matches the URL that the updater will request", async () => {
      // Import the TS updater path to verify contract alignment
      const { buildForkReleaseAssetUrl, resolveUpdateAuthority } =
        await import("./update-authority.js");

      const authority = resolveUpdateAuthority({
        config: {
          update: {
            authority: {
              repoUrl: "https://github.com/example/openclaw.git",
              releaseSource: "fork",
            },
          },
        },
      });

      const version = "2026.4.21";
      const contract = resolveVersionContract({
        versionOverride: version,
        packageName: "openclaw",
      });
      if (!contract.ok) {
        throw new Error(contract.errors.join(", "));
      }

      // The updater constructs: .../v{version}/{name}-{version}.tgz
      const assetUrl = buildForkReleaseAssetUrl({
        authority,
        packageName: "openclaw",
        version,
      });

      // The contract tarball name should appear in the URL
      expect(assetUrl).toContain(`v${version}`);
      expect(assetUrl).toContain(contract.contract.tarballFilename);
      expect(assetUrl).toMatch(/\/releases\/download\/v2026\.4\.21\/openclaw-2026\.4\.21\.tgz$/);
    });
  });
});
