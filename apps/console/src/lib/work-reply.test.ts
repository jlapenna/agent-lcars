import {
  decidedRun,
  isRefusal,
  MemoryScheduleStore,
  MemoryStore,
  Orchestrator,
} from '@agent-lcars/orchestrator';
import type { SessionDoc } from '@agent-lcars/telemetry';
import { describe, expect, it } from 'vitest';

import type { WorkContext } from './work-mint';
import { requestReply, selectResumeSession } from './work-reply';

/** A minimal, valid `IssueAgentSessionDoc` -- every field the type
 *  requires, none of the ones it doesn't. Mirrors `work-router.test.ts`'s
 *  own `sessionDoc` fixture helper. */
function session(over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    source: 'issue-agent',
    sessionId: 's1',
    agent: 'claude-code',
    liveness: 'ended',
    startedAt: '2026-09-04T00:00:00.000Z',
    lastActivityAt: '2026-09-04T00:00:00.000Z',
    turns: 1,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    repo: { owner: 'octo', name: 'example' },
    intentId: 'work:01ABC/r1',
    transcriptGcsUri: 'gs://b/runs/work:01ABC%2Fr1/claude-code/s1.jsonl',
    renderable: true,
    ...over,
  } as SessionDoc;
}

describe('selectResumeSession', () => {
  const runIds = new Set(['work:01ABC/r1', 'work:01ABC/r2']);

  it('picks the newest session belonging to one of the item runs', () => {
    const older = session({
      sessionId: 'old',
      lastActivityAt: '2026-09-01T00:00:00.000Z',
    });
    const newer = session({
      sessionId: 'new',
      lastActivityAt: '2026-09-03T00:00:00.000Z',
    });
    expect(
      selectResumeSession([older, newer], runIds, 'claude')?.sessionId,
    ).toBe('new');
  });

  it('ignores a session from another item', () => {
    expect(
      selectResumeSession(
        [session({ intentId: 'work:01OTHER/r1' })],
        runIds,
        'claude',
      ),
    ).toBeUndefined();
  });

  it('ignores a session with no archived transcript', () => {
    expect(
      selectResumeSession(
        [session({ transcriptGcsUri: undefined, renderable: undefined })],
        runIds,
        'claude',
      ),
    ).toBeUndefined();
  });

  it('ignores a session whose agent does not match the pipeline', () => {
    expect(
      selectResumeSession([session({ agent: 'codex' })], runIds, 'claude'),
    ).toBeUndefined();
    expect(selectResumeSession([session({})], runIds, 'codex')).toBeUndefined();
  });

  it('selects a codex session for a codex reply', () => {
    const doc = session({ agent: 'codex' });
    expect(selectResumeSession([doc], runIds, 'codex')?.sessionId).toBe(
      doc.sessionId,
    );
  });

  it('still refuses to cross pipelines', () => {
    expect(
      selectResumeSession([session({ agent: 'codex' })], runIds, 'claude'),
    ).toBeUndefined();
    expect(
      selectResumeSession([session({ agent: 'claude-code' })], runIds, 'codex'),
    ).toBeUndefined();
  });
});

// Matches vitest-setup.ts's default AGENT_LCARS_CONTROL_PLANE_REPOSITORIES
// (and its paired AGENT_LCARS_WATCHED_REPOS), so no extra config is needed
// to clear `forbiddenReason`'s repository check.
const REPO = 'jlapenna/agent-lcars';
const NOW = '2026-09-04T00:00:00.000Z';
const ANCHOR = { repo: REPO, issue: 42 };
const RUN_1 = `${REPO}#42/r1`;

const spec = {
  title: 'Fix the widget',
  description: 'A GitHub-anchored item.',
  pipeline: 'claude',
  target: { repo: REPO },
};

const operator = {
  principal: 'github:jlapenna',
  subject: 'github:jlapenna',
  scopes: new Set(['work.operator'] as const),
  pipelines: ['claude'],
  via: 'session' as const,
};

function fixture(over: Partial<WorkContext> = {}) {
  const store = new MemoryStore();
  const orchestrator = new Orchestrator(store, { now: () => NOW });
  const context: WorkContext = {
    principal: operator,
    runtime: {
      store,
      orchestrator,
      drain: async () => ({ dispatched: [], reported: [], failed: [] }),
    } as unknown as WorkContext['runtime'],
    sessionsFor: async () => [],
    getSessionDoc: async () => undefined,
    sessionDocsForRuns: async () => [],
    maxLiveRuns: 4,
    scheduleStore: new MemoryScheduleStore(),
    grants: () => [],
    now: () => new Date(NOW),
    ...over,
  };
  return { store, orchestrator, context };
}

/** Admits `ANCHOR` with one finished, parked run (`RUN_1`) -- the
 *  precondition every "replies to a GitHub-anchored task" case below
 *  shares. */
async function parkGithubTask(orchestrator: Orchestrator): Promise<void> {
  const outcome = await orchestrator.request({
    taskId: ANCHOR,
    requestId: 'first',
    pipeline: 'claude',
    work: { origin: { principal: 'github:jlapenna', channel: 'github' }, spec },
  });
  if (isRefusal(outcome)) throw new Error('unexpected refusal in fixture');
  await orchestrator.report(decidedRun(outcome).runId, {
    ok: true,
    summary: 'park',
  });
}

/** A minimal, valid `IssueAgentSessionDoc`, mirroring this file's own
 *  `session()` helper above. */
function sessionDoc(over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    source: 'issue-agent',
    sessionId: 'sess-1',
    agent: 'claude-code',
    liveness: 'ended',
    startedAt: NOW,
    lastActivityAt: NOW,
    turns: 1,
    toolCallCounts: {},
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    deliverables: { prNumbers: [], commitShas: [] },
    ...over,
  } as SessionDoc;
}

describe('requestReply', () => {
  it('replies to a GitHub-anchored task', async () => {
    const { store, orchestrator, context } = fixture({
      sessionDocsForRuns: async () => [
        sessionDoc({
          sessionId: 'sess-1',
          intentId: RUN_1,
          transcriptGcsUri: 'gs://b/runs/x/claude-code/sess-1.jsonl',
        }),
      ],
    });
    await parkGithubTask(orchestrator);

    const outcome = await requestReply(context, {
      task: ANCHOR,
      text: 'Use Firestore.',
      channel: 'github',
      principal: 'github:jlapenna',
      ref: 'https://github.com/octo/example/issues/42#issuecomment-1',
    });

    expect(outcome).toMatchObject({ ok: true, resumed: true });
    const runId = (outcome as { ok: true; runId: string }).runId;
    const run = await store.readRun(runId);
    expect(run?.params).toMatchObject({
      mode: 'reply',
      reply: 'Use Firestore.',
      replyChannel: 'github',
      replyPrincipal: 'github:jlapenna',
    });
  });

  it('refuses a reply for a task that does not exist', async () => {
    const { context } = fixture();

    await expect(
      requestReply(context, {
        task: { repo: REPO, issue: 999 },
        text: 'hi',
        channel: 'github',
        principal: 'github:jlapenna',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});
