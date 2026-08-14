//@ts-check
// eslint-disable-next-line no-restricted-syntax
const { composePlugins, withNx } = require('@nx/next');
// eslint-disable-next-line no-restricted-syntax
const path = require('node:path');

// Resolve through the workspace dependency symlink so the trace follows the
// one physical pnpm package selected by this install. A virtual-store glob
// also sees unused stale peer variants, making identical Nx inputs produce
// different standalone artifacts (#1023).
const cloudTasksEntry = require.resolve('@google-cloud/tasks');
const cloudTasksBuildSegment = `${path.sep}build${path.sep}`;
const cloudTasksBuildIndex = cloudTasksEntry.lastIndexOf(
  cloudTasksBuildSegment,
);

if (cloudTasksBuildIndex === -1) {
  throw new Error(
    `Could not locate @google-cloud/tasks package root from ${cloudTasksEntry}`,
  );
}

const cloudTasksProtoInclude = path
  .relative(
    __dirname,
    path.join(
      cloudTasksEntry.slice(0, cloudTasksBuildIndex),
      'build/protos/protos.json',
    ),
  )
  .split(path.sep)
  .join('/');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // The generated Cloud Tasks client loads its GAPIC JSON at runtime with a
  // dynamic require. Keep it as a Node dependency in the standalone server;
  // Turbopack cannot statically bundle that generated lookup.
  serverExternalPackages: ['@google-cloud/tasks'],
  // The generated JSON loader above resolves this file dynamically, so
  // Next's standalone trace sees protos.js but misses its sibling JSON file.
  // Pin the runtime asset from the exact package Node resolves; dependency
  // updates move this path automatically without sweeping up stale physical
  // pnpm peer variants that are not part of the install.
  outputFileTracingIncludes: {
    '/api/control-plane/webhook*': [cloudTasksProtoInclude],
  },
  // Next 16's native cache model, enabling `"use cache"` +
  // `cacheTag`/`cacheLife` (see lib/dashboard-data.ts for why the legacy
  // `unstable_cache` was not an option). It also requires every uncached
  // data read to sit inside a <Suspense> boundary and forbids the
  // `dynamic = 'force-dynamic'` segment config, which is why each page is
  // now a thin shell around a streamed content component.
  cacheComponents: true,
  // Without this, Next.js infers the file-tracing root from the nearest
  // lockfile it finds walking up from this dir — ambiguous whenever more
  // than one is visible (e.g. a git worktree nested under the primary
  // checkout), and the standalone build then mirrors the WRONG absolute
  // path, breaking `node .../standalone/apps/console/server.js`
  // (#2216). Pin it explicitly, same as onecake/primes.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // `allowedDevOrigins` is a top-level Next.js config option (since 15.3 /
  // Next 16), NOT an `experimental` one — under `experimental` Next ignores it.
  // Lets the dev server accept requests from a LAN device during preview
  // (tools/serve-lan.sh / the local-lan-preview skill export FQDN).
  allowedDevOrigins: process.env.FQDN ? [process.env.FQDN] : undefined,
};

const plugins = [withNx];
module.exports = composePlugins(...plugins)(nextConfig);
