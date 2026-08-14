import { NextResponse } from 'next/server';

import {
  isQuickTaskEvidenceId,
  QUICK_TASK_EVIDENCE_NOT_FOUND_RESPONSE,
  QUICK_TASK_EVIDENCE_RESPONSE_HEADERS,
} from '../../../../../lib/quick-task-evidence-contract';
import { quickTaskEvidenceStore } from '../../../../../lib/quick-task-evidence-store';

const notFound = () =>
  new NextResponse(null, QUICK_TASK_EVIDENCE_NOT_FOUND_RESPONSE);

async function readEvidence(
  evidenceId: string,
  metadataOnly = false,
): Promise<NextResponse> {
  if (!isQuickTaskEvidenceId(evidenceId)) return notFound();
  try {
    const store = quickTaskEvidenceStore(
      process.env['QUICK_TASK_EVIDENCE_BUCKET'] ?? '',
    );
    if (await store.isRevoked(evidenceId)) return notFound();
    if (metadataOnly) {
      if (!(await store.readObject(evidenceId))) return notFound();
      return new NextResponse(null, {
        status: 200,
        headers: QUICK_TASK_EVIDENCE_RESPONSE_HEADERS,
      });
    }
    const bytes = await store.read(evidenceId);
    if (!bytes) return notFound();
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: QUICK_TASK_EVIDENCE_RESPONSE_HEADERS,
    });
  } catch {
    return notFound();
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ evidenceId: string }> },
) {
  return readEvidence((await params).evidenceId);
}

export async function HEAD(
  _request: Request,
  { params }: { params: Promise<{ evidenceId: string }> },
) {
  return readEvidence((await params).evidenceId, true);
}
