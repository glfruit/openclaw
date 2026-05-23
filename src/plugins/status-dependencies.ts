import fs from "node:fs";
import path from "node:path";

export type PluginDependencySpecMap = Record<string, string>;

export type PluginDependencyEntry = {
  name: string;
  spec: string;
  installed: boolean;
  optional: boolean;
  resolvedPath?: string;
  installedVersion?: string;
  versionMismatch?: boolean;
};

export type PluginDependencyStatus = {
  hasDependencies: boolean;
  installed: boolean;
  requiredInstalled: boolean;
  optionalInstalled: boolean;
  missing: string[];
  missingOptional: string[];
  versionMismatches: string[];
  versionMismatchesOptional: string[];
  dependencies: PluginDependencyEntry[];
  optionalDependencies: PluginDependencyEntry[];
};

function normalizeDependencyMap(raw: unknown): PluginDependencySpecMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized: PluginDependencySpecMap = {};
  for (const [name, spec] of Object.entries(raw)) {
    const normalizedName = name.trim();
    if (!normalizedName || typeof spec !== "string" || !spec.trim()) {
      continue;
    }
    normalized[normalizedName] = spec.trim();
  }
  return normalized;
}

export function normalizePluginDependencySpecs(params: {
  dependencies?: unknown;
  optionalDependencies?: unknown;
}): {
  dependencies: PluginDependencySpecMap;
  optionalDependencies: PluginDependencySpecMap;
} {
  return {
    dependencies: normalizeDependencyMap(params.dependencies),
    optionalDependencies: normalizeDependencyMap(params.optionalDependencies),
  };
}

function dependencyPathSegments(name: string): string[] | null {
  const segments = name.split("/");
  if (segments.length === 1 && segments[0]) {
    return [segments[0]];
  }
  if (segments.length === 2 && segments[0]?.startsWith("@") && segments[1]) {
    return segments;
  }
  return null;
}

function findDependencyPackageDir(params: { fromDir: string; name: string }): string | undefined {
  const segments = dependencyPathSegments(params.name);
  if (!segments) {
    return undefined;
  }
  let current = path.resolve(params.fromDir);
  while (true) {
    const candidate = path.join(current, "node_modules", ...segments);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function readInstalledPackageVersion(packageDir: string | undefined): string | undefined {
  if (!packageDir) {
    return undefined;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof payload.version === "string" && payload.version.trim()
      ? payload.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function isExactVersionSpec(spec: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(spec);
}

function buildDependencyEntries(params: {
  rootDir: string | undefined;
  dependencies: PluginDependencySpecMap;
  optional: boolean;
}): PluginDependencyEntry[] {
  return Object.entries(params.dependencies)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => {
      const resolvedPath = params.rootDir
        ? findDependencyPackageDir({ fromDir: params.rootDir, name })
        : undefined;
      const installedVersion = readInstalledPackageVersion(resolvedPath);
      const versionMismatch =
        resolvedPath !== undefined &&
        installedVersion !== undefined &&
        isExactVersionSpec(spec) &&
        installedVersion !== spec;
      const entry: PluginDependencyEntry = {
        name,
        spec,
        installed: resolvedPath !== undefined && !versionMismatch,
        optional: params.optional,
      };
      if (resolvedPath) {
        entry.resolvedPath = resolvedPath;
      }
      if (installedVersion) {
        entry.installedVersion = installedVersion;
      }
      if (versionMismatch) {
        entry.versionMismatch = true;
      }
      return entry;
    });
}

export function buildPluginDependencyStatus(params: {
  rootDir?: string;
  dependencies?: PluginDependencySpecMap;
  optionalDependencies?: PluginDependencySpecMap;
}): PluginDependencyStatus {
  const dependencies = buildDependencyEntries({
    rootDir: params.rootDir,
    dependencies: params.dependencies ?? {},
    optional: false,
  });
  const optionalDependencies = buildDependencyEntries({
    rootDir: params.rootDir,
    dependencies: params.optionalDependencies ?? {},
    optional: true,
  });
  const missing = dependencies.filter((entry) => !entry.installed).map((entry) => entry.name);
  const missingOptional = optionalDependencies
    .filter((entry) => !entry.installed)
    .map((entry) => entry.name);
  const versionMismatches = dependencies
    .filter((entry) => entry.versionMismatch)
    .map((entry) => entry.name);
  const versionMismatchesOptional = optionalDependencies
    .filter((entry) => entry.versionMismatch)
    .map((entry) => entry.name);
  const requiredInstalled = missing.length === 0;
  const optionalInstalled = missingOptional.length === 0;
  return {
    hasDependencies: dependencies.length > 0 || optionalDependencies.length > 0,
    installed: requiredInstalled,
    requiredInstalled,
    optionalInstalled,
    missing,
    missingOptional,
    versionMismatches,
    versionMismatchesOptional,
    dependencies,
    optionalDependencies,
  };
}
