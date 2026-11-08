import type { MetadataRoute } from 'next';

import { APP_GROUND } from '../lib/app-ground';

/**
 * Web app manifest that makes the console installable from Chrome (Android
 * "Install app" / WebAPK). Served at /manifest.webmanifest, which the auth
 * proxy leaves public: browsers fetch it without credentials. Icons are
 * rendered from design/assets/icons/app-icon.svg, whose glyph stays inside
 * the maskable safe zone, so the same files serve both purposes.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Agent LCARS',
    short_name: 'LCARS',
    description: 'Agent LCARS fleet console',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: APP_GROUND,
    theme_color: APP_GROUND,
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
