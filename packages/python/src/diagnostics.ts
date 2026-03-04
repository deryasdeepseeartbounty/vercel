import fs from 'fs';
import { join, dirname } from 'path';
import {
  FileBlob,
  debug,
  type BuildOptions,
  type Files,
} from '@vercel/build-utils';
import {
  parseUvLock,
  normalizePackageName,
  parsePep508,
  type PythonPackage,
  type UvLockPackageSource,
} from '@vercel/python-analysis';
import type { PythonVersion } from './version';
import { pythonVersionString } from './version';

export const MANIFEST_FILENAME = 'package-manifest.json';

export const DIAGNOSTICS_PATH = join('.vercel', 'python', MANIFEST_FILENAME);

interface DependencyEntry {
  name: string;
  type: 'direct' | 'transitive';
  scopes: string[];
  requested?: string;
  resolved?: string;
  source?: string;
  sourceUrl?: string;
}

const MANIFEST_VERSION = '20260304';

interface ProjectManifest {
  version: string;
  runtime: string;
  runtimeVersion: {
    requested?: string;
    requestedSource?: string;
    resolved: string;
  };
  dependencies: DependencyEntry[];
}

function mapSource(src: UvLockPackageSource | undefined): {
  source?: string;
  sourceUrl?: string;
} {
  if (!src) return {};
  if (src.virtual) return {};
  if (src.registry) {
    try {
      const url = new URL(src.registry);
      return { source: 'registry', sourceUrl: url.origin };
    } catch {
      return { source: 'registry', sourceUrl: src.registry };
    }
  }
  if (src.git) return { source: 'git', sourceUrl: src.git };
  if (src.url) return { source: 'url', sourceUrl: src.url };
  if (src.editable) return { source: 'editable', sourceUrl: src.editable };
  if (src.path) return { source: 'path', sourceUrl: src.path };
  return {};
}

/**
 * Generate and write the project manifest to `.vercel/python/package-manifest.json`.
 * Called during build() so data is collected while it's already available.
 */
