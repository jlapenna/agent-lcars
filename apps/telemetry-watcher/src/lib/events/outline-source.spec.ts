import { createHash } from 'node:crypto';

import type { OutlineSourceJob, OutlineSourceReport } from '@agent-lcars/work';
import { describe, expect, it, vi } from 'vitest';

import {
  OutlineApiError,
  type OutlineSourceApi,
  outlineSourceApi,
} from './outline-client';
import { OutlineSource, type OutlineTextBaseline } from './outline-source';

const agent = '00000000-0000-4000-8000-000000000001';
const admin = '00000000-0000-4000-8000-000000000002';
const doc = '00000000-0000-4000-8000-000000000003';
const eventId = '00000000-0000-4000-8000-000000000004';
const comment = '00000000-0000-4000-8000-000000000005';
const fallback = '00000000-0000-4000-8000-000000000006';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const baseline = (
  text: string,
  updatedAt = '2026-11-26T00:59:00Z',
  origin: OutlineTextBaseline['origin'] = 'own',
): OutlineTextBaseline => ({ hash: hash(text), updatedAt, origin });
function fixture() {
  const api = {
    me: vi.fn(async () => ({ id: agent, role: 'member' })),
    user: vi.fn(async () => ({ id: admin, role: 'admin' })),
    document: vi.fn<OutlineSourceApi['document']>(async () => ({
      id: doc,
      createdBy: { id: agent },
      updatedBy: { id: agent },
      updatedAt: '2026-11-26T00:59:00Z',
      text: 'current Markdown',
    })),
    comment: vi.fn<OutlineSourceApi['comment']>(async () => undefined),
    createComment: vi.fn(async () => undefined),
  } satisfies OutlineSourceApi;
  const hashes = new Map<string, OutlineTextBaseline>();
  const report = vi.fn(async (_report: OutlineSourceReport) => undefined);
  const observe = vi.fn<
    (documentId: string, agentCreated: boolean) => Promise<void>
  >(async () => undefined);
  const sleep = vi.fn(async () => undefined);
  const source = new OutlineSource({
    api,
    agentUserId: agent,
    hashes: {
      get: (id) => hashes.get(id),
      put: (id, h) => {
        hashes.set(id, h);
      },
    },
    report,
    observe,
    sleep,
  });
  const job: Extract<OutlineSourceJob, { type: 'outline-event' }> = {
    type: 'outline-event',
    notice: {
      deliveryId: eventId,
      event: 'documents.update',
      actorId: admin,
      documentId: doc,
      objectId: doc,
      occurredAt: '2026-11-26T01:00:00Z',
    },
  };
  return { api, hashes, report, observe, sleep, source, job };
}

