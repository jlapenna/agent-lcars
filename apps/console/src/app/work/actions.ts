'use server';

import { createServerFunctionable } from '@orpc/next';

import { auth, githubAccessTokenFor } from '@/auth';
import {
  createGithubUserClient,
  resolveWatchedRepo,
} from '@/lib/github-client';
import {
  composeQuickTaskEvidenceIssueBody,
  deriveQuickTaskTitle,
} from '@/lib/quick-task-evidence';
import type { QuickTaskEvidenceIntent } from '@/lib/quick-task-evidence-contract';
import { createQuickTaskEvidenceLifecycle } from '@/lib/quick-task-evidence-lifecycle';
import { workRouter } from '@/lib/work-router';

import { context } from './context';

const functionable = createServerFunctionable({ context });

const createItemFn = functionable(workRouter.create);
const cancelItemFn = functionable(workRouter.cancel);
const redispatchItemFn = functionable(workRouter.redispatch);
const replyItemFn = functionable(workRouter.reply);
const getItemFn = functionable(workRouter.get);
const listItemsFn = functionable(workRouter.list);

/**
 * One-line forwarders, not a behavioral difference from the five
 * procedures above: this repo's `fleet/use-server-actions-only` lint rule
 * requires every export of a file-level 'use server' module to be a
 * literal async function (so Next's Server Actions transform can find and
 * register it) - `functionable(workRouter.x)`'s return value is a call
 * expression's result, which the rule refuses to export directly.
 */
export async function createItem(input: Parameters<typeof createItemFn>[0]) {
  return createItemFn(input);
}

/** Native Work creation with an optional screenshot. The evidence keeps its
 * historical authenticated read URL and immutable binding, while the task is
 * minted exclusively through the canonical Work procedure. */
export async function createItemWithEvidence(form: FormData) {
  const raw = form.get('intent');
  const file = form.get('evidence');
  if (typeof raw !== 'string' || !(file instanceof File)) {
    return [
      { code: 'BAD_REQUEST', message: 'Work evidence is invalid' },
      undefined,
    ] as const;
  }
  let intent: QuickTaskEvidenceIntent & { workId?: string };
  try {
    intent = JSON.parse(raw) as QuickTaskEvidenceIntent & { workId?: string };
  } catch {
    return [
      { code: 'BAD_REQUEST', message: 'Work evidence intent is invalid' },
      undefined,
    ] as const;
  }
  const session = await auth();
  const token = session ? githubAccessTokenFor(session) : undefined;
  if (!token || !intent.workId || !intent.evidenceId) {
    return [
      {
        code: 'UNAUTHORIZED',
        message: 'Work evidence requires an authenticated GitHub session',
      },
      undefined,
    ] as const;
  }
  const repository = resolveWatchedRepo(intent.repository);
  const { data: repo } = await createGithubUserClient(token).rest.repos.get({
    owner: repository.owner,
    repo: repository.name,
  });
  const visibility = repo.visibility;
  if (
    visibility !== 'public' &&
    visibility !== 'private' &&
    visibility !== 'internal'
  ) {
    return [
      { code: 'BAD_REQUEST', message: 'Repository visibility is unavailable' },
      undefined,
    ] as const;
  }
  const lifecycle = await createQuickTaskEvidenceLifecycle({
    bucket: process.env['QUICK_TASK_EVIDENCE_BUCKET'] ?? '',
    evidenceId: intent.evidenceId,
    bytes: new Uint8Array(await file.arrayBuffer()),
    createdAt: intent.source.capturedAt,
  });
  const evidence = await lifecycle.prepare({
    intent,
    repositoryId: repo.id,
    visibility,
  });
  const result = await createItemFn({
    id: intent.workId,
    spec: {
      title: deriveQuickTaskTitle(intent.description),
      description: composeQuickTaskEvidenceIssueBody(
        { description: intent.description, source: intent.source },
        repository,
        process.env['AUTH_URL'] ?? '',
        intent.evidenceId,
      ),
      pipeline: intent.pipeline as 'claude' | 'codex' | 'opencode',
      target: { repo: `${repository.owner}/${repository.name}` },
    },
  });
  if (result[0] && result[0].code !== 'TOO_MANY_REQUESTS' && evidence) {
    await lifecycle.rollbackDefinitiveCreateFailure(evidence);
  }
  return result;
}
export async function cancelItem(input: Parameters<typeof cancelItemFn>[0]) {
  return cancelItemFn(input);
}
export async function redispatchItem(
  input: Parameters<typeof redispatchItemFn>[0],
) {
  return redispatchItemFn(input);
}
export async function replyToWorkItem(
  input: Parameters<typeof replyItemFn>[0],
) {
  return replyItemFn(input);
}
export async function getItem(input: Parameters<typeof getItemFn>[0]) {
  return getItemFn(input);
}
export async function listItems(input: Parameters<typeof listItemsFn>[0]) {
  return listItemsFn(input);
}
