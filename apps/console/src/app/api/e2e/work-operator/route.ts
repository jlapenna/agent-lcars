import { isE2eTesting, isOnGoogleCloud } from '@agent-lcars/util-server';
import { NextResponse } from 'next/server';

import { workGrants } from '@/lib/work-grants';

/** Revoke/restore only the fixed hermetic operator's grant. An existing
 * encrypted session survives, so the browser can prove per-operation checks.
 * Never available on a deployed service, even with E2E_TESTING set. */
export async function POST(request: Request) {
  if (!isE2eTesting() || isOnGoogleCloud()) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const { revoked } = (await request.json()) as { revoked?: unknown };
  if (typeof revoked !== 'boolean') {
    return NextResponse.json(
      { error: 'Expected revoked boolean' },
      { status: 400 },
    );
  }
  const grants = workGrants().filter(
    (grant) => grant.principal !== 'user:e2e-work-operator',
  );
  if (!revoked) {
    grants.push({
      principal: 'user:e2e-work-operator',
      subjects: ['github:e2e-work-operator'],
      pipelines: ['codex'],
      scopes: ['work.operator'],
    });
  }
  process.env['AGENT_LCARS_WORK_GRANTS'] = JSON.stringify(grants);
  return NextResponse.json({ revoked });
}
