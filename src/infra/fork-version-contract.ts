/**
 * Fork release version contract — single source of truth.
 *
 * Mapping rule:
 *   release_tag      = "v<version>"           (e.g. v2026.4.21)
 *   package.json     = "<version>"             (e.g. 2026.4.21)
 *   tarball filename = "<name>-<version>.tgz"  (e.g. openclaw-2026.4.21.tgz)
 *   GH asset name    = tarball filename
 *
 * This module is imported by both `fork_build_release.py` (via shared logic)
 * and the TS update authority/path to ensure the updater resolution will
 * request exactly the tarball name that the build pipeline produces.
 */

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSemver(value: string): boolean {
  return SEMVER_RE.test(value);
}

export function stripVPrefix(value: string): string {
  return value.startsWith("v") ? value.slice(1) : value;
}

export function normalizeReleaseTag(tag: string): string | null {
  const version = stripVPrefix(tag);
  return isValidSemver(version) ? deriveTagFromVersion(version) : null;
}

export function deriveVersionFromTag(tag: string): string | null {
  const normalizedTag = normalizeReleaseTag(tag);
  if (!normalizedTag) {
    return null;
  }
  const version = stripVPrefix(normalizedTag);
  return isValidSemver(version) ? version : null;
}

export function deriveTagFromVersion(version: string): string {
  return `v${version}`;
}

export function deriveTarballName(name: string, version: string): string {
  return `${name}-${version}.tgz`;
}

export type VersionContract = {
  releaseTag: string;
  packageVersion: string;
  tarballFilename: string;
  githubAssetName: string;
};

export type VersionContractError = {
  errors: string[];
};

export type VersionContractResult =
  | { ok: true; contract: VersionContract }
  | { ok: false; errors: string[] };

/**
 * Resolve and validate the version contract from the given inputs.
 *
 * Precedence for determining the effective version:
 *   1. `versionOverride` (if provided and valid semver)
 *   2. `packageVersion` (from package.json, if valid semver)
 *   3. Version derived from `releaseTag` (if provided)
 *
 * The release tag, if provided, must match the effective version.
 */
export function resolveVersionContract(params: {
  releaseTag?: string | null;
  packageVersion?: string | null;
  versionOverride?: string | null;
  packageName?: string | null;
}): VersionContractResult {
  const errors: string[] = [];
  const { releaseTag, packageVersion, versionOverride, packageName } = params;

  const effectiveVersion = versionOverride ?? packageVersion ?? null;
  const effectiveTag = releaseTag ? normalizeReleaseTag(releaseTag) : null;

  // Reject explicit release tags that don't normalize (e.g. "not-a-tag")
  if (releaseTag && !effectiveTag) {
    errors.push(`release tag is not a valid semver tag: ${releaseTag}`);
  }

  // Validate both if both are present
  if (effectiveTag && effectiveVersion) {
    const tagVersion = deriveVersionFromTag(effectiveTag);
    if (!tagVersion) {
      errors.push(`release tag is not a valid semver tag: ${releaseTag}`);
    } else if (tagVersion !== effectiveVersion) {
      errors.push(
        `version contract mismatch: release tag implies ${tagVersion} but effective version is ${effectiveVersion}`,
      );
    }
  }

  if (effectiveVersion && !isValidSemver(effectiveVersion)) {
    errors.push(`effective version is not valid semver: ${effectiveVersion}`);
  }

  if (!effectiveVersion && !effectiveTag) {
    errors.push(
      "cannot determine release version: supply releaseTag, versionOverride, or packageVersion",
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Derive missing pieces
  const version = effectiveVersion ?? deriveVersionFromTag(effectiveTag!)!;
  const tag = effectiveTag ?? deriveTagFromVersion(version);
  const tarballFilename = deriveTarballName(packageName ?? "openclaw", version);

  return {
    ok: true,
    contract: {
      releaseTag: tag,
      packageVersion: version,
      tarballFilename,
      githubAssetName: tarballFilename,
    },
  };
}

/**
 * Check whether an actual tarball filename matches the expected contract.
 */
export function tarballMatchesContract(actualFilename: string, contract: VersionContract): boolean {
  return actualFilename === contract.tarballFilename;
}
