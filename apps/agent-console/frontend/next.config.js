//@ts-check
// eslint-disable-next-line no-restricted-syntax
const { composePlugins, withNx } = require('@nx/next');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Without this, Next.js infers the file-tracing root from the nearest
  // lockfile it finds walking up from this dir — ambiguous whenever more
  // than one is visible (e.g. a git worktree nested under the primary
  // checkout), and the standalone build then mirrors the WRONG absolute
  // path, breaking `node .../standalone/apps/agent-console/frontend/server.js`
  // (#2216). Pin it explicitly, same as onecake/primes.
  // eslint-disable-next-line no-restricted-syntax
  outputFileTracingRoot: require('path').join(__dirname, '../../../'),
  // `allowedDevOrigins` is a top-level Next.js config option (since 15.3 /
  // Next 16), NOT an `experimental` one — under `experimental` Next ignores it.
  // Lets the dev server accept requests from a LAN device during preview
  // (tools/serve-lan.sh / the local-lan-preview skill export FQDN).
  allowedDevOrigins: process.env.FQDN ? [process.env.FQDN] : undefined,
};

const plugins = [withNx];
module.exports = composePlugins(...plugins)(nextConfig);
