// esbuild `alias` target (see apps/telemetry-watcher/project.json's `bundle`
// target) replacing every bundled `require('abort-controller')` with Node's
// own native, global AbortController/AbortSignal - see
// gaxios-fetch-shim.ts's doc comment for why the bundled npm polyfill's
// classes fail an `instanceof AbortSignal` check once anything (gaxios's
// fallback fetch, gcs-resumable-upload) passes one of its signals into
// Node's native `fetch` (issue #24). Mirrors the real `abort-controller`
// package's own dual export shape (`require('abort-controller')` as the
// class itself, or destructured) so it's a transparent drop-in.
module.exports = globalThis.AbortController;
module.exports.AbortController = globalThis.AbortController;
module.exports.AbortSignal = globalThis.AbortSignal;
module.exports.default = globalThis.AbortController;
