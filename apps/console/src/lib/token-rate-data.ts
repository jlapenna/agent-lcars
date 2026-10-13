import 'server-only';

import { logger } from '@agent-lcars/logging';
import { parseTokenMinutes } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  listSessionDocs,
  MAX_LIST_LIMIT,
} from '@agent-lcars/telemetry/server';
import { isE2eTesting } from '@agent-lcars/util-server';
import { cacheLife } from 'next/cache';

import { DASHBOARD_CACHE_LIFE } from './dashboard-data';
import { TOKEN_RATE_MINUTES, type TokenRateSnapshot } from './token-rate';

/** Reads every session active in the readout's window plus the minute in
 * progress. Throws on a store failure, so it is never cached as a zero. */
async function readTokenRateSnapshot(): Promise<TokenRateSnapshot> {
  const now = Date.now();
  const firestore = await getAgentTelemetryReaderFirestore();
  const docs = await listSessionDocs(firestore, {
    activeSince: new Date(
      now - (TOKEN_RATE_MINUTES + 1) * 60_000,
    ).toISOString(),
    limit: MAX_LIST_LIMIT,
  });
  return {
    sessions: docs.map((doc) => {
      const minutes = parseTokenMinutes(doc.tokenMinutes);
      return {
        agent: doc.agent,
        ...(doc.repo ? { repo: `${doc.repo.owner}/${doc.repo.name}` } : {}),
        ...(minutes ? { minutes } : {}),
      };
    }),
    capped: docs.length >= MAX_LIST_LIMIT,
    observedAt: new Date(now).toISOString(),
  };
}

async function readCachedTokenRateSnapshot(): Promise<TokenRateSnapshot> {
  'use cache';
  cacheLife(DASHBOARD_CACHE_LIFE);
  return readTokenRateSnapshot();
}

/** Undefined when the session store could not be read. */
export async function getTokenRateSnapshot(): Promise<
  TokenRateSnapshot | undefined
> {
  try {
    return await (isE2eTesting()
      ? readTokenRateSnapshot()
      : readCachedTokenRateSnapshot());
  } catch (error) {
    logger.error('agent-lcars: failed to read token rate sessions:', error);
    return undefined;
  }
}
