import { describe, expect, it } from 'vitest';

import {
  isQuickTaskEvidenceId,
  QUICK_TASK_EVIDENCE_NOT_FOUND_RESPONSE,
  QUICK_TASK_EVIDENCE_RESPONSE_HEADERS,
  QUICK_TASK_EVIDENCE_REVOCATION_PREFIX,
  QUICK_TASK_EVIDENCE_SUCCESS_RESPONSE,
  QUICK_TASK_MULTIPART_FIELDS,
  quickTaskEvidenceMarkdown,
  quickTaskEvidenceObjectKey,
  quickTaskEvidenceRevocationKey,
  quickTaskEvidenceUrl,
} from './quick-task-evidence-contract';

const evidenceId = '0d6a4b56-31d0-4d39-b0b2-5a2520cc4882';

describe('Quick Task evidence contract', () => {
  it('freezes the multipart field names and opaque UUID v4 identifiers', () => {
    expect(QUICK_TASK_MULTIPART_FIELDS).toEqual({
      intent: 'intent',
      evidence: 'evidence',
    });
    expect(isQuickTaskEvidenceId(evidenceId)).toBe(true);
    expect(isQuickTaskEvidenceId('not-an-evidence-id')).toBe(false);
    expect(isQuickTaskEvidenceId('0d6a4b56-31d0-5d39-b0b2-5a2520cc4882')).toBe(
      false,
    );
  });

  it('uses fixed, non-enumerable object and tombstone keys', () => {
    expect(quickTaskEvidenceObjectKey(evidenceId)).toBe(
      `objects/v1/${evidenceId}.webp`,
    );
    expect(quickTaskEvidenceRevocationKey(evidenceId)).toBe(
      `${QUICK_TASK_EVIDENCE_REVOCATION_PREFIX}${evidenceId}`,
    );
    expect(() => quickTaskEvidenceObjectKey('../private')).toThrow(
      'Invalid evidence identifier',
    );
  });

  it('derives canonical Markdown only from a trusted HTTPS origin', () => {
    const url = `https://lcars.example.net${'/console'}${'/api/quick-task-evidence/v1/'}${evidenceId}`;
    expect(
      quickTaskEvidenceUrl('https://lcars.example.net/console/', evidenceId),
    ).toBe(url);
    expect(
      quickTaskEvidenceMarkdown(
        'https://lcars.example.net/console/',
        evidenceId,
      ),
    ).toBe(`![Screenshot](${url})`);
    expect(() =>
      quickTaskEvidenceUrl('http://lcars.example.net', evidenceId),
    ).toThrow('Evidence origin is unavailable');
  });

  it('freezes the public successful-read headers', () => {
    expect(QUICK_TASK_EVIDENCE_RESPONSE_HEADERS).toEqual({
      'Cache-Control': 'no-cache, max-age=0',
      'Content-Disposition': 'inline; filename="screenshot.webp"',
      'Content-Type': 'image/webp',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(QUICK_TASK_EVIDENCE_SUCCESS_RESPONSE).toEqual({
      status: 200,
      headers: QUICK_TASK_EVIDENCE_RESPONSE_HEADERS,
    });
    expect(QUICK_TASK_EVIDENCE_NOT_FOUND_RESPONSE).toEqual({
      status: 404,
      headers: {},
    });
  });
});
