import type { DeliveredStore } from './delivered-store';
import {
  type AgentEventDelivery,
  parseAgentEventDelivery,
} from './delivery-message';
import type { HerdrSendResult } from './herdr-core-send';
import type { DeliveryMetrics, DeliveryOutcome } from './metrics';
import type { TargetCheck, UndeliverableReason } from './terminal-target';

/** One message from the host's subscription, as the agent needs it. */
export interface InboundDelivery {
  readonly attributes: Readonly<Record<string, string>>;
  readonly data: Buffer;
  /** When the router published it. */
  readonly publishTime: Date;
  /** Acks; resolves once Pub/Sub confirmed it (exactly-once delivery). */
  readonly ack: () => Promise<void>;
  /** Releases it back to Pub/Sub for a later delivery attempt. */
  readonly nack: () => Promise<void>;
}

/**
 * Where an undeliverable delivery goes next. The source's fallback (a reply
 * in an Outline thread, say) is wired in a later slice; until then this
 * only records it. A failure here releases the message for retry, preserving
 * the source's fallback contract across a lost response or transport failure.
 */
export type UndeliverableHandler = (
  delivery: AgentEventDelivery,
  reason: UndeliverableReason,
) => Promise<void>;

/** A structured log record. Never carries notice text. */
export type DeliveryLog = (record: Record<string, unknown>) => void;

export interface DeliveryAgentOptions {
  /** How long to hold one delivery while its session is busy before
   * releasing it back to Pub/Sub. Within the subscriber's lease extension. */
  readonly holdMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  /** How long a typed notice has to start a turn. */
  readonly confirmMs: number;
  readonly confirmPollMs: number;
}

export const DEFAULT_DELIVERY_OPTIONS: DeliveryAgentOptions = {
  holdMs: 10 * 60 * 1000,
  initialBackoffMs: 2_000,
  maxBackoffMs: 30_000,
  confirmMs: 15_000,
  confirmPollMs: 1_000,
};

export interface DeliveryAgentDependencies {
  readonly host: string;
  readonly checkTarget: (sessionId: string) => Promise<TargetCheck>;
  readonly send: (address: string, text: string) => Promise<HerdrSendResult>;
  readonly delivered: DeliveredStore;
  readonly onUndeliverable: UndeliverableHandler;
  readonly metrics: DeliveryMetrics;
  readonly log: DeliveryLog;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly options?: Partial<DeliveryAgentOptions>;
}

type Attempt =
  | { readonly kind: 'delivered'; readonly attempt: number }
  | { readonly kind: 'undeliverable'; readonly reason: UndeliverableReason }
  | { readonly kind: 'retry'; readonly why: string };

/** A turn counts as started once the terminal's turn advanced or it went
 * to work, or to a dialog, which only a turn in progress opens. */
function turnStarted(before: number, check: TargetCheck): boolean {
  if (check.kind === 'ready') return check.turn > before;
  if (check.kind === 'busy') {
    return (
      check.turn > before ||
      check.status === 'working' ||
      check.status === 'blocked'
    );
  }
  return false;
}

/**
 * Delivers one host's event notices to its sessions.
 *
 * For each message: validate it; drop a delivery id already finished;
 * wait, holding the message, until the target terminal still runs the
 * subscribing session and that session is at its prompt; type the notice
 * with `hc send`; confirm a turn started within `confirmMs`, typing once
 * more if it did not; then ack. A session that stays busy past `holdMs`
 * releases the message back to Pub/Sub. A session that is gone, or a
 * terminal that runs something else, makes the delivery undeliverable:
 * acked, recorded and handed to the fallback.
 *
 * Deliveries to one session are serialized, so two notices are never typed
 * over each other; deliveries to different sessions run concurrently.
 */
