import v1 from './v1.js';

/**
 * OpenCode 2 natively exports `OPENCODE_SESSION_ID` to every shell subprocess,
 * which `lcars session title` and `lcars session status` already consume
 * (`session-id.ts`). Keep the v1 `shell.env` entrypoint beside a no-op v2
 * `setup()` so one folder package loads cleanly on both runtimes.
 */
export default {
  id: 'lcars-session',
  server: v1,
  async setup() {
    return undefined;
  },
};
