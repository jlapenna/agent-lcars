import { describe, expect, it } from 'vitest';

import {
  captureQuickTaskSource,
  composeQuickTaskEvidenceIssueBody,
  composeQuickTaskIssueBody,
  deriveQuickTaskTitle,
  lowInformationQuickTaskGuidance,
  sanitizeQuickTaskSourceRoute,
} from './quick-task-evidence';

describe('sanitizeQuickTaskSourceRoute', () => {
  it('keeps only typed, allowlisted console query state', () => {
    expect(
      sanitizeQuickTaskSourceRoute({
        pathname: '/inbox',
        search:
          '?repo=jlapenna%2Fagent-lcars&item=jlapenna%2Fagent-lcars%23524&reason=ready-for-agent&sort=newest&q=private+search&token=secret',
      }),
    ).toBe(
      '/inbox?repo=jlapenna%2Fagent-lcars&item=jlapenna%2Fagent-lcars%23524&reason=ready-for-agent&sort=newest',
    );
  });

  it('never carries origins, URL credentials, fragments, or arbitrary parameters', () => {
    expect(
      sanitizeQuickTaskSourceRoute(
        'https://admin:secret@console.example/agents?repo=jlapenna%2Fagent-lcars&access_token=top-secret#private',
      ),
    ).toBe('/agents?repo=jlapenna%2Fagent-lcars');
  });

  it('rejects unknown and credential-shaped paths instead of guessing', () => {
    expect(
      sanitizeQuickTaskSourceRoute('/debug/bearer-secret?repo=a%2Fb'),
    ).toBe('');
    expect(sanitizeQuickTaskSourceRoute('not a URL')).toBe('');
  });

  it('preserves canonical detail routes without unrelated query state', () => {
    expect(
      sanitizeQuickTaskSourceRoute(
        '/task/jlapenna/agent-lcars/524?token=nope&repo=jlapenna%2Fagent-lcars',
      ),
    ).toBe('/task/jlapenna/agent-lcars/524?repo=jlapenna%2Fagent-lcars');
    expect(sanitizeQuickTaskSourceRoute('/sessions/session-123?debug=1')).toBe(
      '/sessions/session-123',
    );
  });

  it('preserves either explicit session archive view', () => {
    expect(sanitizeQuickTaskSourceRoute('/sessions?view=flat')).toBe(
      '/sessions?view=flat',
    );
    expect(sanitizeQuickTaskSourceRoute('/sessions?view=by-issue')).toBe(
      '/sessions?view=by-issue',
    );
  });
});

describe('Quick Task evidence composition', () => {
  it('captures sanitized route state and canonical identities', () => {
    expect(
      captureQuickTaskSource(
        { pathname: '/task/org/repo/42', search: '?token=secret' },
        [{ label: 'Task', value: 'org/repo#42' }],
        new Date('2026-08-08T12:34:56.000Z'),
      ),
    ).toEqual({
      route: '/task/org/repo/42',
      identities: 'Task: org/repo#42',
      capturedAt: '2026-08-08T12:34:56.000Z',
    });
  });

  it('keeps the fast free-form path while adding readable source context', () => {
    expect(
      composeQuickTaskIssueBody(
        {
          description: 'Update the stale docs',
          screenshot: '',
          source: {
            route: '/agents?token=secret&repo=org%2Frepo',
            identities: '',
            capturedAt: '2026-08-08T12:34:56.000Z',
          },
        },
        { owner: 'org', name: 'repo' },
      ),
    ).toBe(`Update the stale docs

## Source context

- Repository: \`org/repo\`
- Console route: \`/agents?repo=org%2Frepo\`
- Captured: 2026-08-08T12:34:56.000Z`);
  });

  it('renders a screenshot section only when a link is given', () => {
    const body = composeQuickTaskIssueBody(
      {
        description: 'The task list hangs after refresh',
        screenshot: 'https://example.invalid/screenshot.png',
        source: {
          route: '/inbox',
          identities: 'Task: org/repo#42\nRun: org/repo#1234',
          capturedAt: 'invalid timestamp',
        },
      },
      { owner: 'org', name: 'repo' },
    );

    expect(body).toContain(
      '## Screenshot\nhttps://example.invalid/screenshot.png',
    );
    expect(body).toContain('- Task: org/repo#42');
    expect(body).toContain('- Run: org/repo#1234');
    expect(body).not.toContain('Captured:');

    expect(
      composeQuickTaskIssueBody(
        {
          description: 'No evidence attached',
          screenshot: '',
          source: { route: '', identities: '', capturedAt: '' },
        },
        { owner: 'org', name: 'repo' },
      ),
    ).not.toContain('## Screenshot');
  });

  it('attaches gateway Markdown only from a trusted server origin', () => {
    expect(
      composeQuickTaskEvidenceIssueBody(
        {
          description: 'The task list hangs after refresh',
          source: { route: '', identities: '', capturedAt: '' },
        },
        { owner: 'org', name: 'repo' },
        'https://lcars.example.net',
        '0d6a4b56-31d0-4d39-b0b2-5a2520cc4882',
      ),
    ).toContain(
      '![Screenshot](https://lcars.example.net/api/quick-task-evidence/v1/0d6a4b56-31d0-4d39-b0b2-5a2520cc4882)',
    );
  });
});

describe('Quick Task title guidance', () => {
  it('derives a bounded title from the first line', () => {
    expect(deriveQuickTaskTitle('Fix the   flaky test\nDetails')).toBe(
      'Fix the flaky test',
    );
    expect(deriveQuickTaskTitle('x'.repeat(120))).toHaveLength(80);
  });

  it('warns without rejecting generic or very short titles', () => {
    expect(lowInformationQuickTaskGuidance('please fix:')).toContain(
      'failing behavior',
    );
    expect(lowInformationQuickTaskGuidance('Docs')).toContain('terse');
    expect(
      lowInformationQuickTaskGuidance('Fix the session archive pagination'),
    ).toBeUndefined();
  });
});
