import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { logger } from '@agent-lcars/logging';
import { required } from '@agent-lcars/util-server';
import { Firestore, type Transaction } from '@google-cloud/firestore';
import webPush from 'web-push';
import { z } from 'zod';

import { isAdminGithubLogin } from './deployment';
import {
  advanceNotificationState,
  emptyNotificationState,
  type InboxNotificationSnapshot,
  type InboxNotificationState,
  NOTIFICATION_RATE_MS,
  type NotificationDecision,
  notificationSnapshotFresh,
} from './inbox-notifications';
import { loadNotificationSnapshotFor } from './inbox-notifications-data';
import { createOrchestratorRuntime } from './orchestrator-runtime';
import { resolvePrincipal } from './work-grants';

const MONTH_MS = 30 * 24 * 60 * 60_000;
const MAX_BROWSERS = 5;
const MAX_USERS = 20;
export const pushSubscriptionSchema = z.strictObject({
  endpoint: z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.port &&
        [
          'fcm.googleapis.com',
          'updates.push.services.mozilla.com',
          'web.push.apple.com',
        ].includes(url.hostname)
      );
    }, 'Unsupported browser push provider'),
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});
type Subscription = z.infer<typeof pushSubscriptionSchema>;
interface Browser {
  subscription: Subscription;
  revision: string;
  receivedAt?: number;
  sentDecisions?: NotificationDecision[];
  expiresAt: number;
  state: InboxNotificationState;
}
interface Subscriber {
  userId: string;
  login: string;
  browsers: Record<string, Browser>;
}
function boundedSubscriber(data: Subscriber): Subscriber {
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 800_000)
    throw new Error('Push preference capacity exceeded');
  return data;
}
export function pushConfiguration() {
  const raw = process.env['AGENT_LCARS_PUSH_VAPID'];
  if (!raw) return undefined;
  const value = z
    .strictObject({
      publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
      privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      subject: z.string().url(),
    })
    .safeParse(JSON.parse(raw));
  return value.success ? value.data : undefined;
}
export function pushEndpointId(endpoint: string) {
  return createHash('sha256').update(endpoint).digest('hex');
}

/** One bounded preference document per authenticated user. Transactions fence
 * concurrent ticks and consume attempts before any network delivery. A browser
 * endpoint belongs to one principal: a browser profile holds one console
 * cookie, so any other principal's copy could never check in and would only
 * spend a send and a failed receive on every decision. */
