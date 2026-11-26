import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { GithubPreviewRead } from './github-stream-source';
import { GITHUB_PREVIEW_EVENTS } from './github-stream-source';

/** Bounded authenticated reads through the host's existing gh identity.
 * No shell, no URLs from event data, and no stderr/API body in diagnostics. */
export function githubCommand(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      [...args],
      {
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' },
      },
      (error, stdout) => {
        if (error) reject(new Error('GitHub command failed'));
        else resolve(stdout);
      },
    );
  });
}

export const githubPreviewApi: GithubPreviewRead = {
  get: async (path) =>
    JSON.parse(await githubCommand(['api', '--hostname', 'github.com', path])),
  pages: async (path) =>
    JSON.parse(
      await githubCommand([
        'api',
        '--hostname',
        'github.com',
        '--paginate',
        '--slurp',
        path,
      ]),
    ),
};

export interface PreviewListener {
  /** Resolves only after the first stream attachment. */
  ready: Promise<void>;
  closed: Promise<void>;
  stop(): Promise<void>;
}
export type OpenPreviewListener = (
  resource: string,
  onAttach: () => void,
  onEvent: (input: unknown) => void,
  onDetach?: () => void,
) => PreviewListener;

/** gh reconnects broken streams itself; each attach must resnapshot because
 * disconnected events are not replayed. Use a bounded lifetime so the owner
 * renews the 24-hour subscription. Idempotently reused account subscriptions
 * are never deleted here: other hosts/consumers can share them. */
export const openGithubPreviewListener: OpenPreviewListener = (
  resource,
  onAttach,
  onEvent,
  onDetach,
) => {
  const child = spawn(
    'gh',
    [
      'event',
      'listen',
      '--resource',
      resource,
      '--event',
      GITHUB_PREVIEW_EVENTS.join(','),
      '--follow',
      '--timeout',
      '23h',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' },
    },
  );
  let attached = false;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timeout = setTimeout(() => {
    rejectReady(new Error('GitHub stream attach timed out'));
    child.kill('SIGTERM');
  }, 30_000);
  const out = createInterface({ input: child.stdout });
  const err = createInterface({ input: child.stderr });
  out.on('line', (line) => {
    if (line.length > 65_536) {
      child.kill('SIGTERM');
      return;
    }
    try {
      onEvent(JSON.parse(line));
    } catch {
      /* A malformed notice cannot cause a read. */
    }
  });
  err.on('line', (line) => {
    const status = line.trim();
    if (
      status.startsWith('Event stream ') ||
      status.startsWith('Could not attach the event stream,') ||
      status.startsWith('Subscription ')
    )
      onDetach?.();
    if (
      status !== 'Listening for events.' &&
      status !== 'Listening for events on a new subscription.'
    )
      return;
    attached = true;
    clearTimeout(timeout);
    onAttach();
    resolveReady();
  });
  const closed = new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      out.close();
      err.close();
      if (!attached) rejectReady(new Error('GitHub stream unavailable'));
      resolve();
    };
    child.once('error', finish);
    child.once('close', finish);
  });
  return {
    ready,
    closed,
    stop: async () => {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await closed;
      clearTimeout(force);
    },
  };
};