export class DeliveryAgent {
  private readonly options: DeliveryAgentOptions;
  private readonly sessionQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: DeliveryAgentDependencies) {
    this.options = { ...DEFAULT_DELIVERY_OPTIONS, ...deps.options };
  }

  async handle(message: InboundDelivery): Promise<DeliveryOutcome> {
    const { metrics } = this.deps;
    metrics.inFlight += 1;
    try {
      return await this.handleOne(message);
    } finally {
      metrics.inFlight -= 1;
    }
  }

  private async handleOne(message: InboundDelivery): Promise<DeliveryOutcome> {
    const parsed = parseAgentEventDelivery(message, this.deps.host);
    if (!parsed.ok) {
      this.deps.log({
        level: 'warn',
        msg: 'invalid delivery',
        outcome: 'invalid',
        reason: parsed.reason,
      });
      return this.finish(message, 'invalid');
    }
    const delivery = parsed.value;
    if (!delivery.noticeMatches) {
      this.deps.log({
        level: 'warn',
        msg: 'router notice differs from the local rendering; typing the local one',
        ...fields(delivery),
      });
    }
    if (this.deps.delivered.has(delivery.deliveryId)) {
      this.deps.log({
        level: 'info',
        msg: 'duplicate delivery',
        outcome: 'duplicate',
        ...fields(delivery),
      });
      return this.finish(message, 'duplicate');
    }
    return this.serialized(delivery.sessionId, () =>
      this.deliver(message, delivery),
    );
  }

  private async serialized<T>(
    sessionId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.sessionQueues.set(sessionId, settled);
    try {
      return await next;
    } finally {
      if (this.sessionQueues.get(sessionId) === settled) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }

  private async deliver(
    message: InboundDelivery,
    delivery: AgentEventDelivery,
  ): Promise<DeliveryOutcome> {
    const { deps } = this;
    // Another message with this id may have finished while this one waited
    // its turn behind the session's queue.
    if (deps.delivered.has(delivery.deliveryId)) {
      deps.log({
        level: 'info',
        msg: 'duplicate delivery',
        outcome: 'duplicate',
        ...fields(delivery),
      });
      return this.finish(message, 'duplicate');
    }
    let result: Attempt;
    try {
      result = await this.attempt(delivery);
    } catch (error) {
      result = {
        kind: 'retry',
        why: error instanceof Error ? error.name : 'error',
      };
    }

    if (result.kind === 'retry') {
      deps.log({
        level: 'info',
        msg: 'released for a later attempt',
        outcome: 'retried',
        reason: result.why,
        ...fields(delivery),
      });
      deps.metrics.count('retried');
      await settle(message.nack, deps.log, 'nack');
      return 'retried';
    }

    if (result.kind === 'delivered') {
      deps.delivered.record(delivery.deliveryId, deps.now());
      const latencySeconds =
        (deps.now() - message.publishTime.getTime()) / 1000;
      deps.metrics.observeLatency(latencySeconds);
      deps.log({
        level: 'info',
        msg: 'delivered',
        outcome: 'delivered',
        attempt: result.attempt,
        latencySeconds,
        ...fields(delivery),
      });
      return this.finish(message, 'delivered');
    }

    deps.metrics.countUndeliverable(result.reason);
    deps.log({
      level: 'info',
      msg: 'undeliverable',
      outcome: 'undeliverable',
      reason: result.reason,
      ...fields(delivery),
    });
    try {
      await deps.onUndeliverable(delivery, result.reason);
    } catch (error) {
      deps.log({
        level: 'error',
        msg: 'undeliverable fallback failed',
        error: error instanceof Error ? error.name : 'error',
        ...fields(delivery),
      });
      deps.metrics.count('retried');
      await settle(message.nack, deps.log, 'nack');
      return 'retried';
    }
    deps.delivered.record(delivery.deliveryId, deps.now());
    return this.finish(message, 'undeliverable');
  }

  /** Waits for the session, types the notice and confirms the turn. */
  private async attempt(delivery: AgentEventDelivery): Promise<Attempt> {
    const { deps, options } = this;
    const deadline = deps.now() + options.holdMs;
    let backoff = options.initialBackoffMs;
    let typed = 0;
    for (;;) {
      const check = await deps.checkTarget(delivery.sessionId);
      if (check.kind === 'gone') {
        return { kind: 'undeliverable', reason: check.reason };
      }
      if (check.kind === 'ready') {
        const sent = await deps.send(check.address, delivery.notice);
        if (sent.kind === 'gone') {
          return { kind: 'undeliverable', reason: 'terminal-gone' };
        }
        if (sent.kind === 'failed') {
          return { kind: 'retry', why: `send-${sent.error}` };
        }
        if (sent.kind === 'sent') {
          typed += 1;
          if (await this.confirmTurn(delivery.sessionId, check.turn, sent)) {
            return { kind: 'delivered', attempt: typed };
          }
          deps.log({
            level: 'warn',
            msg: 'notice did not start a turn',
            attempt: typed,
            ...fields(delivery),
          });
          // A duplicate notice beats a lost one: type it once more.
          if (typed >= 2) {
            return { kind: 'undeliverable', reason: 'turn-not-started' };
          }
          continue;
        }
        // Refused: the session went busy between the check and the send.
      }
      // Busy, refused, or herdr-core did not answer: wait and look again.
      if (deps.now() + backoff > deadline) {
        return {
          kind: 'retry',
          why: check.kind === 'busy' ? `busy-${check.status}` : check.kind,
        };
      }
      await deps.sleep(backoff);
      backoff = Math.min(backoff * 2, options.maxBackoffMs);
    }
  }

  private async confirmTurn(
    sessionId: string,
    turnBefore: number,
    sent: Extract<HerdrSendResult, { kind: 'sent' }>,
  ): Promise<boolean> {
    if (sent.started === true) return true;
    const { deps, options } = this;
    const deadline = deps.now() + options.confirmMs;
    for (;;) {
      const check = await deps.checkTarget(sessionId);
      if (turnStarted(turnBefore, check)) return true;
      if (check.kind === 'gone' || deps.now() >= deadline) return false;
      await deps.sleep(options.confirmPollMs);
    }
  }

  private async finish(
    message: InboundDelivery,
    outcome: Exclude<DeliveryOutcome, 'retried'>,
  ): Promise<DeliveryOutcome> {
    this.deps.metrics.count(outcome);
    await settle(message.ack, this.deps.log, 'ack');
    return outcome;
  }
}

/** Fields a log line may carry about a delivery: LCARS-generated ids, the
 * event's key and kind. Never the notice. */
function fields(delivery: AgentEventDelivery): Record<string, unknown> {
  return {
    deliveryId: delivery.deliveryId,
    subscriptionId: delivery.subscriptionId,
    sessionId: delivery.sessionId,
    key: delivery.event.key,
    kind: delivery.event.kind,
  };
}

/** An ack that fails leaves the delivery to come back, where the delivered
 * record drops it; a nack that fails expires on its own. */
async function settle(
  action: () => Promise<void>,
  log: DeliveryLog,
  name: 'ack' | 'nack',
): Promise<void> {
  try {
    await action();
  } catch (error) {
    log({
      level: 'warn',
      msg: `${name} failed`,
      error: error instanceof Error ? error.name : 'error',
    });
  }
}
