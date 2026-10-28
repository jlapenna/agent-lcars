//@ts-check
// eslint-disable-next-line no-restricted-syntax
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants');
// eslint-disable-next-line no-restricted-syntax
const path = require('node:path');
// eslint-disable-next-line no-restricted-syntax
const { resolveConsoleBuildWorkers } = require('./build-workers.cjs');

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

// @swc/core-emitted ESM interop helpers (e.g. _interop_require_default.js)
// are required dynamically by Next's own require-hook depending on the
// calling module's type, so the standalone trace sometimes copies only
// @swc/helpers' cjs/ output and misses esm/ — a server request for a route
// that needed one then crashes at runtime with MODULE_NOT_FOUND (only
// reproduces after the standalone bundle is restored from Nx cache, not on
// a from-scratch build in the same job — surfaced by #1345's @swc/core
// 1.15.47 -> 1.16.0 bump). Same fix shape as the Cloud Tasks proto above:
// force-include the whole esm/ directory from the one physical package this
// install resolved.
const swcHelpersEsmInclude = path
  .relative(
    __dirname,
    path.join(
      path.dirname(require.resolve('@swc/helpers/package.json')),
      'esm/**',
    ),
  )
  .split(path.sep)
  .join('/');

// Resolve the page-data worker pool once, at config load: an explicit
// validated budget, the CI cap, or the cgroup CPU quota this phase actually
// holds. See build-workers.cjs for the order and the rejection rules (#2493).
const buildWorkers = resolveConsoleBuildWorkers();

// GitHub Actions sets CI=true; tools/e2e-local.sh normalizes it to CI=1 for
// the hermetic E2E build. project.json's `ciBuild` input hashes this same
// predicate, so CI and local outputs never share a cache entry.
const ciBuild = ['1', 'true'].includes(process.env.CI ?? '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // The generated Cloud Tasks client loads its GAPIC JSON at runtime with a
  // dynamic require. Keep it as a Node dependency in the standalone server;
  // Turbopack cannot statically bundle that generated lookup.
  //
  // The other Google Cloud clients are externalized for build cost, not
  // correctness. Next externalizes firebase-admin by default but not the
  // libraries it wraps, and the telemetry/orchestrator stores import
  // @google-cloud/firestore directly. Turbopack then bundled the whole
  // firestore -> google-gax -> grpc-js -> protobufjs stack (~19 MB of source)
  // into three separate server chunks. Loading them from node_modules keeps
  // one copy, traced into the standalone output like @google-cloud/tasks.
  serverExternalPackages: [
    '@google-cloud/tasks',
    '@google-cloud/firestore',
    '@google-cloud/storage',
    'google-auth-library',
  ],
  // The generated JSON loader above resolves this file dynamically, so
  // Next's standalone trace sees protos.js but misses its sibling JSON file.
  // Pin the runtime asset from the exact package Node resolves; dependency
  // updates move this path automatically without sweeping up stale physical
  // pnpm peer variants that are not part of the install.
  outputFileTracingIncludes: {
    '/api/control-plane/webhook*': [cloudTasksProtoInclude],
    '/**': [swcHelpersEsmInclude],
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
  // Lets an explicitly configured dev server accept requests from a LAN
  // device. `serve-lan`/`pnpm dev:lan` supply a validated FQDN while the
  // emulator-only development stack stays on loopback by default.
  allowedDevOrigins: process.env.FQDN ? [process.env.FQDN] : undefined,
  // `next build` sizes its static-generation worker pool from the CPU count
  // the build process can see, and each page-data worker carries its own heap,
  // so an unbounded pool is OOM-killed under memory pressure -- NODE_OPTIONS'
  // --max-old-space-size is NOT the operative ceiling there (fleet finding,
  // sprinkles#4474). Visible host CPUs are also not the CPUs a bounded phase
  // was granted: a truthful 2 CPU / 3 GiB local push started 11 workers and
  // died before the branch could be published (#2493). build-workers.cjs
  // honors a validated explicit budget, the CI cap, or the cgroup CPU quota
  // actually granted, and leaves Next's host default alone for an ordinary
  // unbounded developer build.
  experimental: {
    ...(buildWorkers.cpus === null ? {} : { cpus: buildWorkers.cpus }),
    // CI builds run in fresh containers and Nx caches this target's whole
    // outputPath, so two build-only artifacts were written on every build
    // and again on every cache restore without ever being read (#2082):
    // Turbopack's persistent build cache (.next/cache, 135 MiB of the 265 MiB
    // output) and server source maps (37 MiB; .next/standalone, which deploys
    // and E2E serve, never carries them). Local builds keep both for
    // rebuild speed and debugging. Same change as Sprinkles' frontends.
    turbopackFileSystemCacheForBuild: !ciBuild,
    turbopackSourceMaps: !ciBuild,
    // Screenshot evidence accepts a 10 MiB file. Server Actions default to
    // 1 MiB; leave room for the multipart envelope and validated JSON intent.
    serverActions: { bodySizeLimit: '11mb' },
  },
  // lcars.jlapenna.net is internet-facing and its login page is a credential
  // entry point, but Firebase App Hosting adds no response hardening of its
  // own -- the origin's headers are what reach the browser (homelab#1496).
  //
  // Scoped deliberately to the four headers that are safe to apply blind:
  //
  // - HSTS without includeSubDomains/preload. This app owns one name, not
  //   the jlapenna.net tree, and preload is effectively irreversible. The
  //   value here closes the SSL-strip window on this host and claims nothing
  //   about siblings it does not serve.
  // - X-Frame-Options DENY: an operator console is never legitimately framed.
  // - nosniff and a referrer policy: no behavioural risk.
  //
  // Content-Security-Policy is NOT set here on purpose. A correct CSP for
  // this app needs per-route nonces and a measured report-only rollout; a
  // guessed one silently breaks the console instead of hardening it. That is
  // a separate change with its own verification.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000',
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
    ];
  },
};

// Nx 24 removed `withNx`/`composePlugins` and the `@nx/next:build` executor
// that used to redirect `distDir` into `dist/apps/console`. Keep that layout
// for production builds and `next start`: apphosting.yaml, the `bundle`
// target and tools/console-standalone-smoke.sh all read
// dist/apps/console/.next. Development stays on the project-local `.next`
// Turbopack expects.
module.exports = (phase) => ({
  ...nextConfig,
  distDir:
    phase === PHASE_DEVELOPMENT_SERVER
      ? '.next'
      : '../../dist/apps/console/.next',
});
