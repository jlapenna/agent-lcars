import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// See page-shell-contract.test.ts for why this resolves its own directory
// with fileURLToPath rather than `new URL('.', import.meta.url)`.
const APP_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = join(APP_DIRECTORY, '../../../..');
const require = createRequire(import.meta.url);

/** A package root from its main entry; Mantine exports no package.json. */
function packageRoot(name: string): string {
  let directory = dirname(require.resolve(name));
  while (!existsSync(join(directory, 'package.json')))
    directory = dirname(directory);
  return directory;
}

const CORE = packageRoot('@mantine/core');
const STYLE_IMPORT = /^import '@mantine\/core\/styles\/([\w-]+)\.css';$/gm;
const CORE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]@mantine\/core['"]/g;
const SHEET_BASE = ['baseline', 'default-css-variables', 'global'];

function files(directory: string, suffix: RegExp): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path, suffix);
    return suffix.test(entry.name) && !/\.(test|spec)\./.test(entry.name)
      ? [path]
      : [];
  });
}

/** Runtime names imported from @mantine/core by the given files. */
function coreImports(paths: string[]): Set<string> {
  const names = new Set<string>();
  for (const path of paths)
    for (const [, clause] of readFileSync(path, 'utf8').matchAll(CORE_IMPORT))
      for (const part of clause.split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name && !name.startsWith('type ')) names.add(name);
      }
  return names;
}

/** Stylesheets of every Mantine module reachable from the imported names. */
function requiredSheets(): string[] {
  const esm = join(CORE, 'esm');
  const entries = new Map<string, string>();
  for (const [, clause, target] of readFileSync(
    join(esm, 'index.mjs'),
    'utf8',
  ).matchAll(/(?:import|export)\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g))
    for (const part of clause.split(','))
      entries.set(
        part.trim().split(/\s+as\s+/)[0],
        normalize(join(esm, target)),
      );
  const names = coreImports([
    ...files(APP_DIRECTORY, /\.tsx?$/),
    ...files(join(APP_DIRECTORY, '../lib'), /\.tsx?$/),
    ...files(join(REPOSITORY, 'libs/app-providers/src'), /\.tsx?$/),
    ...files(join(packageRoot('@mantine/notifications'), 'esm'), /\.mjs$/),
    ...files(join(packageRoot('@mantine/modals'), 'esm'), /\.mjs$/),
  ]);
  const pending = [...names].flatMap((name) => entries.get(name) ?? []);
  const seen = new Set<string>();
  for (let path = pending.pop(); path; path = pending.pop()) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    for (const [, target] of readFileSync(path, 'utf8').matchAll(
      /from\s*"(\.[^"]+)"/g,
    ))
      pending.push(normalize(join(dirname(path), target)));
  }
  return [...seen]
    .filter((path) => path.endsWith('.module.mjs'))
    .map((path) => basename(path, '.module.mjs'))
    .filter((name) => existsSync(join(CORE, 'styles', `${name}.css`)));
}

const imported = [
  ...readFileSync(join(APP_DIRECTORY, 'mantine-styles.ts'), 'utf8').matchAll(
    STYLE_IMPORT,
  ),
].map(([, name]) => name);

describe('Mantine stylesheets', () => {
  it('imports exactly the stylesheets of the components the console renders', () => {
    expect(imported.slice(0, SHEET_BASE.length)).toEqual(SHEET_BASE);
    expect(imported.slice(SHEET_BASE.length).toSorted()).toEqual(
      [...new Set(requiredSheets())].toSorted(),
    );
  });

  it('keeps the cascade order of the full Mantine stylesheet', () => {
    const full = readFileSync(join(CORE, 'styles.css'), 'utf8');
    const positions = imported.map((name) =>
      full.indexOf(
        readFileSync(join(CORE, 'styles', `${name}.css`), 'utf8')
          .trim()
          .slice(0, 300),
      ),
    );
    expect(positions).not.toContain(-1);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  });
});
