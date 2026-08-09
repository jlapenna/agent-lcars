import { NextResponse } from 'next/server';

import { readAuthoritativeTaskState } from '@/lib/authoritative-task-state';
import { controlPlaneRepository } from '@/lib/deployment';

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ owner: string; repo: string; issue: string }> },
): Promise<NextResponse> {
  const { owner, repo, issue: issueValue } = await context.params;
  const repository = `${owner}/${repo}`;
  const issue = positiveInteger(issueValue);
  const repositoryId = positiveInteger(
    new URL(request.url).searchParams.get('repositoryId') ?? '',
  );
  if (
    repository !== controlPlaneRepository() ||
    issue === undefined ||
    repositoryId === undefined
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const state = await readAuthoritativeTaskState({
    repositoryId,
    repository,
    issue,
  });
  return NextResponse.json(state ?? { error: 'Not found' }, {
    status: state ? 200 : 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}
