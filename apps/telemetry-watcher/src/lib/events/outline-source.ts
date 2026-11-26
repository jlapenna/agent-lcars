import { createHash } from 'node:crypto';

import type { OutlineSourceJob, OutlineSourceReport } from '@agent-lcars/work';

import type { OutlineSourceApi } from './outline-client';

export interface OutlineTextBaseline {
  readonly hash: string;
  readonly updatedAt: string;
  readonly origin: 'own' | 'observed' | 'admin';
}
export interface OutlineTextHashes {
  get(documentId: string): OutlineTextBaseline | undefined;
  put(documentId: string, baseline: OutlineTextBaseline): void;
}
export interface OutlineSourceDependencies {
  readonly api: OutlineSourceApi;
  /** The shared Agents account, configured independently of its API key. */
  readonly agentUserId: string;
  readonly hashes: OutlineTextHashes;
  readonly sleep: (ms: number) => Promise<void>;
  readonly report: (report: OutlineSourceReport) => Promise<void>;
  readonly observe: (
    documentId: string,
    agentCreated: boolean,
  ) => Promise<void>;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const OUTLINE_EDIT_DEBOUNCE_MS = 8_000;
/** Bound complete API/document/report jobs within the existing native unit. */
export const OUTLINE_SOURCE_CONCURRENCY = 2;
export const OUTLINE_FALLBACK_COMMENT =
  'The agent session subscribed to this document has ended or cannot receive its notice, so this update was not delivered to that session. Ask an agent to pick it up from here.';

/** Serializes a document's baseline and changes, including own publications.
 * Only hashes and revision metadata survive the read. No document text is logged,
 * stored in LCARS, or used to construct a session notice. */
export class OutlineSource {
  private readonly queues = new Map<string, Promise<void>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly deps: OutlineSourceDependencies) {}

  async handle(job: OutlineSourceJob): Promise<void> {
    const documentId =
      job.type === 'outline-event' ? job.notice.documentId : job.documentId;
    const previous = this.queues.get(documentId) ?? Promise.resolve();
    const next = previous.then(
      () => this.limited(job),
      () => this.limited(job),
    );
    const settled = next.catch(() => undefined);
    this.queues.set(documentId, settled);
    try {
      await next;
    } finally {
      if (this.queues.get(documentId) === settled)
        this.queues.delete(documentId);
    }
  }

  private async limited(job: OutlineSourceJob): Promise<void> {
    if (this.running < OUTLINE_SOURCE_CONCURRENCY) this.running++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      await this.handleOne(job);
    } finally {
      // Transfer the occupied slot directly; a new arrival cannot jump ahead.
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  private async handleOne(job: OutlineSourceJob): Promise<void> {
    const { deps } = this;
    const me = await deps.api.me();
    if (me.id !== deps.agentUserId)
      throw new Error('Outline source identity mismatch');
    const id =
      job.type === 'outline-event' ? job.notice.documentId : job.documentId;
    const edit =
      job.type === 'outline-event' &&
      (job.notice.event === 'documents.update' ||
        job.notice.event === 'revisions.create');
    // A burst settles before the authoritative text read; later queued jobs
    // see the same saved hash and produce no duplicate edit notice.
    if (edit && job.notice.actorId !== me.id)
      await deps.sleep(OUTLINE_EDIT_DEBOUNCE_MS);
    const document = await deps.api.document(id);
    if (document && document.id !== id)
      throw new Error('Outline document identity mismatch');
    if (!document) {
      if (job.type === 'outline-fallback')
        throw new Error('Outline fallback document is unavailable');
      // Unavailable is not creator evidence. A later registration can recheck.
      if (job.type === 'outline-event')
        await deps.report({
          noticeId: job.notice.deliveryId,
          outcome: 'document-unavailable',
          agentCreated: false,
        });
      return;
    }
    const agentCreated = document.createdBy.id === me.id;

    if (job.type === 'outline-observe') {
      await deps.observe(id, agentCreated);
      // A repeated setup job must not overwrite the baseline of an already
      // listening session with an administrator's newer, pending edit.
      if (agentCreated && !deps.hashes.get(id))
        deps.hashes.put(id, {
          hash: hash(document.text),
          updatedAt: document.updatedAt,
          origin: 'observed',
        });
      return;
    }
    if (job.type === 'outline-fallback') {
      if (!agentCreated)
        throw new Error('Outline fallback document is not agent-created');
      const existing = await deps.api.comment(job.id);
      if (existing) {
        if (existing.documentId !== id || existing.createdBy.id !== me.id)
          throw new Error('Outline fallback comment identity mismatch');
        return;
      }
      let parentCommentId: string | undefined;
      if (job.parentCommentId) {
        const parent = await deps.api.comment(job.parentCommentId);
        if (!parent || parent.documentId !== id)
          throw new Error('Outline fallback parent is unavailable');
        parentCommentId = parent.parentCommentId ?? parent.id;
      }
      // Outline accepts a caller-generated comment UUID. A lost response can
      // be recovered by comments.info with this same id before writing again.
      await deps.api.createComment({
        id: job.id,
        documentId: id,
        ...(parentCommentId ? { parentCommentId } : {}),
        text: OUTLINE_FALLBACK_COMMENT,
      });
      return;
    }

    const { notice } = job;
    const report = async (outcome: OutlineSourceReport['outcome']) =>
      deps.report({ noticeId: notice.deliveryId, outcome, agentCreated });
    if (!agentCreated) {
      await report('foreign-document');
      return;
    }
    const textHash = hash(document.text);
    if (notice.actorId === me.id) {
      await report('own-change');
      // Webhooks and API reads can be reordered. Only prime the own revision
      // the notice could describe, never a newer document read after it.
      if (
        edit &&
        document.updatedBy.id === me.id &&
        Date.parse(document.updatedAt) <= Date.parse(notice.occurredAt)
      )
        deps.hashes.put(id, {
          hash: textHash,
          updatedAt: document.updatedAt,
          origin: 'own',
        });
      return;
    }
    const actor = await deps.api.user(notice.actorId);
    if (actor.id !== notice.actorId || actor.role.toLowerCase() !== 'admin') {
      await report('untrusted-actor');
      return;
    }
    const baseline = deps.hashes.get(id);
    // A successful external report already represents the latest text of
    // that admin burst, even when its remaining webhooks arrive out of order.
    // An own/observation baseline cannot make that claim about older edits.
    if (
      edit &&
      baseline?.hash === textHash &&
      (baseline.origin === 'admin' ||
        Date.parse(notice.occurredAt) >= Date.parse(baseline.updatedAt))
    ) {
      await report('no-text-change');
      return;
    }
    await report('accepted');
    // Advance only after the console accepted the report. API or routing
    // failure leaves the hash unchanged so Pub/Sub retry cannot lose an edit.
    if (edit)
      deps.hashes.put(id, {
        hash: textHash,
        updatedAt: document.updatedAt,
        origin: 'admin',
      });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }
}
