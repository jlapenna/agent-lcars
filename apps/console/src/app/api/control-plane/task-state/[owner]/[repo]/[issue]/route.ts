import { NextResponse } from 'next/server';

import { readAuthoritativeTaskState } from '@/lib/authoritative-task-state';
import { isControlPlaneRepository } from '@/lib/deployment';

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// #1183: `readAuthoritativeTaskState` is now a direct
// `@agent-lcars/orchestrator` store read, keyed by `{repo, issue}` alone
// (see that module's own doc comment) - a `repositoryId` query param is no
// longer meaningful here (the orchestrator's `TaskId` carries no such
// concept), so this route no longer requires or forwards one.
export async function GET(
  _request: Request,
  context: { params: Promise<{ owner: string; repo: string; issue: string }> },
): Promise<NextResponse> {
  const { owner, repo, issue: issueValue } = await context.params;
  const repository = `${owner}/${repo}`;
  const issue = positiveInteger(issueValue);
  if (!isControlPlaneRepository(repository) || issue === undefined) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const state = await readAuthoritativeTaskState({ repository, issue });
  return NextResponse.json(state ?? { error: 'Not found' }, {
    status: state ? 200 : 404,
    headers: { 'Cache-Control': 'no-store' },
  });
}
