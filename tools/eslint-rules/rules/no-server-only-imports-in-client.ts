/**
 * ESLint rule: forbid value imports of server-only modules in `'use client'`
 * files.
 *
 * Next.js's `server-only` marker remains the authoritative, transitive build
 * guard. This rule is the cheaper editor-time layer for direct imports. It
 * discovers server-only workspace entry points from three existing sources
 * of truth instead of maintaining another denylist:
 *
 * - `platform:server` Nx project tags;
 * - root entry points that call `assertNotBrowser()`; and
 * - exact tsconfig aliases or relative modules that import `server-only` or
 *   call `assertNotBrowser()` themselves.
 *
 * Type-only imports are erased before bundling and remain allowed. Explicit
 * browser/client/schema/UI entry points of mixed packages remain allowed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { workspaceRoot as nxWorkspaceRoot } from '@nx/devkit';
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

type TsconfigPaths = Record<string, string[]>;

interface ProjectConfiguration {
  name?: string;
  tags?: string[];
}

interface Tsconfig {
  compilerOptions?: {
    paths?: TsconfigPaths;
  };
}

interface WorkspaceBoundaries {
  exactServerAliases: Set<string>;
  paths: TsconfigPaths;
  safeExactAliases: Set<string>;
  serverPackagePrefixes: Set<string>;
}

type ImportExportLike =
  | TSESTree.ImportDeclaration
  | TSESTree.ExportNamedDeclaration
  | TSESTree.ExportAllDeclaration;

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function resolveModuleFile(candidate: string): string | undefined {
  const candidates = [candidate];
  const extension = path.extname(candidate);
  if (!extension) {
    candidates.push(
      ...SOURCE_EXTENSIONS.map((extension) => candidate + extension),
    );
    candidates.push(
      ...SOURCE_EXTENSIONS.map((extension) =>
        path.join(candidate, `index${extension}`),
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

  return candidates.find((filePath) => {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  });
}

function hasServerOnlyMarker(filePath: string | undefined): boolean {
  if (!filePath) return false;
  try {
    const source = fs.readFileSync(filePath, 'utf8');
    return (
      /(?:^|\n)\s*import\s+['"]server-only['"]\s*;?/.test(source) ||
      /(?:^|\n)\s*assertNotBrowser\s*\(\s*\)\s*;?\s*(?:\n|$)/.test(source)
    );
  } catch {
    return false;
  }
}

function loadTsconfigPaths(workspaceRoot: string): TsconfigPaths {
  return (
    readJson<Tsconfig>(path.join(workspaceRoot, 'tsconfig.base.json'))
      ?.compilerOptions?.paths ?? {}
  );
}

function resolveTsconfigTarget(
  workspaceRoot: string,
  paths: TsconfigPaths,
  source: string,
): string | undefined {
  for (const [alias, targets] of Object.entries(paths)) {
    const star = alias.indexOf('*');
    let wildcard: string | undefined;
    if (star === -1) {
      if (source !== alias) continue;
    } else {
      const prefix = alias.slice(0, star);
      const suffix = alias.slice(star + 1);
      if (!source.startsWith(prefix) || !source.endsWith(suffix)) continue;
      wildcard = source.slice(prefix.length, source.length - suffix.length);
    }

    for (const target of targets) {
      const expanded =
        wildcard === undefined ? target : target.split('*').join(wildcard);
      const resolved = resolveModuleFile(path.resolve(workspaceRoot, expanded));
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function discoverWorkspaceBoundaries(
  workspaceRoot: string,
): WorkspaceBoundaries {
  const paths = loadTsconfigPaths(workspaceRoot);
  const exactServerAliases = new Set<string>();
  const serverPackagePrefixes = new Set<string>();
  const safeExactAliases = new Set<string>();

  for (const [alias, targets] of Object.entries(paths)) {
    if (alias.includes('*')) continue;
    const target = resolveModuleFile(path.resolve(workspaceRoot, targets[0]));
    if (hasServerOnlyMarker(target)) exactServerAliases.add(alias);
  }

  const libsDir = path.join(workspaceRoot, 'libs');
  let libraryNames: string[] = [];
  try {
    libraryNames = fs.readdirSync(libsDir);
  } catch {
    // A fixture or non-Nx consumer may not have a libs directory.
  }

  for (const libraryName of libraryNames) {
    const project = readJson<ProjectConfiguration>(
      path.join(libsDir, libraryName, 'project.json'),
    );
    const packageName = project?.name;
    if (!packageName) continue;

    const rootAliasTarget = resolveTsconfigTarget(
      workspaceRoot,
      paths,
      packageName,
    );
    const hasExplicitEnvironmentSplit =
      paths[`${packageName}/server`] &&
      (paths[`${packageName}/browser`] || paths[`${packageName}/client`]);
    if (
      project.tags?.includes('platform:server') ||
      hasServerOnlyMarker(rootAliasTarget) ||
      hasExplicitEnvironmentSplit
    ) {
      serverPackagePrefixes.add(packageName);
    }

    for (const alias of Object.keys(paths)) {
      if (!alias.startsWith(`${packageName}/`) || alias.includes('*')) continue;
      if (
        SAFE_SUBPATHS.has(firstPackageSubpath(alias, packageName)) &&
        !exactServerAliases.has(alias)
      ) {
        safeExactAliases.add(alias);
      }
    }
  }

  return { exactServerAliases, paths, safeExactAliases, serverPackagePrefixes };
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

export const RULE_NAME = 'no-server-only-imports-in-client';

export function createRule(workspaceRoot = DEFAULT_WORKSPACE_ROOT) {
  const boundaries = discoverWorkspaceBoundaries(workspaceRoot);
  const markerCache = new Map<string, boolean>();

  function localImportHasMarker(source: string, filename: string): boolean {
    let target: string | undefined;
    if (source.startsWith('.')) {
      target = resolveModuleFile(path.resolve(path.dirname(filename), source));
    } else if (source.startsWith('@/')) {
      const sourceRootIndex = filename.lastIndexOf(`${path.sep}src${path.sep}`);
      if (sourceRootIndex !== -1) {
        const sourceRoot = filename.slice(0, sourceRootIndex + 5);
        target = resolveModuleFile(path.join(sourceRoot, source.slice(2)));
      }
    } else {
      target = resolveTsconfigTarget(workspaceRoot, boundaries.paths, source);
    }

    if (!target) return false;
    if (!markerCache.has(target))
      markerCache.set(target, hasServerOnlyMarker(target));
    return markerCache.get(target) ?? false;
  }

  function violatingSource(source: string, filename: string): boolean {
    if (source === 'server-only') return true;
    if (boundaries.exactServerAliases.has(source)) return true;
    if (boundaries.safeExactAliases.has(source)) return false;

    for (const packageName of boundaries.serverPackagePrefixes) {
      if (source === packageName) return true;
      if (!source.startsWith(`${packageName}/`)) continue;
      if (SAFE_SUBPATHS.has(firstPackageSubpath(source, packageName)))
        return false;
      return true;
    }

    return localImportHasMarker(source, filename);
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
        serverOnlyImport:
          "'{{source}}' is server-only and cannot enter a 'use client' module graph. Use `import type` for erased types, a browser/client entry point, or move the server work behind a Server Component or Server Function.",
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
        if (violatingSource(sourceNode.value, context.filename)) {
          context.report({
            node: sourceNode,
            messageId: 'serverOnlyImport',
            data: { source: sourceNode.value },
          });
        }
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
