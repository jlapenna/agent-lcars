import {
  type AgentEventSubscriptionView,
  MAX_AGENT_EVENT_CLOCK_SKEW_MS,
  parseAgentEventKey,
  subscriptionMatches,
} from '@agent-lcars/work';

import type { DeliveryLog } from './delivery-agent';
import {
  type OpenPreviewListener,
  type PreviewListener,
} from './github-stream-process';
import {
  type GithubPreviewRead,
  readGithubPreviewEvents,
  validGithubPreviewNotice,
} from './github-stream-source';
import type { GithubStreamCheckpoints } from './github-stream-state';
import type { DeliveryMetrics } from './metrics';
import type { SubscriptionForwarder } from './subscribe-forwarder';

type Subscription = AgentEventSubscriptionView;
interface Stream {
  readonly key: string;
  readonly repository: string;
  readonly number: number;
  readonly subscriptions: Map<string, Subscription>;
  since: string;
  listener?: PreviewListener;
  starting?: Promise<void>;
  reading?: Promise<void>;
  dirty: boolean;
  stopped: boolean;
  attached: boolean;
  retry?: ReturnType<typeof setTimeout>;
  failures: number;
  lastSnapshot: number;
  failed: boolean;
  checkpointLoaded: boolean;
}
export interface GithubStreamsDeps {
  readonly forwarder: SubscriptionForwarder;
  readonly api: GithubPreviewRead;
  readonly checkpoints?: GithubStreamCheckpoints;
  readonly open: OpenPreviewListener;
  readonly metrics: DeliveryMetrics;
  readonly log: DeliveryLog;
  readonly now: () => number;
}

/** Owns only host PR sources; existing Pub/Sub delivery still owns notices.
 * One live stream per key, shared by this host's sessions. No polling; reads
 * happen at attachment, on notifications, or after a failed read/connection.
 * Shutdown/restart restores registrations from the console. */
export class GithubStreams {
  private readonly streams = new Map<string, Stream>();
  private stopped = false;
  private restoreRetry?: ReturnType<typeof setTimeout>;
  readonly forwarder: SubscriptionForwarder;
  constructor(private readonly deps: GithubStreamsDeps) {
    const base = deps.forwarder;
    this.forwarder = {
      ...base,
      subscribe: async (sessionId, request) => {
        const ordinary = await base.subscribe(sessionId, request);
        if (ordinary.ok && !ordinary.value.githubStream) return ordinary;
        if (
          !ordinary.ok &&
          !(
            ordinary.error === 'forbidden' &&
            ordinary.message.includes('App source does not watch')
          )
        )
          return ordinary;
        // Keep old registrations on attach failure, but remove a newly created
        // one so the failed CLI operation cannot leave a false-success wait.
        const before = await base.list(sessionId);
        if (!before.ok) return before;
        const subscribed = ordinary.ok
          ? ordinary
          : await base.subscribe(sessionId, request, true);
        if (!subscribed.ok) return subscribed;
        if (!subscribed.value.githubStream) return subscribed;
        try {
          await this.add(subscribed.value);
          return subscribed;
        } catch {
          if (!before.value.some((s) => s.id === subscribed.value.id)) {
            const removed = await base.unsubscribe(subscribed.value.id);
            if (removed.ok || removed.error === 'not-found')
              this.remove(subscribed.value.id);
            else {
              const stream = this.streams.get(subscribed.value.key);
              if (stream) this.retry(stream);
            }
          }
          return {
            ok: false,
            error: 'unavailable',
            message:
              'GitHub preview stream or authoritative state read unavailable; subscription not confirmed',
            retryable: true,
          };
        }
      },
      unsubscribe: async (id) => {
        const result = await base.unsubscribe(id);
        if (result.ok || result.error === 'not-found') this.remove(id);
        return result;
      },
      reportSession: async (sessionId, kind, occurredAt) => {
        const result = await base.reportSession(sessionId, kind, occurredAt);
        if (result.ok && kind === 'ended') {
          for (const stream of this.streams.values())
            for (const subscription of stream.subscriptions.values()) {
              if (
                subscription.target.type === 'session' &&
                subscription.target.sessionId === sessionId
              ) {
                const removed = await base.unsubscribe(subscription.id);
                if (removed.ok || removed.error === 'not-found')
                  this.remove(subscription.id);
                else return removed;
              }
            }
        }
        return result;
      },
    };
  }

