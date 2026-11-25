import 'server-only';

import { logger } from '@agent-lcars/logging';
import { parseTokenMinutes } from '@agent-lcars/telemetry';
import {
  getAgentTelemetryReaderFirestore,
  listSessionDocs,
  MAX_LIST_LIMIT,
} from '@agent-lcars/telemetry/server';

import { TOKEN_RATE_MINUTES, type TokenRateSnapshot } from './token-rate';

/** Reads every session active in the readout's window plus the minute in
 * progress: a few dozen documents, read fresh on every load. Throws on a
 * store failure. */
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

/** Undefined when the session store could not be read. */
export async function getTokenRateSnapshot(): Promise<
  TokenRateSnapshot | undefined
> {
  try {
    return await readTokenRateSnapshot();
  } catch (error) {
    logger.error('agent-lcars: failed to read token rate sessions:', error);
    return undefined;
  }
}