export class InboxPushStore {
  constructor(private readonly firestore: Firestore) {}
  private collection() {
    return this.firestore.collection('console-inbox-push');
  }
  private document(userId: string) {
    return this.collection().doc(pushEndpointId(`github:${userId}`));
  }
  /** Reads every other principal's copy of an endpoint. Call before any write
   * in the transaction; `dropElsewhere` then removes them. */
  private async elsewhere(tx: Transaction, userId: string, id: string) {
    const own = this.document(userId).id;
    const result = await tx.get(this.collection().limit(MAX_USERS + 1));
    return result.docs.flatMap((doc) => {
      const data = doc.data() as Subscriber;
      return doc.ref.id !== own && data.browsers?.[id]
        ? [{ ref: doc.ref, data }]
        : [];
    });
  }
  private dropElsewhere(
    tx: Transaction,
    id: string,
    holders: Awaited<ReturnType<InboxPushStore['elsewhere']>>,
  ) {
    for (const { ref, data } of holders) {
      const { [id]: _removed, ...browsers } = data.browsers;
      tx.set(ref, boundedSubscriber({ ...data, browsers }));
    }
  }
  /** The signed-in principal's browser checked in with this endpoint, so no
   * other principal can ever receive on it. */
  async release(userId: string, endpoint: string) {
    const id = pushEndpointId(endpoint);
    await this.firestore.runTransaction(async (tx) =>
      this.dropElsewhere(tx, id, await this.elsewhere(tx, userId, id)),
    );
  }
  async status(userId: string, endpoint: string): Promise<boolean> {
    const data = (await this.document(userId).get()).data() as
      Subscriber | undefined;
    return (
      (data?.browsers[pushEndpointId(endpoint)]?.expiresAt ?? 0) > Date.now()
    );
  }
  async begin(userId: string, login: string, subscription: Subscription) {
    const ref = this.document(userId);
    return this.firestore.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as Subscriber | undefined;
      const id = pushEndpointId(subscription.endpoint);
      const holders = await this.elsewhere(tx, userId, id);
      const now = Date.now();
      const browsers = Object.fromEntries(
        Object.entries(data?.browsers ?? {}).filter(
          ([, browser]) => browser.expiresAt > now,
        ),
      );
      if (!browsers[id] && Object.keys(browsers).length >= MAX_BROWSERS)
        throw new Error('Five browsers already enabled. Disable one first.');
      const previous = browsers[id];
      browsers[id] = {
        subscription,
        revision: randomUUID(),
        expiresAt: now + MONTH_MS,
        state: {
          ...emptyNotificationState(),
          lastSentAt: previous?.state.lastSentAt ?? 0,
        },
      };
      this.dropElsewhere(tx, id, holders);
      tx.set(ref, boundedSubscriber({ userId, login, browsers }));
      return browsers[id].revision;
    });
  }
  async activate(
    userId: string,
    endpoint: string,
    revision: string,
    baseline: InboxNotificationSnapshot,
  ) {
    const ref = this.document(userId);
    await this.firestore.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as Subscriber | undefined;
      const id = pushEndpointId(endpoint);
      const browser = data?.browsers[id];
      if (
        !data ||
        !browser ||
        browser.revision !== revision ||
        browser.expiresAt <= Date.now() ||
        !notificationSnapshotFresh(baseline, Date.now())
      )
        throw new Error('Activation superseded or unavailable');
      data.browsers[id] = {
        ...browser,
        state: advanceNotificationState(
          { ...browser.state, enabled: true },
          baseline,
          Date.now(),
        ),
      };
      tx.set(ref, boundedSubscriber(data));
    });
  }
  async remove(userId: string, endpoint: string, revision?: string) {
    const ref = this.document(userId);
    await this.firestore.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as Subscriber | undefined;
      const id = pushEndpointId(endpoint);
      if (!data || (revision && data.browsers[id]?.revision !== revision))
        return;
      const { [id]: _removed, ...browsers } = data.browsers;
      tx.set(ref, boundedSubscriber({ ...data, browsers }));
    });
  }
  async receive(
    userId: string,
    endpoint: string,
    attemptAt: number,
  ): Promise<NotificationDecision[] | undefined> {
    const ref = this.document(userId);
    return this.firestore.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as Subscriber | undefined;
      const id = pushEndpointId(endpoint);
      const browser = data?.browsers[id];
      const now = Date.now();
      if (
        !data ||
        !browser ||
        browser.expiresAt <= now ||
        attemptAt > now ||
        now - attemptAt >= 60_000 ||
        browser.state.lastSentAt !== attemptAt ||
        browser.receivedAt === attemptAt
      )
        return undefined;
      data.browsers[id] = { ...browser, receivedAt: attemptAt };
      tx.set(ref, boundedSubscriber(data));
      return browser.sentDecisions;
    });
  }
  async subscribers(): Promise<Subscriber[]> {
    const result = await this.collection()
      .limit(MAX_USERS + 1)
      .get();
    if (result.size > MAX_USERS)
      throw new Error('Push subscriber capacity exceeded');
    return result.docs.map((doc) => doc.data() as Subscriber);
  }
  async claim(
    userId: string,
    endpoint: string,
    revision: string,
    snapshot: InboxNotificationSnapshot,
    now: number,
  ) {
    const ref = this.document(userId);
    return this.firestore.runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as Subscriber | undefined;
      const id = pushEndpointId(endpoint);
      const browser = data?.browsers[id];
      if (
        !data ||
        !browser ||
        browser.revision !== revision ||
        browser.expiresAt <= now ||
        !notificationSnapshotFresh(snapshot, now)
      )
        return undefined;
      const state = advanceNotificationState(browser.state, snapshot, now);
      const candidates = state.pending.filter((decision) =>
        snapshot.decisions.some(
          (current) =>
            current.id === decision.id &&
            current.generation === decision.generation,
        ),
      );
      const send =
        candidates.length > 0 && now - state.lastSentAt >= NOTIFICATION_RATE_MS;
      data.browsers[id] = {
        ...browser,
        state: send ? { ...state, pending: [], lastSentAt: now } : state,
        ...(send ? { sentDecisions: candidates } : {}),
      };
      tx.set(ref, boundedSubscriber(data));
      return send
        ? {
            principalId: userId,
            attemptAt: now,
            expiresAt: now + 60_000,
          }
        : undefined;
    });
  }
}
let store: InboxPushStore | undefined;
export function getInboxPushStore() {
  return (store ??= new InboxPushStore(
    new Firestore({
      projectId: required('PROJECT_ID'),
      databaseId: required('DISPATCH_FIRESTORE_DATABASE_ID'),
    }),
  ));
}