  async restore(): Promise<void> {
    const listed = await this.deps.forwarder.list(undefined);
    if (this.stopped) return;
    if (!listed.ok) {
      this.deps.metrics.githubRestoreReady = 0;
      this.deps.metrics.githubErrors++;
      this.restoreRetry = setTimeout(() => {
        this.restoreRetry = undefined;
        void this.restore();
      }, 60_000);
      this.deps.log({
        level: 'error',
        msg: 'GitHub registration restore failed; retry scheduled',
        component: 'github-stream',
        stage: 'restore',
      });
      return;
    }
    this.deps.metrics.githubRestoreReady = 1;
    await Promise.all(
      listed.value
        .filter((s) => s.githubStream)
        .map(async (subscription) => {
          try {
            await this.add(subscription);
          } catch {
            /* add schedules an observable retry. */
          }
        }),
    );
  }

  private updateMetrics(): void {
    this.deps.metrics.githubStreamsWanted = this.streams.size;
    this.deps.metrics.githubSourcesFailed = [...this.streams.values()].filter(
      (s) => s.failed,
    ).length;
    this.deps.metrics.githubStreamsOpen = [...this.streams.values()].filter(
      (s) => s.attached,
    ).length;
    const snapshots = [...this.streams.values()].map((s) => s.lastSnapshot);
    this.deps.metrics.githubOldestSnapshot = snapshots.length
      ? Math.min(...snapshots) / 1000
      : 0;
  }

  private async add(subscription: Subscription): Promise<void> {
    if (this.stopped) throw new Error('GitHub streams stopped');
    const parsed = parseAgentEventKey(subscription.key);
    if (!parsed.ok || parsed.value.source !== 'github:pr')
      throw new Error('Not a PR key');
    let stream = this.streams.get(subscription.key);
    if (!stream) {
      const [repository, number] = parsed.value.id.split('#');
      stream = {
        key: subscription.key,
        repository,
        number: Number(number),
        subscriptions: new Map(),
        since: subscription.createdAt,
        dirty: false,
        stopped: false,
        attached: false,
        failures: 0,
        lastSnapshot: 0,
        failed: false,
        checkpointLoaded: false,
      };
      this.streams.set(stream.key, stream);
    }
    stream.subscriptions.set(subscription.id, subscription);
    this.updateMetrics();
    if (stream.starting) {
      stream.dirty = true;
      return stream.starting;
    }
    if (!stream.listener) return this.start(stream);
    if (!stream.attached) throw new Error('GitHub stream is reconnecting');
    // A new subscriber still needs the post-registration read, even when
    // another session already holds the stream.
    try {
      await this.snapshot(stream);
    } catch {
      this.retry(stream);
      throw new Error('GitHub state read failed');
    }
    if (!stream.stopped && !stream.attached)
      throw new Error('GitHub stream detached during state read');
  }

  private start(stream: Stream): Promise<void> {
    if (stream.starting) return stream.starting;
    if (stream.retry) {
      clearTimeout(stream.retry);
      stream.retry = undefined;
    }
    stream.starting = (async () => {
      const listener = this.deps.open(
        `https://github.com/${stream.repository}/pull/${stream.number}`,
        () => {
          stream.attached = true;
          this.updateMetrics();
          stream.dirty = true;
          // On first attach start() performs the read; on reconnect retry it.
          if (stream.listener)
            void this.snapshot(stream).catch(() => this.retry(stream));
        },
        (input) => {
          if (
            !validGithubPreviewNotice(input, stream.repository, stream.number)
          )
            return;
          stream.dirty = true;
          void this.snapshot(stream).catch(() => this.retry(stream));
        },
        () => {
          stream.attached = false;
          this.deps.metrics.githubErrors++;
          this.updateMetrics();
        },
      );
      try {
        await listener.ready;
        if (stream.stopped) {
          await listener.stop();
          return;
        }
        stream.listener = listener;
        this.updateMetrics();
        await this.snapshot(stream);
        if (!stream.stopped && !stream.attached)
          throw new Error('GitHub stream detached during state read');
        stream.failures = 0;
        void listener.closed.then(() => {
          if (stream.listener === listener) stream.listener = undefined;
          stream.attached = false;
          this.updateMetrics();
          if (!stream.stopped) this.retry(stream);
        });
      } catch {
        await listener.stop();
        stream.listener = undefined;
        stream.attached = false;
        this.updateMetrics();
        this.retry(stream);
        throw new Error('GitHub source unavailable');
      }
    })().finally(() => {
      stream.starting = undefined;
    });
    return stream.starting;
  }

