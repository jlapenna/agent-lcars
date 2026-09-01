import { NextResponse } from 'next/server';

import { auth } from '@/auth';
import { ActionError, createQuickTask } from '@/lib/backend-actions';
import { resolveWatchedRepo } from '@/lib/github-client';
import { quickTaskIssueCreatorFor } from '@/lib/quick-task-author';
import {
  composeQuickTaskEvidenceIssueBody,
  composeQuickTaskIssueBody,
} from '@/lib/quick-task-evidence';
import {
  isQuickTaskEvidenceId,
  QUICK_TASK_EVIDENCE_MAX_INPUT_BYTES,
  QUICK_TASK_MULTIPART_FIELDS,
  QuickTaskEvidenceError,
  type QuickTaskEvidenceIntent,
} from '@/lib/quick-task-evidence-contract';
import { createQuickTaskEvidenceLifecycle } from '@/lib/quick-task-evidence-lifecycle';

function failure(error: unknown) {
  const status =
    error instanceof QuickTaskEvidenceError || error instanceof ActionError
      ? error.statusCode
      : 500;
  const message =
    error instanceof Error ? error.message : 'Quick Task submission failed';
  return NextResponse.json({ error: message }, { status });
}

function parseIntent(
  value: FormDataEntryValue | null,
): QuickTaskEvidenceIntent {
  if (typeof value !== 'string')
    throw new QuickTaskEvidenceError(400, 'Quick Task intent is required');
  try {
    const intent = JSON.parse(value) as QuickTaskEvidenceIntent;
    if (
      !intent ||
      typeof intent.requestId !== 'string' ||
      !intent.repository ||
      typeof intent.repository.owner !== 'string' ||
      typeof intent.repository.name !== 'string' ||
      typeof intent.pipeline !== 'string' ||
      typeof intent.description !== 'string' ||
      !intent.source ||
      typeof intent.source.route !== 'string' ||
      typeof intent.source.identities !== 'string' ||
      typeof intent.source.capturedAt !== 'string'
    )
      throw new Error();
    return intent;
  } catch {
    throw new QuickTaskEvidenceError(400, 'Quick Task intent is invalid');
  }
}

function parseMultipart(form: FormData): {
  intent: FormDataEntryValue;
  evidence: FormDataEntryValue | undefined;
} {
  const entries = Array.from(form.entries());
  const allowed = new Set<string>(Object.values(QUICK_TASK_MULTIPART_FIELDS));
  if (entries.some(([name]) => !allowed.has(name)))
    throw new QuickTaskEvidenceError(
      400,
      'Quick Task multipart fields are invalid',
    );
  const intents = entries
    .filter(([name]) => name === QUICK_TASK_MULTIPART_FIELDS.intent)
    .map(([, value]) => value);
  const evidence = entries
    .filter(([name]) => name === QUICK_TASK_MULTIPART_FIELDS.evidence)
    .map(([, value]) => value);
  if (intents.length !== 1 || evidence.length > 1)
    throw new QuickTaskEvidenceError(
      400,
      'Quick Task multipart fields are invalid',
    );
  return { intent: intents[0], evidence: evidence[0] };
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.isAdmin)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    if (!session.user.login) {
      throw new ActionError('Authenticated GitHub login is required', 401);
    }
    const form = await request.formData();
    const multipart = parseMultipart(form);
    const intent = parseIntent(multipart.intent);
    const file = multipart.evidence;
    if (file !== undefined && typeof file === 'string')
      throw new QuickTaskEvidenceError(400, 'Evidence file is invalid');
    if (file && file.size > QUICK_TASK_EVIDENCE_MAX_INPUT_BYTES)
      throw new QuickTaskEvidenceError(413, 'Evidence exceeds the input limit');
    const evidenceId = intent.evidenceId;
    if (file && (!evidenceId || !isQuickTaskEvidenceId(evidenceId)))
      throw new QuickTaskEvidenceError(
        400,
        'A valid evidence identifier is required',
      );
    if (!file && intent.evidenceId)
      throw new QuickTaskEvidenceError(
        400,
        'Evidence identifier requires an evidence file',
      );
    const repository = resolveWatchedRepo(intent.repository);
    if (file && !evidenceId) {
      throw new QuickTaskEvidenceError(
        400,
        'A valid evidence identifier is required',
      );
    }
    const body = file
      ? composeQuickTaskEvidenceIssueBody(
          { description: intent.description, source: intent.source },
          repository,
          process.env['AUTH_URL'] ?? '',
          evidenceId ?? '',
        )
      : composeQuickTaskIssueBody(
          {
            description: intent.description,
            screenshot: '',
            source: intent.source,
          },
          repository,
        );
    const lifecycle = file
      ? {
          intent,
          hook: await createQuickTaskEvidenceLifecycle({
            bucket: process.env['QUICK_TASK_EVIDENCE_BUCKET'] ?? '',
            evidenceId: evidenceId ?? '',
            bytes: new Uint8Array(await file.arrayBuffer()),
          }),
        }
      : undefined;
    const receipt = await createQuickTask(
      {
        requestId: intent.requestId,
        repository,
        pipeline: intent.pipeline as never,
        description: body,
        actorLogin: session.user.login,
      },
      lifecycle,
      quickTaskIssueCreatorFor(session),
    );
    return NextResponse.json(receipt, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
