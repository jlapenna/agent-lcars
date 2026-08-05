/**
 * ESLint rule: forbid value imports of server-only modules in `'use client'`
 * files.
 *
 * Next.js's `server-only` marker remains the authoritative, transitive build
 * guard. This rule is the cheaper editor-time layer for direct imports. It
 * uses Nx's cached, resolved project metadata when that cache is available.
 * During project inference (or in an editor without a warm Nx cache), it
 * deliberately does not construct a project graph: a layout-agnostic walk of
 * project.json/package.json/tsconfig.json roots supplies the synchronous
 * fallback instead. That avoids an ESLint -> Nx project inference -> ESLint
 * cycle while still covering nested, package-based, inferred, and app
 * projects.
 *
 * Type-only imports are erased before bundling and remain allowed. A mixed or
 * server package's browser/client/schema/UI entry point is allowed only when a
 * tsconfig path explicitly resolves it and the target itself has no server
 * marker. Broken workspace aliases fail closed with a configuration diagnostic
 * rather than silently becoming browser-safe.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  parseJson,
  readCachedProjectGraph,
  workspaceRoot as nxWorkspaceRoot,
} from '@nx/devkit';
import type { TSESTree } from '@typescript-eslint/utils';
import { ESLintUtils } from '@typescript-eslint/utils';

const DEFAULT_WORKSPACE_ROOT = nxWorkspaceRoot;

const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];
const SAFE_SUBPATHS = new Set(['browser', 'client', 'schema', 'ui']);
const IGNORED_DISCOVERY_DIRECTORIES = new Set([
  'coverage',
  'dist',
  'node_modules',
  'tmp',
]);

interface JsonProjectConfiguration {
  name?: string;
  root?: string;
  sourceRoot?: string;
  tags?: string[];
}

interface PackageJson {
  name?: string;
  nx?: {
    tags?: string[];
  };
}

interface Tsconfig {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, unknown>;
  };
}

interface ProjectBoundary {
  name?: string;
  root: string;
  sourceRoot: string;
  tags: Set<string>;
}

interface PathMapping {
  alias: string;
  baseDirectory: string;
  configPath: string;
  scopeRoot: string;
  targets: string[];
}

interface ServerPrefix {
  entryDirectory: string;
  prefix: string;
  project?: ProjectBoundary;
  safeSubpathsRequireExplicitAlias: boolean;
}

interface WorkspaceBoundaries {
  mappings: PathMapping[];
  projects: ProjectBoundary[];
  serverPrefixes: ServerPrefix[];
}

type ImportExportLike =
  | TSESTree.ImportDeclaration
  | TSESTree.ExportNamedDeclaration
  | TSESTree.ExportAllDeclaration;

type AliasResolution =
  | { kind: 'no-match' }
  | { filePath: string; kind: 'resolved'; mapping: PathMapping }
  | { detail: string; kind: 'unresolved' };

type ImportDecision =
  | { kind: 'safe' }
  | { kind: 'server-only' }
  | { detail: string; kind: 'configuration-error' };

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function readJsonIfExists<T extends object>(filePath: string): T | undefined {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw new Error(`Unable to read workspace configuration ${filePath}`, {
      cause: error,
    });
  }

  try {
    return parseJson<T>(source);
  } catch (error) {
    throw new Error(`Unable to parse workspace configuration ${filePath}`, {
      cause: error,
    });
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw new Error(`Unable to inspect workspace configuration ${filePath}`, {
      cause: error,
    });
  }
}

function resolveModuleFile(candidate: string): string | undefined {
  const candidates = [candidate];
  const extension = path.extname(candidate);
  if (!extension) {
    candidates.push(
      ...SOURCE_EXTENSIONS.map(
        (sourceExtension) => candidate + sourceExtension,
      ),
    );
    candidates.push(
      ...SOURCE_EXTENSIONS.map((sourceExtension) =>
        path.join(candidate, `index${sourceExtension}`),
      ),
    );
  } else if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const withoutExtension = candidate.slice(0, -extension.length);
    candidates.push(
      ...['.ts', '.tsx', '.mts', '.cts'].map(
        (sourceExtension) => withoutExtension + sourceExtension,
      ),
    );
  }

  for (const filePath of candidates) {
    try {
      if (fs.statSync(filePath).isFile()) return filePath;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw new Error(`Unable to inspect workspace module ${filePath}`, {
          cause: error,
        });
      }
    }
  }
  return undefined;
}

function hasServerOnlyMarker(filePath: string): boolean {
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to inspect workspace module ${filePath}`, {
      cause: error,
    });
  }

  return (
    /(?:^|\n)\s*import\s+['"]server-only['"]\s*;?/.test(source) ||
    /(?:^|\n)\s*assertNotBrowser\s*\(\s*\)\s*;?\s*(?:\n|$)/.test(source)
  );
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function discoverConfigurationDirectories(workspaceRoot: string): string[] {
  const directories = new Set<string>();
  const stack = [workspaceRoot];

  while (stack.length > 0) {
    const directory = stack.pop();
    if (!directory) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Unable to inspect workspace directory ${directory}`, {
        cause: error,
      });
    }

    if (
      directory !== workspaceRoot &&
      entries.some(
        (entry) =>
          entry.isFile() &&
          (entry.name === 'project.json' ||
            entry.name === 'package.json' ||
            entry.name === 'tsconfig.json'),
      )
    ) {
      directories.add(directory);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (
        entry.name.startsWith('.') ||
        IGNORED_DISCOVERY_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }
      stack.push(path.join(directory, entry.name));
    }
  }

  return [...directories];
}

function projectsFromFilesystem(workspaceRoot: string): ProjectBoundary[] {
  return discoverConfigurationDirectories(workspaceRoot).map((root) => {
    const project = readJsonIfExists<JsonProjectConfiguration>(
      path.join(root, 'project.json'),
    );
    const packageJson = readJsonIfExists<PackageJson>(
      path.join(root, 'package.json'),
    );
    const configuredRoot = project?.root
      ? path.resolve(workspaceRoot, project.root)
      : root;
    return {
      name: project?.name ?? packageJson?.name,
      root: configuredRoot,
      sourceRoot: project?.sourceRoot
        ? path.resolve(workspaceRoot, project.sourceRoot)
        : path.join(configuredRoot, 'src'),
      tags: new Set([
        ...(packageJson?.nx?.tags ?? []),
        ...(project?.tags ?? []),
      ]),
    };
  });
}

function discoverProjects(workspaceRoot: string): ProjectBoundary[] {
  // Reading the cache is synchronous and cannot start project inference. The
  // cache belongs to Nx's process-wide workspace, so only use it for the real
  // workspace root; fixture/embedded consumers take the filesystem fallback.
  if (path.resolve(workspaceRoot) === path.resolve(DEFAULT_WORKSPACE_ROOT)) {
    try {
      const graph = readCachedProjectGraph();
      return Object.values(graph.nodes).map((node) => ({
        name: node.name,
        root: path.resolve(workspaceRoot, node.data.root),
        sourceRoot: path.resolve(
          workspaceRoot,
          node.data.sourceRoot ?? node.data.root,
        ),
        tags: new Set(node.data.tags ?? []),
      }));
    } catch {
      // Editors and Nx's own project-inference phase may not have a cache yet.
      // Never call createProjectGraphAsync here: doing so can recurse through
      // the ESLint plugin that is currently being loaded.
    }
  }

  return projectsFromFilesystem(workspaceRoot);
}

function pathMappingsFromConfig(
  configPath: string,
  scopeRoot: string,
): PathMapping[] {
  const config = readJsonIfExists<Tsconfig>(configPath);
  if (!config) return [];
  const rawPaths = config.compilerOptions?.paths;
  if (!rawPaths) return [];

  const baseDirectory = path.resolve(
    path.dirname(configPath),
    config.compilerOptions?.baseUrl ?? '.',
  );
  return Object.entries(rawPaths).map(([alias, rawTargets]) => {
    if (
      !Array.isArray(rawTargets) ||
      rawTargets.length === 0 ||
      rawTargets.some((target) => typeof target !== 'string')
    ) {
      throw new Error(
        `Invalid tsconfig path mapping for ${alias} in ${configPath}`,
      );
    }
    return {
      alias,
      baseDirectory,
      configPath,
      scopeRoot,
      targets: rawTargets as string[],
    };
  });
}

function discoverPathMappings(
  workspaceRoot: string,
  projects: ProjectBoundary[],
): PathMapping[] {
  const baseConfig = path.join(workspaceRoot, 'tsconfig.base.json');
  const rootConfig = fileExists(baseConfig)
    ? baseConfig
    : path.join(workspaceRoot, 'tsconfig.json');
  const mappings = pathMappingsFromConfig(rootConfig, workspaceRoot);
  const seenConfigs = new Set([rootConfig]);

  for (const project of projects) {
    const configPath = path.join(project.root, 'tsconfig.json');
    if (seenConfigs.has(configPath)) continue;
    seenConfigs.add(configPath);
    mappings.push(...pathMappingsFromConfig(configPath, project.root));
  }

  return mappings;
}

function matchAlias(alias: string, source: string): string | undefined {
  const star = alias.indexOf('*');
  if (star === -1) return source === alias ? '' : undefined;
  const prefix = alias.slice(0, star);
  const suffix = alias.slice(star + 1);
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return undefined;
  return source.slice(prefix.length, source.length - suffix.length);
}

function mappingRank(mapping: PathMapping): [number, number, number] {
  return [
    mapping.scopeRoot.length,
    mapping.alias.includes('*') ? 0 : 1,
    mapping.alias.replaceAll('*', '').length,
  ];
}

function compareRank(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function resolveAlias(
  mappings: PathMapping[],
  source: string,
  filename: string,
): AliasResolution {
  const matching = mappings
    .map((mapping) => ({
      mapping,
      wildcard: matchAlias(mapping.alias, source),
    }))
    .filter(
      (candidate) =>
        candidate.wildcard !== undefined &&
        isInside(candidate.mapping.scopeRoot, filename),
    );
  if (matching.length === 0) return { kind: 'no-match' };

  const bestRank = matching.reduce(
    (best, candidate) => {
      const rank = mappingRank(candidate.mapping);
      return compareRank(rank, best) > 0 ? rank : best;
    },
    [0, 0, 0] as [number, number, number],
  );
  const bestMatches = matching.filter(
    (candidate) => compareRank(mappingRank(candidate.mapping), bestRank) === 0,
  );

  for (const { mapping, wildcard } of bestMatches) {
    for (const target of mapping.targets) {
      const expanded = target.split('*').join(wildcard ?? '');
      const resolved = resolveModuleFile(
        path.resolve(mapping.baseDirectory, expanded),
      );
      if (resolved) return { kind: 'resolved', filePath: resolved, mapping };
    }
  }

  const configs = [
    ...new Set(bestMatches.map(({ mapping }) => mapping.configPath)),
  ].join(', ');
  return {
    kind: 'unresolved',
    detail: `matches a workspace tsconfig alias, but its configured targets cannot be resolved (${configs})`,
  };
}

function projectForPath(
  projects: ProjectBoundary[],
  filePath: string,
): ProjectBoundary | undefined {
  return projects
    .filter((project) => isInside(project.root, filePath))
    .sort((left, right) => right.root.length - left.root.length)[0];
}

function aliasPrefix(alias: string): string {
  return alias
    .slice(0, alias.indexOf('*') === -1 ? undefined : alias.indexOf('*'))
    .replace(/\/$/u, '');
}

function addServerPrefix(
  prefixes: Map<string, ServerPrefix>,
  prefix: ServerPrefix,
): void {
  const existing = prefixes.get(prefix.prefix);
  if (!existing) {
    prefixes.set(prefix.prefix, prefix);
    return;
  }

  // A project/package boundary knows how to permit an explicit safe entry
  // point. A narrower marker-only alias (for example @repo/logging/server)
  // remains server-only throughout its own namespace.
  if (
    existing.safeSubpathsRequireExplicitAlias &&
    !prefix.safeSubpathsRequireExplicitAlias
  ) {
    prefixes.set(prefix.prefix, prefix);
  }
}

function concreteMappingTarget(mapping: PathMapping): string | undefined {
  if (mapping.alias.includes('*')) return undefined;
  for (const target of mapping.targets) {
    const resolved = resolveModuleFile(
      path.resolve(mapping.baseDirectory, target),
    );
    if (resolved) return resolved;
  }
  return undefined;
}

function discoverWorkspaceBoundaries(
  workspaceRoot: string,
): WorkspaceBoundaries {
  const projects = discoverProjects(workspaceRoot);
  const mappings = discoverPathMappings(workspaceRoot, projects);
  const prefixes = new Map<string, ServerPrefix>();

  for (const project of projects) {
    if (!project.name || !project.tags.has('platform:server')) continue;
    addServerPrefix(prefixes, {
      prefix: project.name,
      project,
      entryDirectory: project.sourceRoot,
      safeSubpathsRequireExplicitAlias: true,
    });
  }

  for (const mapping of mappings) {
    const target = concreteMappingTarget(mapping);
    if (!target || !hasServerOnlyMarker(target)) continue;
    const project = projectForPath(projects, target);
    const prefix = aliasPrefix(mapping.alias);
    addServerPrefix(prefixes, {
      prefix,
      project,
      entryDirectory: path.dirname(target),
      safeSubpathsRequireExplicitAlias: project?.name === prefix,
    });
  }

  return {
    mappings,
    projects,
    serverPrefixes: [...prefixes.values()].sort(
      (left, right) => right.prefix.length - left.prefix.length,
    ),
  };
}

function hasUseClientDirective(programBody: TSESTree.Program['body']): boolean {
  for (const node of programBody) {
    if (
      node.type !== 'ExpressionStatement' ||
      node.expression.type !== 'Literal' ||
      typeof node.expression.value !== 'string'
    ) {
      return false;
    }
    if (node.expression.value === 'use client') return true;
  }
  return false;
}

function isTypeOnly(node: ImportExportLike): boolean {
  if (node.type === 'ImportDeclaration' && node.importKind === 'type') {
    return true;
  }
  if (node.type !== 'ImportDeclaration' && node.exportKind === 'type') {
    return true;
  }
  if (!('specifiers' in node)) return false;

  const { specifiers } = node;
  return (
    specifiers.length > 0 &&
    specifiers.every(
      (specifier) =>
        ('importKind' in specifier && specifier.importKind === 'type') ||
        ('exportKind' in specifier && specifier.exportKind === 'type'),
    )
  );
}

function firstPackageSubpath(source: string, packageName: string): string {
  return source.slice(packageName.length + 1).split('/')[0];
}

function matchingServerPrefix(
  prefixes: ServerPrefix[],
  source: string,
): ServerPrefix | undefined {
  return prefixes.find(
    ({ prefix }) => source === prefix || source.startsWith(`${prefix}/`),
  );
}

function resolveServerSubpath(
  boundary: ServerPrefix,
  source: string,
): string | undefined {
  if (source === boundary.prefix) {
    return resolveModuleFile(boundary.entryDirectory);
  }
  const subpath = source.slice(boundary.prefix.length + 1);
  return resolveModuleFile(path.join(boundary.entryDirectory, subpath));
}

export const RULE_NAME = 'no-server-only-imports-in-client';

export function createRule(workspaceRoot = DEFAULT_WORKSPACE_ROOT) {
  const boundaries = discoverWorkspaceBoundaries(workspaceRoot);
  const markerCache = new Map<string, boolean>();

  function targetHasMarker(target: string): boolean {
    if (!markerCache.has(target)) {
      markerCache.set(target, hasServerOnlyMarker(target));
    }
    return markerCache.get(target) ?? false;
  }

  function decideImport(source: string, filename: string): ImportDecision {
    if (source === 'server-only') return { kind: 'server-only' };

    const aliasResolution = resolveAlias(boundaries.mappings, source, filename);
    if (aliasResolution.kind === 'unresolved') {
      return { kind: 'configuration-error', detail: aliasResolution.detail };
    }

    let target =
      aliasResolution.kind === 'resolved'
        ? aliasResolution.filePath
        : undefined;
    const serverBoundary = matchingServerPrefix(
      boundaries.serverPrefixes,
      source,
    );

    if (serverBoundary) {
      if (!target) target = resolveServerSubpath(serverBoundary, source);
      if (!target) {
        return {
          kind: 'configuration-error',
          detail: `matches server workspace project ${serverBoundary.prefix}, but its entry point cannot be resolved`,
        };
      }
      if (targetHasMarker(target)) return { kind: 'server-only' };

      if (source !== serverBoundary.prefix) {
        const firstSubpath = firstPackageSubpath(source, serverBoundary.prefix);
        if (SAFE_SUBPATHS.has(firstSubpath)) {
          return serverBoundary.safeSubpathsRequireExplicitAlias &&
            aliasResolution.kind === 'resolved'
            ? { kind: 'safe' }
            : { kind: 'server-only' };
        }
      }
      return { kind: 'server-only' };
    }

    if (target) {
      if (targetHasMarker(target)) return { kind: 'server-only' };
      const targetProject = projectForPath(boundaries.projects, target);
      if (targetProject?.tags.has('platform:server')) {
        return { kind: 'server-only' };
      }
      return { kind: 'safe' };
    }

    if (source.startsWith('@/')) {
      const sourceRootIndex = filename.lastIndexOf(`${path.sep}src${path.sep}`);
      if (sourceRootIndex === -1) {
        return {
          kind: 'configuration-error',
          detail:
            'uses the app-local @/ alias outside a discoverable source root',
        };
      }
      const sourceRoot = filename.slice(0, sourceRootIndex + 5);
      target = resolveModuleFile(path.join(sourceRoot, source.slice(2)));
      if (!target) {
        return {
          kind: 'configuration-error',
          detail:
            'uses the app-local @/ alias, but its target cannot be resolved',
        };
      }
      return targetHasMarker(target)
        ? { kind: 'server-only' }
        : { kind: 'safe' };
    }

    if (source.startsWith('.')) {
      target = resolveModuleFile(path.resolve(path.dirname(filename), source));
      if (target && targetHasMarker(target)) return { kind: 'server-only' };
    }

    // No workspace alias, project name, or local marker matched. Preserve
    // ordinary third-party package behavior and leave transitive validation to
    // the production Next build.
    return { kind: 'safe' };
  }

  return ESLintUtils.RuleCreator(() => __filename)({
    name: RULE_NAME,
    meta: {
      type: 'problem',
      docs: {
        description:
          "Disallow value imports of server-only modules in 'use client' files.",
      },
      messages: {
        configurationError:
          "Workspace import '{{source}}' {{detail}}. Fix the Nx/tsconfig boundary configuration; unresolved workspace imports are not assumed browser-safe.",
        serverOnlyImport:
          "'{{source}}' is server-only and cannot enter a 'use client' module graph. Use `import type` for erased types, an explicit browser/client entry point, or move the server work behind a Server Component or Server Function.",
      },
      schema: [],
    },
    defaultOptions: [],
    create(context) {
      const { ast } = context.sourceCode;
      if (!hasUseClientDirective(ast.body)) return {};

      function check(
        node: ImportExportLike | undefined,
        sourceNode: TSESTree.Literal | null,
      ): void {
        if (!sourceNode || typeof sourceNode.value !== 'string') return;
        if (node && isTypeOnly(node)) return;

        const decision = decideImport(sourceNode.value, context.filename);
        if (decision.kind === 'safe') return;
        if (decision.kind === 'configuration-error') {
          context.report({
            node: sourceNode,
            messageId: 'configurationError',
            data: { source: sourceNode.value, detail: decision.detail },
          });
          return;
        }
        context.report({
          node: sourceNode,
          messageId: 'serverOnlyImport',
          data: { source: sourceNode.value },
        });
      }

      return {
        ImportDeclaration(node) {
          check(node, node.source);
        },
        ExportNamedDeclaration(node) {
          check(node, node.source);
        },
        ExportAllDeclaration(node) {
          check(node, node.source);
        },
        ImportExpression(node) {
          if (node.source.type === 'Literal') check(undefined, node.source);
        },
      };
    },
  });
}

export const rule = createRule();
