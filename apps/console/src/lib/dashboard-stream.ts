import 'server-only';

import { logger } from '@agent-lcars/logging';
import { getAgentTelemetryReaderFirestore } from '@agent-lcars/telemetry/server';
import { required } from '@agent-lcars/util-server';
import { Firestore } from '@google-cloud/firestore';

import type { DashboardSignal } from './dashboard-stream-contract';

// One connection per server process; each subscription is owned by its request.
let broker: Firestore | undefined;

/** Bounded change feeds, not dashboard data. Lifecycle writers advance these
 * timestamps on every accepted change; anchor removal retains its watermark.
 * Anchor sourceUpdatedAt is deliberately
 * NOT used: a late webhook must still invalidate an open dashboard. Initial
 * snapshots also invalidate, covering any gap while the browser disconnected.
 * Only automatic single-field indexes are needed. No GitHub calls or polling.
 */
export function subscribeDashboardChanges(
  onSignal: (signal: DashboardSignal) => void,
): () => void {
  const stops: (() => void)[] = [];
  let closed = false;
  let degraded = false;
  let remaining = 5;
  const signal = () => {
    if (!closed && remaining === 0)
      onSignal({ state: degraded ? 'degraded' : 'live', changed: true });
  };
  const stop = () => {
    closed = true;
    for (const unsubscribe of stops.splice(0)) unsubscribe();
  };
  function unavailable(error: unknown) {
    if (closed) return;
    logger.error('agent-lcars: dashboard subscription unavailable:', error);
    stop();
    onSignal({ state: 'degraded', changed: false });
  }
  const listen = (firestore: Firestore, collection: string, field: string) => {
    let initial = true;
    const initialized = () => {
      if (initial) {
        initial = false;
        remaining -= 1;
      }
    };
    stops.push(
      firestore
        .collection(collection)
        .orderBy(field, 'desc')
        .limit(200)
        .onSnapshot(
          () => {
            initialized();
            signal();
          },
          (error) => {
            logger.error('agent-lcars: dashboard listener failed:', error);
            degraded = true;
            initialized();
            signal();
          },
        ),
    );
  };
  try {
    broker ??= new Firestore({
      projectId: required('PROJECT_ID'),
      databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
    });
    listen(broker, 'orchestrator-github-anchors', 'streamChangedAt');
    listen(broker, 'orchestrator-tasks', 'task.updatedAt');
    listen(broker, 'orchestrator-runs', 'updatedAt');
    void Promise.resolve(getAgentTelemetryReaderFirestore())
      .then((telemetry) => {
        if (closed) return;
        listen(telemetry, 'sessions', 'lastActivityAt');
        listen(telemetry, 'runner-status', 'updatedAt');
      })
      .catch(unavailable);
  } catch (error) {
    unavailable(error);
  }
  return stop;
}