export async function generateProjectManifest({
  workPath,
  pythonPackage,
  pythonVersion,
  uvLockPath,
}: {
  workPath: string;
  pythonPackage: PythonPackage;
  pythonVersion: PythonVersion;
  uvLockPath: string;
}): Promise<void> {
  const resolved = pythonVersionString(pythonVersion);
  const constraint = pythonPackage.requiresPython?.[0];
  const requested = constraint?.specifier;

  const project = pythonPackage.manifest?.data?.project;
  const pyprojectData = pythonPackage.manifest?.data;

  // Track direct dependency names and their scopes.
  // A package can appear in multiple groups, so we collect all scopes.
  const directScopesMap = new Map<string, Set<string>>();
  const directRequested = new Map<string, string>();

  function addDirectDeps(deps: string[], scope: string) {
    for (const dep of deps) {
      const parsed = parsePep508(dep);
      if (!parsed) continue;
      const normalized = normalizePackageName(parsed.name);
      let scopes = directScopesMap.get(normalized);
      if (!scopes) {
        scopes = new Set();
        directScopesMap.set(normalized, scopes);
      }
      scopes.add(scope);
      // Keep the first requested string we see for this package
      if (!directRequested.has(normalized)) {
        directRequested.set(normalized, dep);
      }
    }
  }

  // 1. project.dependencies → scope "main"
  if (project?.dependencies && Array.isArray(project.dependencies)) {
    addDirectDeps(project.dependencies, 'main');
  }

  // 2. project.optional-dependencies → scope = group key
  const optDeps = project?.['optional-dependencies'];
  if (optDeps) {
    for (const [group, deps] of Object.entries(optDeps)) {
      if (Array.isArray(deps)) {
        addDirectDeps(deps, group);
      }
    }
  }

  // 3. dependency-groups → scope = group key
  const depGroups = pyprojectData?.['dependency-groups'];
  if (depGroups) {
    for (const [group, deps] of Object.entries(depGroups)) {
      if (Array.isArray(deps)) {
        addDirectDeps(deps, group);
      }
    }
  }

  // Resolve versions and source info from the lock file
  const directEntries: DependencyEntry[] = [];
  const transitiveEntries: DependencyEntry[] = [];

  {
    const content = fs.readFileSync(uvLockPath, 'utf-8');
    const uvLock = parseUvLock(content, uvLockPath);
    const projectName = project?.name;
    const excludeSet = new Set(
      projectName ? [normalizePackageName(projectName)] : []
    );

    // Build maps from the lock file
    const lockMap = new Map<
      string,
      { version: string; source?: UvLockPackageSource }
    >();
    // Forward dependency graph: package → set of packages it depends on
    const depGraph = new Map<string, Set<string>>();

    for (const pkg of uvLock.packages) {
      const normalized = normalizePackageName(pkg.name);
      if (excludeSet.has(normalized)) {
        // Still record edges from the project package to propagate scopes
        if (pkg.dependencies) {
          const deps = new Set<string>();
          for (const d of pkg.dependencies) {
            deps.add(normalizePackageName(d.name));
          }
          depGraph.set(normalized, deps);
        }
        continue;
      }
      if (pkg.source?.virtual) continue;
      lockMap.set(normalized, { version: pkg.version, source: pkg.source });
      if (pkg.dependencies) {
        const deps = new Set<string>();
        for (const d of pkg.dependencies) {
          deps.add(normalizePackageName(d.name));
        }
        depGraph.set(normalized, deps);
      }
    }

    // Propagate scopes from direct deps through the dependency graph.
    // BFS from each direct dep: every reachable transitive package
    // inherits the scopes of the direct dep.
    const transitiveScopesMap = new Map<string, Set<string>>();

    for (const [name, scopes] of directScopesMap) {
      const queue = [name];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        const children = depGraph.get(current);
        if (!children) continue;
        for (const child of children) {
          if (excludeSet.has(child)) continue;
          if (!directScopesMap.has(child)) {
            let childScopes = transitiveScopesMap.get(child);
            if (!childScopes) {
              childScopes = new Set();
              transitiveScopesMap.set(child, childScopes);
            }
            for (const s of scopes) {
              childScopes.add(s);
            }
          }
          if (!visited.has(child)) {
            queue.push(child);
          }
        }
      }
    }

    // Build direct entries
    for (const [name, scopes] of directScopesMap) {
      const info = lockMap.get(name);
      const entry: DependencyEntry = {
        name,
        type: 'direct',
        scopes: [...scopes].sort(),
        requested: directRequested.get(name),
      };
      if (info) {
        entry.resolved = info.version;
        const src = mapSource(info.source);
        if (src.source) entry.source = src.source;
        if (src.sourceUrl) entry.sourceUrl = src.sourceUrl;
      }
      directEntries.push(entry);
    }

    // Build transitive entries
    for (const [normalized, info] of lockMap) {
      if (directScopesMap.has(normalized)) continue;
      const scopes = transitiveScopesMap.get(normalized);
      const src = mapSource(info.source);
      transitiveEntries.push({
        name: normalized,
        type: 'transitive',
        scopes: scopes ? [...scopes].sort() : [],
        resolved: info.version,
        ...(src.source ? { source: src.source } : {}),
        ...(src.sourceUrl ? { sourceUrl: src.sourceUrl } : {}),
      });
    }
  }

  const manifest: ProjectManifest = {
    version: MANIFEST_VERSION,
    runtime: 'python',
    runtimeVersion: {
      ...(requested ? { requested } : {}),
      ...(constraint?.source ? { requestedSource: constraint.source } : {}),
      resolved,
    },
    dependencies: [...directEntries, ...transitiveEntries],
  };

  const outPath = join(workPath, DIAGNOSTICS_PATH);
  await fs.promises.mkdir(dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, JSON.stringify(manifest, null, 2));
}

/**
 * Diagnostics callback — returns the project manifest cached during build().
 */
export const diagnostics = async ({
  workPath,
}: BuildOptions): Promise<Files> => {
  try {
    const manifestPath = join(workPath, DIAGNOSTICS_PATH);
    const data = await fs.promises.readFile(manifestPath, 'utf-8');
    return {
      [MANIFEST_FILENAME]: new FileBlob({ data }),
    };
  } catch (err) {
    debug(
      `Diagnostics: no cached manifest found: ${err instanceof Error ? err.message : String(err)}`
    );
    return {};
  }
};