  private snapshot(stream: Stream): Promise<void> {
    stream.dirty = true;
    if (stream.reading) return stream.reading;
    stream.reading = (async () => {
      while (stream.dirty && !stream.stopped) {
        stream.dirty = false;
        const now = this.deps.now();
        if (!stream.checkpointLoaded) {
          const saved = this.deps.checkpoints?.get(stream.key);
          if (
            saved &&
            Date.parse(saved) > Date.parse(stream.since) &&
            Date.parse(saved) <= now
          )
            stream.since = saved;
          stream.checkpointLoaded = true;
        }
        const events = await readGithubPreviewEvents(
          this.deps.api,
          stream.repository,
          stream.number,
          stream.since,
          new Date(now).toISOString(),
        );
        if (stream.stopped) return;
        for (const event of events) {
          if (!this.deps.forwarder.reportGithub)
            throw new Error('GitHub publisher unavailable');
          const result = await this.deps.forwarder.reportGithub(event);
          if (!result.ok) throw new Error('GitHub event publication failed');
          for (const s of [...stream.subscriptions.values()]) {
            if (
              subscriptionMatches(s, event) &&
              (s.until === event.kind || event.kind === 'merged')
            )
              this.remove(s.id);
          }
        }
        // Cover the API's entire supported host clock skew plus timestamp
        // granularity. Router and delivery IDs deduplicate this overlap.
        const watermark = new Date(
          Math.max(
            Date.parse(stream.since),
            now - MAX_AGENT_EVENT_CLOCK_SKEW_MS - 1000,
          ),
        ).toISOString();
        this.deps.checkpoints?.set(stream.key, watermark);
        stream.since = watermark;
        stream.lastSnapshot = now;
        stream.failed = false;
        stream.failures = 0;
        this.deps.metrics.githubSnapshots++;
        this.updateMetrics();
      }
    })().finally(() => {
      stream.reading = undefined;
    });
    return stream.reading;
  }

  private retry(stream: Stream): void {
    if (stream.stopped || stream.retry) return;
    stream.failed = true;
    this.updateMetrics();
    this.deps.metrics.githubErrors++;
    this.deps.log({
      level: 'error',
      msg: 'GitHub preview source failed; retry scheduled',
      component: 'github-stream',
      stage: stream.listener ? 'snapshot' : 'attach',
    });
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(stream.failures++, 6));
    stream.retry = setTimeout(() => {
      stream.retry = undefined;
      if (stream.stopped) return;
      void (stream.listener ? this.snapshot(stream) : this.start(stream)).catch(
        () => this.retry(stream),
      );
    }, delay);
  }

  private remove(id: string): void {
    for (const stream of this.streams.values()) {
      if (!stream.subscriptions.delete(id) || stream.subscriptions.size)
        continue;
      stream.stopped = true;
      if (stream.retry) clearTimeout(stream.retry);
      void stream.listener?.stop();
      this.streams.delete(stream.key);
    }
    this.updateMetrics();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restoreRetry) clearTimeout(this.restoreRetry);
    const streams = [...this.streams.values()];
    for (const stream of streams) {
      stream.stopped = true;
      if (stream.retry) clearTimeout(stream.retry);
    }
    await Promise.all(
      streams.map(async (stream) => {
        await stream.listener?.stop();
        await stream.starting?.catch(() => undefined);
        await stream.reading?.catch(() => undefined);
      }),
    );
    this.streams.clear();
    this.updateMetrics();
  }
}
