import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deriveTagFromVersion, deriveTarballName, stripVPrefix } from "./fork-version-contract.js";
import { parseSemver } from "./runtime-guard.js";

export type UpdateReleaseSource = "upstream" | "fork";

export type ResolvedUpdateAuthority = {
  repoUrl: string;
  releaseSource: UpdateReleaseSource;
  githubOwner: string | null;
  githubRepo: string | null;
  githubSlug: string | null;
};

const DEFAULT_OPENCLAW_REPO_URL = "https://github.com/openclaw/openclaw.git";

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeReleaseSource(value: string | null | undefined): UpdateReleaseSource {
  return value === "fork" ? "fork" : "upstream";
}

function resolveUpdateAuthorityConfig(
  config?: OpenClawConfig | null,
): OpenClawConfig["update"] | null {
  return config?.update ?? null;
}

function parseGithubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const trimmed = repoUrl.trim();
  if (!trimmed) {
    return null;
  }

  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match) {
      return {
        owner: match[1] ?? "",
        repo: match[2] ?? "",
      };
    }
  }

  return null;
}

export function normalizeReleaseVersionTarget(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = stripVPrefix(trimmed);
  return parseSemver(cleaned) ? cleaned : null;
}

export function resolveUpdateAuthority(params?: {
  env?: NodeJS.ProcessEnv;
  config?: OpenClawConfig | null;
}): ResolvedUpdateAuthority {
  const env = params?.env ?? process.env;
  const update = resolveUpdateAuthorityConfig(params?.config);
  const repoUrl =
    trimOrNull(env.OPENCLAW_UPDATE_REPO_URL) ??
    trimOrNull(process.env.OPENCLAW_UPDATE_REPO_URL) ??
    trimOrNull(update?.authority?.repoUrl) ??
    DEFAULT_OPENCLAW_REPO_URL;
  const releaseSource = normalizeReleaseSource(
    trimOrNull(env.OPENCLAW_UPDATE_RELEASE_SOURCE) ??
      trimOrNull(process.env.OPENCLAW_UPDATE_RELEASE_SOURCE) ??
      trimOrNull(update?.authority?.releaseSource),
  );
  const githubRepo = parseGithubRepo(repoUrl);
  return {
    repoUrl,
    releaseSource,
    githubOwner: githubRepo?.owner ?? null,
    githubRepo: githubRepo?.repo ?? null,
    githubSlug: githubRepo ? `${githubRepo.owner}/${githubRepo.repo}` : null,
  };
}

export function buildForkReleaseAssetUrl(params: {
  authority: ResolvedUpdateAuthority;
  packageName: string;
  version: string;
}): string {
  if (params.authority.releaseSource !== "fork") {
    throw new Error("fork release asset URL requested for non-fork authority");
  }
  if (!params.authority.githubSlug) {
    throw new Error(
      `Fork update authority requires a GitHub repo URL (got ${params.authority.repoUrl}).`,
    );
  }
  const packageName = params.packageName.trim();
  const version = normalizeReleaseVersionTarget(params.version);
  if (!packageName || !version) {
    throw new Error(
      `Fork release installs require an exact version tag (got ${params.version.trim() || "<empty>"}).`,
    );
  }
  const releaseTag = deriveTagFromVersion(version);
  const tarballFilename = deriveTarballName(packageName, version);
  return `https://github.com/${params.authority.githubSlug}/releases/download/${releaseTag}/${tarballFilename}`;
}