describe('Outline trusted API source', () => {
  it.each([403, 404])(
    'settles documents.info HTTP %s for intake and observation while refusing a fallback write',
    async (status) => {
      const f = fixture();
      const http = vi.fn<typeof fetch>().mockResolvedValue({
        ok: false,
        status,
      } as Response);
      f.api.document.mockImplementation(
        outlineSourceApi('test-key', http).document,
      );
      await f.source.handle(f.job);
      await f.source.handle({ type: 'outline-observe', documentId: doc });
      await expect(
        f.source.handle({
          type: 'outline-fallback',
          id: fallback,
          documentId: doc,
        }),
      ).rejects.toThrow('Outline fallback document is unavailable');
      expect(f.report).toHaveBeenCalledWith({
        noticeId: eventId,
        outcome: 'document-unavailable',
        agentCreated: false,
      });
      expect(f.observe).not.toHaveBeenCalled();
      expect(f.api.createComment).not.toHaveBeenCalled();
      expect(f.hashes.size).toBe(0);
    },
  );

  it.each([401, 429, 503])(
    'propagates documents.info HTTP %s for the host retry',
    async (status) => {
      const f = fixture();
      const http = vi.fn<typeof fetch>().mockResolvedValue({
        ok: false,
        status,
      } as Response);
      f.api.document.mockImplementation(
        outlineSourceApi('test-key', http).document,
      );
      await expect(f.source.handle(f.job)).rejects.toThrow(
        new OutlineApiError(status),
      );
      expect(f.report).not.toHaveBeenCalled();
      expect(f.observe).not.toHaveBeenCalled();
      expect(f.api.createComment).not.toHaveBeenCalled();
    },
  );
  it('coalesces reordered administrator updates after one authoritative latest-text report', async () => {
    const f = fixture();
    f.hashes.set(doc, baseline('old'));
    f.api.document.mockResolvedValue({
      id: doc,
      createdBy: { id: agent },
      updatedBy: { id: admin },
      updatedAt: '2026-11-26T01:03:00Z',
      text: 'latest admin edit',
    });
    await f.source.handle(f.job);
    f.job.notice.occurredAt = '2026-11-26T01:02:00Z';
    await f.source.handle(f.job);
    expect(f.report.mock.calls.map(([r]) => r.outcome)).toEqual([
      'accepted',
      'no-text-change',
    ]);
  });
  it('does not let a delayed own webhook absorb a newer administrator edit', async () => {
    const f = fixture();
    f.hashes.set(doc, baseline('old'));
    f.api.document.mockResolvedValue({
      id: doc,
      createdBy: { id: agent },
      updatedBy: { id: admin },
      updatedAt: '2026-11-26T01:01:00Z',
      text: 'new admin edit',
    });
    f.job.notice.actorId = agent;
    await f.source.handle(f.job);
    expect(f.hashes.get(doc)).toEqual(baseline('old'));
    f.job.notice.actorId = admin;
    f.job.notice.occurredAt = '2026-11-26T01:01:00Z';
    await f.source.handle(f.job);
    expect(f.report.mock.calls.map(([r]) => r.outcome)).toEqual([
      'own-change',
      'accepted',
    ]);
  });
  it('does not let a duplicate observation replace an existing edit baseline', async () => {
    const f = fixture();
    f.hashes.set(doc, baseline('old'));
    await f.source.handle({ type: 'outline-observe', documentId: doc });
    expect(f.hashes.get(doc)).toEqual(baseline('old'));
    await f.source.handle(f.job);
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'accepted' }),
    );
  });
  it('does not suppress an administrator event older than an already newer own baseline', async () => {
    const f = fixture();
    f.hashes.set(doc, baseline('current Markdown', '2026-11-26T01:02:00Z'));
    await f.source.handle(f.job);
    expect(f.report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'accepted' }),
    );
  });
  it('attests the creator and keeps only a hash when priming registration', async () => {
    const f = fixture();
    await f.source.handle({ type: 'outline-observe', documentId: doc });
    expect(f.observe).toHaveBeenCalledWith(doc, true);
    expect([...f.hashes.values()]).toEqual([
      baseline('current Markdown', undefined, 'observed'),
    ]);
    expect(f.report).not.toHaveBeenCalled();
  });
  it('refuses a key belonging to another user before reading any document', async () => {
    const f = fixture();
    f.api.me.mockResolvedValue({ id: admin, role: 'admin' });
    await expect(f.source.handle(f.job)).rejects.toThrow('identity mismatch');
    expect(f.api.document).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
  });
  it('does not route documents created by anyone else', async () => {
    const f = fixture();
    f.api.document.mockResolvedValue({
      id: doc,
      createdBy: { id: admin },
      updatedBy: { id: admin },
      updatedAt: '2026-11-26T00:59:00Z',
      text: 'private',
    });
    await f.source.handle(f.job);
    expect(f.report).toHaveBeenCalledWith({
      noticeId: eventId,
      outcome: 'foreign-document',
      agentCreated: false,
    });
    expect(f.api.user).not.toHaveBeenCalled();
  });
  it('requires the exact actor and its current admin role', async () => {
    const f = fixture();
    f.api.user.mockResolvedValue({ id: admin, role: 'member' });
    await f.source.handle(f.job);
    expect(f.report).toHaveBeenCalledWith({
      noticeId: eventId,
      outcome: 'untrusted-actor',
      agentCreated: true,
    });
    expect(f.hashes.size).toBe(0);
  });
  it('primes own document updates without routing them', async () => {
    const f = fixture();
    f.job.notice.actorId = agent;
    await f.source.handle(f.job);
    expect(f.report).toHaveBeenCalledWith({
      noticeId: eventId,
      outcome: 'own-change',
      agentCreated: true,
    });
    expect(f.api.user).not.toHaveBeenCalled();
    expect(f.sleep).not.toHaveBeenCalled();
    expect(f.hashes.get(doc)).toEqual(baseline('current Markdown'));
  });
  it('does not let an own comment hide a pending external edit', async () => {
    const f = fixture();
    f.hashes.set(doc, baseline('old'));
    f.job.notice.event = 'comments.create';
    f.job.notice.actorId = agent;
    await f.source.handle(f.job);
    expect(f.hashes.get(doc)).toEqual(baseline('old'));
  });
  it('suppresses a comment highlight that did not change Markdown', async () => {
    const f = fixture();
    f.hashes.set(doc, baseline('current Markdown'));
    await f.source.handle(f.job);
    expect(f.sleep).toHaveBeenCalledWith(8000);
    expect(f.report).toHaveBeenCalledWith({
      noticeId: eventId,
      outcome: 'no-text-change',
      agentCreated: true,
    });
  });
  it('reports changed Markdown and advances the hash after successful routing', async () => {
    const f = fixture();
    f.hashes.set(doc, baseline('old'));
    await f.source.handle(f.job);
    expect(f.report).toHaveBeenCalledWith({
      noticeId: eventId,
      outcome: 'accepted',
      agentCreated: true,
    });
    expect(f.hashes.get(doc)).toEqual(
      baseline('current Markdown', undefined, 'admin'),
    );
  });
  it('keeps the old hash on a failed report so redelivery cannot lose the edit', async () => {
    const f = fixture();
    f.hashes.set(doc, baseline('old'));
    f.report.mockRejectedValueOnce(new Error('transport'));
    await expect(f.source.handle(f.job)).rejects.toThrow('transport');
    expect(f.hashes.get(doc)).toEqual(baseline('old'));
    await f.source.handle(f.job);
    expect(f.report).toHaveBeenCalledTimes(2);
    expect(f.report.mock.calls[1][0]).toMatchObject({ outcome: 'accepted' });
  });
  it('does not read or forward comment text and never writes during normal source work', async () => {
    const f = fixture();
    f.job.notice.event = 'comments.create';
    f.job.notice.objectId = comment;
    await f.source.handle(f.job);
    expect(f.api.comment).not.toHaveBeenCalled();
    expect(f.api.createComment).not.toHaveBeenCalled();
    expect(JSON.stringify(f.report.mock.calls)).not.toContain(
      'current Markdown',
    );
  });
  it('replies in the actual parent thread with a stable comment UUID', async () => {
    const f = fixture();
    f.api.comment.mockImplementation(async (id) =>
      id === comment
        ? {
            id: comment,
            documentId: doc,
            parentCommentId: eventId,
            createdBy: { id: admin },
          }
        : undefined,
    );
    await f.source.handle({
      type: 'outline-fallback',
      id: fallback,
      documentId: doc,
      parentCommentId: comment,
    });
    expect(f.api.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: fallback,
        documentId: doc,
        parentCommentId: eventId,
      }),
    );
  });
  it('recovers an existing own fallback after a lost create response without writing twice', async () => {
    const f = fixture();
    f.api.comment.mockResolvedValue({
      id: fallback,
      documentId: doc,
      createdBy: { id: agent },
    });
    await f.source.handle({
      type: 'outline-fallback',
      id: fallback,
      documentId: doc,
    });
    expect(f.api.createComment).not.toHaveBeenCalled();
  });
});
