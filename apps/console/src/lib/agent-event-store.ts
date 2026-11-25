import 'server-only';

import { required } from '@agent-lcars/util-server';
import { type AgentEventSubscription } from '@agent-lcars/work';
import { Firestore } from '@google-cloud/firestore';

/**
 * Event subscriptions the router delivers to (#3538). One document per
 * subscription in the dispatch database's `agentEventSubscriptions`
 * collection. Ids are derived from the subscription's content, so a
 * repeated subscribe request finds the subscription it already made.
 */
export const AGENT_EVENT_SUBSCRIPTIONS = 'agentEventSubscriptions';

/** How many recently routed event ids a subscription remembers, so a source
 * that sends the same event again does not deliver it twice. */
export const ROUTED_EVENT_MEMORY = 32;

export interface StoredAgentEventSubscription extends AgentEventSubscription {
  /** The most recent event ids already published for this subscription. */
  readonly routedEventIds?: readonly string[];
}

export interface AgentEventSubscriptionStore {
  /** Creates the subscription, or returns the one already stored under its
   * id. */
  create(
    subscription: AgentEventSubscription,
  ): Promise<{ subscription: StoredAgentEventSubscription; created: boolean }>;
  get(id: string): Promise<StoredAgentEventSubscription | undefined>;
  /** Session subscriptions addressed to one host, optionally one session. */
  listForHost(
    host: string,
    sessionId?: string,
  ): Promise<StoredAgentEventSubscription[]>;
  countForSession(sessionId: string): Promise<number>;
  listForKey(key: string): Promise<StoredAgentEventSubscription[]>;
  /** Whether a document was removed. */
  delete(id: string): Promise<boolean>;
  /** Records that `eventId` was published for the subscription, or removes
   * the subscription when that event ended it. A subscription removed in
   * the meantime stays removed. */
  settleRouted(id: string, eventId: string, ended: boolean): Promise<void>;
}

function remember(
  current: readonly string[] | undefined,
  eventId: string,
): string[] {
  const ids = (current ?? []).filter((id) => id !== eventId);
  ids.push(eventId);
  return ids.slice(-ROUTED_EVENT_MEMORY);
}

/** Writes only defined fields: the repository never stores `undefined`. */
function toDocument(
  subscription: AgentEventSubscription,
): StoredAgentEventSubscription {
  return {
    id: subscription.id,
    key: subscription.key,
    source: subscription.source,
    ...(subscription.kinds === undefined
      ? {}
      : { kinds: [...subscription.kinds] }),
    ...(subscription.until === undefined ? {} : { until: subscription.until }),
    target: { ...subscription.target },
    createdAt: subscription.createdAt,
  };
}

/** gRPC ALREADY_EXISTS: what creating a document that exists fails with. */
function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 6
  );
}

export class FirestoreAgentEventSubscriptionStore implements AgentEventSubscriptionStore {
  constructor(private readonly firestore: () => Firestore) {}

  private collection() {
    return this.firestore().collection(AGENT_EVENT_SUBSCRIPTIONS);
  }

  async create(subscription: AgentEventSubscription) {
    const ref = this.collection().doc(subscription.id);
    try {
      await ref.create(toDocument(subscription));
      return { subscription, created: true };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await this.get(subscription.id);
      if (existing === undefined) throw error;
      return { subscription: existing, created: false };
    }
  }

  async get(id: string) {
    const snapshot = await this.collection().doc(id).get();
    return snapshot.exists
      ? (snapshot.data() as StoredAgentEventSubscription)
      : undefined;
  }

  async listForHost(host: string, sessionId?: string) {
    // Equality filters only, so Firestore's single-field indexes serve the
    // query without a composite index.
    let query = this.collection().where('target.host', '==', host);
    if (sessionId !== undefined)
      query = query.where('target.sessionId', '==', sessionId);
    const result = await query.get();
    return result.docs.map((doc) => doc.data() as StoredAgentEventSubscription);
  }

  async countForSession(sessionId: string) {
    const result = await this.collection()
      .where('target.sessionId', '==', sessionId)
      .count()
      .get();
    return result.data().count;
  }

  async listForKey(key: string) {
    const result = await this.collection().where('key', '==', key).get();
    return result.docs.map((doc) => doc.data() as StoredAgentEventSubscription);
  }

  async delete(id: string) {
    const ref = this.collection().doc(id);
    return this.firestore().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return false;
      transaction.delete(ref);
      return true;
    });
  }

  async settleRouted(id: string, eventId: string, ended: boolean) {
    const ref = this.collection().doc(id);
    await this.firestore().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      if (ended) {
        transaction.delete(ref);
        return;
      }
      const current = snapshot.data() as StoredAgentEventSubscription;
      transaction.update(ref, {
        routedEventIds: remember(current.routedEventIds, eventId),
      });
    });
  }
}

/** The same contract in memory, for tests and the hermetic console. */
export class MemoryAgentEventSubscriptionStore implements AgentEventSubscriptionStore {
  readonly documents = new Map<string, StoredAgentEventSubscription>();

  async create(subscription: AgentEventSubscription) {
    const existing = this.documents.get(subscription.id);
    if (existing !== undefined)
      return { subscription: structuredClone(existing), created: false };
    this.documents.set(
      subscription.id,
      structuredClone(toDocument(subscription)),
    );
    return { subscription, created: true };
  }

  async get(id: string) {
    const found = this.documents.get(id);
    return found === undefined ? undefined : structuredClone(found);
  }

  async listForHost(host: string, sessionId?: string) {
    return [...this.documents.values()]
      .filter(
        ({ target }) =>
          target.type === 'session' &&
          target.host === host &&
          (sessionId === undefined || target.sessionId === sessionId),
      )
      .map((doc) => structuredClone(doc));
  }

  async countForSession(sessionId: string) {
    return [...this.documents.values()].filter(
      ({ target }) =>
        target.type === 'session' && target.sessionId === sessionId,
    ).length;
  }

  async listForKey(key: string) {
    return [...this.documents.values()]
      .filter((doc) => doc.key === key)
      .map((doc) => structuredClone(doc));
  }

  async delete(id: string) {
    return this.documents.delete(id);
  }

  async settleRouted(id: string, eventId: string, ended: boolean) {
    const current = this.documents.get(id);
    if (current === undefined) return;
    if (ended) {
      this.documents.delete(id);
      return;
    }
    this.documents.set(id, {
      ...current,
      routedEventIds: remember(current.routedEventIds, eventId),
    });
  }
}

let firestore: Firestore | undefined;
/** The production store. The Firestore client is opened on first use, so a
 * request refused before it reads anything needs no database
 * configuration. */
export const agentEventSubscriptionStore: AgentEventSubscriptionStore =
  new FirestoreAgentEventSubscriptionStore(
    () =>
      (firestore ??= new Firestore({
        projectId: required('PROJECT_ID'),
        databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
      })),
  );
