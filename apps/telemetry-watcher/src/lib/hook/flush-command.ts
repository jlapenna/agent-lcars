import * as os from 'node:os';
import * as path from 'node:path';

import { type SessionEventV1 } from '@agent-lcars/telemetry';

import { SESSION_STATE_DIRECTORY } from '../session-title-paths';
import {
  type HookWriterCredentials,
  loadHookClientConfig,
} from './hook-config';
import { appendHookLog } from './hook-log';
import { markHookSessionDelivered } from './hook-state';
import { createHookEventWriter, type HookEventWriter } from './hook-store';
import { drainSpool, spoolPath } from './spool';

/**
 * The flusher (`lcars-hook-flush.cjs`): drains the hook spool into the
 * telemetry store as `telemetry-writer`. A separate bundle from the `lcars`
 * CLI so that only this process ever loads the Firestore client.
 */
export interface FlushDependencies {
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
  now: () => Date;
  hostname: () => string;
  createWriter: (
    credentials: HookWriterCredentials,
  ) => Promise<HookEventWriter>;
}

export interface FlushResult {
  readonly action: 'flushed' | 'flush-locked' | 'flush-no-credentials';
  readonly detail?: string;
}

export function defaultFlushDependencies(
  env: NodeJS.ProcessEnv = process.env,
): FlushDependencies {
  return {
    env,
    homeDirectory: os.homedir(),
    now: () => new Date(),
    hostname: () => os.hostname(),
    createWriter: async (credentials) => createHookEventWriter(credentials),
  };
}

export async function runFlush(deps: FlushDependencies): Promise<FlushResult> {
  const config = loadHookClientConfig({
    homeDirectory: deps.homeDirectory,
    env: deps.env,
    hostname: deps.hostname,
  });
  const stateDirectory = path.join(deps.homeDirectory, SESSION_STATE_DIRECTORY);
  if (!config.writer) {
    appendHookLog(
      stateDirectory,
      `${deps.now().toISOString()} flush no-credentials`,
    );
    return { action: 'flush-no-credentials' };
  }
  const writer = await deps.createWriter(config.writer);
  const result = await drainSpool(spoolPath(stateDirectory), async (event) => {
    const sessionEvent = event as SessionEventV1;
    let outcome: Awaited<ReturnType<HookEventWriter['apply']>>;
    try {
      outcome = await writer.apply(sessionEvent, deps.now().toISOString());
    } catch (error) {
      // Network, auth, or contention: keep the event for the next flusher.
      appendHookLog(
        stateDirectory,
        `${deps.now().toISOString()} flush retry ${(error as Error).name ?? 'error'}`,
      );
      return 'retry';
    }
    if (outcome === 'invalid') {
      appendHookLog(
        stateDirectory,
        `${deps.now().toISOString()} flush drop invalid session=${sessionEvent.sessionId?.slice(0, 8)} kind=${sessionEvent.kind}`,
      );
      return 'drop';
    }
    try {
      markHookSessionDelivered(
        stateDirectory,
        sessionEvent.sessionId,
        deps.now().toISOString(),
      );
    } catch {
      // State is advisory for the daemon; the write already happened.
    }
    return 'sent';
  });
  const detail = `sent=${result.sent} dropped=${result.dropped} remaining=${result.remaining}`;
  appendHookLog(
    stateDirectory,
    `${deps.now().toISOString()} flush ${result.locked ? 'locked' : 'done'} ${detail}`,
  );
  return { action: result.locked ? 'flush-locked' : 'flushed', detail };
}
