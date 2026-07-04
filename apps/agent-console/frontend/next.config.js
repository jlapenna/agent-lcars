//@ts-check
// eslint-disable-next-line no-restricted-syntax
const { composePlugins, withNx } = require('@nx/next');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // `allowedDevOrigins` is a top-level Next.js config option (since 15.3 /
  // Next 16), NOT an `experimental` one — under `experimental` Next ignores it.
  // Lets the dev server accept requests from a LAN device during preview
  // (tools/serve-lan.sh / the local-lan-preview skill export FQDN).
  allowedDevOrigins: process.env.FQDN ? [process.env.FQDN] : undefined,
};

const plugins = [withNx];
module.exports = composePlugins(...plugins)(nextConfig);