export async function pushSnapshot(userId: string, login: string) {
  if (!isAdminGithubLogin(login)) throw new Error('Admin access revoked');
  const grant = resolvePrincipal(`github:${login}`);
  return loadNotificationSnapshotFor(userId, {
    runtime: createOrchestratorRuntime(),
    principal: grant
      ? {
          principal: grant.principal,
          subject: `github:${login}`,
          scopes: new Set(grant.scopes),
          pipelines: grant.pipelines,
          via: 'session',
        }
      : undefined,
  });
}

/** Push service options. A decision notice is user-visible and time-sensitive,
 * so it is sent with high urgency (RFC 8030 section 5.3). Mobile push services
 * defer normal-urgency messages while a device idles, and the 60-second TTL
 * would expire before delivery. */
export const INBOX_PUSH_SEND_OPTIONS = {
  TTL: 60,
  urgency: 'high',
  timeout: 5_000,
  topic: 'lcars-inbox',
} as const;

/** Called by the existing authenticated schedule tick. No detached work:
 * failures are observable, attempts are never automatically retried ambiguously. */
export async function deliverInboxPush() {
  const config = pushConfiguration();
  if (!config) return;
  const store = getInboxPushStore();
  const deadline = Date.now() + 20_000;
  for (const user of await store.subscribers()) {
    if (Date.now() >= deadline) return;
    if (!isAdminGithubLogin(user.login)) {
      for (const browser of Object.values(user.browsers))
        await store.remove(
          user.userId,
          browser.subscription.endpoint,
          browser.revision,
        );
      continue;
    }
    const snapshot = await pushSnapshot(user.userId, user.login);
    for (const browser of Object.values(user.browsers)) {
      if (Date.now() >= deadline) return;
      if (browser.expiresAt <= Date.now()) {
        await store.remove(
          user.userId,
          browser.subscription.endpoint,
          browser.revision,
        );
        continue;
      }
      const payload = await store.claim(
        user.userId,
        browser.subscription.endpoint,
        browser.revision,
        snapshot,
        Date.now(),
      );
      if (!payload) continue;
      try {
        await webPush.sendNotification(
          browser.subscription,
          JSON.stringify(payload),
          { ...INBOX_PUSH_SEND_OPTIONS, vapidDetails: config },
        );
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410)
          await store.remove(
            user.userId,
            browser.subscription.endpoint,
            browser.revision,
          );
        // Never log a provider response: it can include the secret endpoint.
        else
          logger.warn('agent-lcars: Inbox push delivery unavailable', {
            statusCode: status ?? 'network',
          });
      }
    }
  }
}
