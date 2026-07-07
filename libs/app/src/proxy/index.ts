/**
 * Shared Edge-middleware (proxy) factory for the Next.js frontends.
 *
 * This module is compiled into each app's Edge middleware bundle, so it must
 * stay free of Node.js-only imports (`assertNotBrowser()` from the `@repo/app`
 * root entry point must NOT run here — this subpath deliberately bypasses it).
 * Each app keeps its own static `export const config = { matcher: [...] }` in
 * its `proxy.ts`, because Next.js requires the matcher to be statically
 * analyzable in the middleware file itself.
 */
export type { AuthProxyOptions } from './create-auth-proxy';
export { createAuthProxy } from './create-auth-proxy';
