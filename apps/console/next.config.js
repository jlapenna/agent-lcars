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
  // Lets the dev server accept requests from a LAN device during preview
  // (tools/serve-lan.sh / the local-lan-preview skill export FQDN).
  allowedDevOrigins: process.env.FQDN ? [process.env.FQDN] : undefined,
  // `next build` sizes its static-generation worker pool from the runner's
  // CPU count, and a GitHub-hosted/self-hosted CI runner's kernel OOM-kills
  // it under memory pressure -- NODE_OPTIONS' --max-old-space-size is NOT
  // the operative ceiling there (fleet finding, sprinkles#4474). Cap it in
  // CI/E2E only; local dev builds keep full parallelism.
  experimental: {
    ...(process.env.CI ? { cpus: 2 } : {}),
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

const plugins = [withNx];
module.exports = composePlugins(...plugins)(nextConfig);
