// Load every external package the console's server chunks reference, from an
// isolated copy of the standalone bundle.
//
// `serverExternalPackages` (and Next's default external list) leave packages
// out of the server chunks; Turbopack instead links each one under
// `.next/node_modules/<name>-<hash>` and the chunks load it by that name at
// request time. If the standalone trace missed the package, or a file it
// loads, the build still succeeds and only the route that first touches it
// fails in production. tools/console-standalone-smoke.sh copies this file
// into the copied `.next/server` directory and runs it there, so resolution
// starts inside the copy and cannot fall back to the workspace node_modules.
//
// Each specifier passes if either require() or import() loads it, because a
// chunk may use either and packages such as @google-cloud/storage only ship
// the build that the chunk's form needs.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = dirname(fileURLToPath(import.meta.url));
const linkDir = join(serverDir, '..', 'node_modules');

const links = readdirSync(linkDir).flatMap((name) =>
  name.startsWith('@')
    ? readdirSync(join(linkDir, name)).map((child) => `${name}/${child}`)
    : [name],
);

const chunkSources = [];
const collect = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) collect(entryPath);
    else if (entry.name.endsWith('.js')) {
      chunkSources.push(readFileSync(entryPath, 'utf8'));
    }
  }
};
collect(serverDir);

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const specifiers = new Set();
for (const link of links) {
  const pattern = new RegExp(`["'](${escape(link)}(?:/[^"']*)?)["']`, 'g');
  for (const source of chunkSources) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
}

if (specifiers.size === 0) {
  console.error(`No external package references found under ${linkDir}.`);
  process.exit(1);
}

const requireFromServer = createRequire(join(serverDir, 'noop.cjs'));
const failures = [];
for (const specifier of [...specifiers].sort()) {
  try {
    requireFromServer(specifier);
  } catch {
    try {
      // The specifiers are discovered at runtime from the built chunks.
      // eslint-disable-next-line no-restricted-syntax
      await import(specifier);
    } catch (error) {
      failures.push(`${specifier}: ${String(error.message).split('\n')[0]}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Standalone bundle cannot load external packages:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`Loaded ${specifiers.size} external package entry points.`);
