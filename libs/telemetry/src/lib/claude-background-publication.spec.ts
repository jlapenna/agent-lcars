import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { reduceTranscriptLines } from './reducer';

// Sanitized native #2849 sequence: Bash's 120s background result, provider
// completion origin/envelope, then the actual tail -5 result. No file replay.
type BaseRow = {
  uuid: string;
  sessionId: string;
  timestamp: string;
  isSidechain: boolean;
};
type CallRow = BaseRow & {
  type: string;
  message: {
    role: string;
    content: [{ id: string; input: { command: string } }];
  };
};
type ResultRow = BaseRow & {
  sourceToolAssistantUUID: string;
  toolUseResult: {
    stdout: string;
    interrupted: boolean;
    backgroundTaskId: string;
  };
  message: {
    role: string;
    content: [{ tool_use_id: string; is_error: boolean; content: string }];
  };
};
type CompletionRow = BaseRow & {
  type: string;
  origin: { kind: string; producer: string };
  promptSource: string;
  turnOrigin: string;
  message: { role: string; content: string };
};
type Fixture = [CallRow, ResultRow, CompletionRow, CallRow, ResultRow];
function fixture(): Fixture {
  return readFileSync(
    join(import.meta.dirname, 'fixtures/claude-background-publication.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line)) as Fixture;
}
function reduce(rows: unknown[]) {
  return reduceTranscriptLines(rows.map((row) => JSON.stringify(row)))[0];
}
const published = [{ repo: { owner: 'octo', name: 'example' }, number: 42 }];

describe('native Claude background publication', () => {
  it('recovers the real compound publication as a candidate while retaining spend', () => {
    const summary = reduce(fixture());
    expect(summary.deliverables.publicationCandidates).toEqual(published);
    expect(summary.deliverables.qualifiedPRs).toBeUndefined();
    expect(summary.totalCostUsd).toBe(0.25);
    expect(summary.tokens.inputTokens).toBe(10);
    expect(summary.tokens.outputTokens).toBe(20);
  });

  it('recovers the publication when TMPDIR relocates the task output', () => {
    const rows = fixture();
    const relocate = (text: string) =>
      text.replace('/tmp/claude-1000/', '/home/dev/.offroot/tmp/claude-1000/');
    rows[2].message.content = relocate(rows[2].message.content);
    rows[3].message.content[0].input.command = relocate(
      rows[3].message.content[0].input.command,
    );
    expect(reduce(rows).deliverables.publicationCandidates).toEqual(published);
  });

  it('preserves the existing literal qualification distinction', () => {
    const rows = fixture();
    rows[0].message.content[0].input.command = 'gh pr create --draft';
    expect(reduce(rows).deliverables.qualifiedPRs).toEqual(published);
  });

  it.each([
    [
      'bare notification text',
      (r: Fixture) => {
        Reflect.deleteProperty(r[2], 'origin');
      },
    ],
    [
      'queue copy',
      (r: Fixture) => {
        r[2].type = 'queue-operation';
      },
    ],
    [
      'assistant copy',
      (r: Fixture) => {
        r[2].type = 'assistant';
        r[2].message.role = 'assistant';
      },
    ],
    [
      'user origin',
      (r: Fixture) => {
        r[2].origin.producer = 'user';
      },
    ],
    [
      'user prompt',
      (r: Fixture) => {
        r[2].promptSource = 'user';
      },
    ],
    [
      'ordinary turn',
      (r: Fixture) => {
        Reflect.deleteProperty(r[2], 'turnOrigin');
      },
    ],
    [
      'different task',
      (r: Fixture) => {
        r[2].message.content = r[2].message.content.replace(
          '<task-id>bg123',
          '<task-id>other',
        );
      },
    ],
    [
      'different tool',
      (r: Fixture) => {
        r[2].message.content = r[2].message.content.replace(
          '<tool-use-id>toolu_create',
          '<tool-use-id>other',
        );
      },
    ],
    [
      'different session',
      (r: Fixture) => {
        r[2].sessionId = 'other-session';
      },
    ],
    [
      'different output session',
      (r: Fixture) => {
        r[2].message.content = r[2].message.content.replace(
          '/11111111-1111-4111-8111-111111111111/',
          '/other/',
        );
      },
    ],
    [
      'path traversal',
      (r: Fixture) => {
        r[2].message.content = r[2].message.content.replace(
          '/tasks/',
          '/../tasks/',
        );
      },
    ],
    [
      'output outside a Claude task root',
      (r: Fixture) => {
        r[2].message.content = r[2].message.content.replace(
          '/tmp/claude-1000/',
          '/tmp/other-1000/',
        );
        r[3].message.content[0].input.command =
          r[3].message.content[0].input.command.replace(
            '/tmp/claude-1000/',
            '/tmp/other-1000/',
          );
      },
    ],
    [
      'failed task',
      (r: Fixture) => {
        r[2].message.content = r[2].message.content.replace(
          'exit code 0',
          'exit code 1',
        );
      },
    ],
    [
      'incomplete task',
      (r: Fixture) => {
        r[2].message.content = r[2].message.content.replace(
          '<status>completed',
          '<status>running',
        );
      },
    ],
    [
      'reversed clock',
      (r: Fixture) => {
        r[2].timestamp = '2026-10-16T23:00:00Z';
      },
    ],
    [
      'missing structured background ID',
      (r: Fixture) => {
        Reflect.deleteProperty(r[1].toolUseResult, 'backgroundTaskId');
      },
    ],
    [
      'failed original result',
      (r: Fixture) => {
        r[1].message.content[0].is_error = true;
      },
    ],
    [
      'interrupted original',
      (r: Fixture) => {
        r[1].toolUseResult.interrupted = true;
      },
    ],
    [
      'wrong original assistant',
      (r: Fixture) => {
        r[1].sourceToolAssistantUUID = 'other';
      },
    ],
    [
      'sidechain original',
      (r: Fixture) => {
        r[0].isSidechain = true;
      },
    ],
    [
      'lookup instead of creation',
      (r: Fixture) => {
        r[0].message.content[0].input.command = 'gh pr view 42';
      },
    ],
    [
      'arbitrary tail',
      (r: Fixture) => {
        r[3].message.content[0].input.command += '.other';
      },
    ],
    [
      'API blob read',
      (r: Fixture) => {
        r[3].type = 'api-request-blob';
      },
    ],
    [
      'wrong read assistant',
      (r: Fixture) => {
        r[4].sourceToolAssistantUUID = 'other';
      },
    ],
    [
      'compound read',
      (r: Fixture) => {
        r[3].message.content[0].input.command +=
          '; echo https://github.com/octo/other/pull/99';
      },
    ],
    [
      'multiple paths',
      (r: Fixture) => {
        r[3].message.content[0].input.command += ' /tmp/other';
      },
    ],
    [
      'forged result content',
      (r: Fixture) => {
        r[4].toolUseResult.stdout = '';
      },
    ],
    [
      'failed read',
      (r: Fixture) => {
        r[4].message.content[0].is_error = true;
      },
    ],
    [
      'read before completion',
      (r: Fixture) => {
        r[4].timestamp = r[1].timestamp;
      },
    ],
  ] as const)('excludes %s', (_name, change) => {
    const rows = fixture();
    change(rows);
    expect(reduce(rows).deliverables.publicationCandidates).toBeUndefined();
    expect(reduce(rows).deliverables.qualifiedPRs).toBeUndefined();
  });

  it.each(['', 'failed'] as const)(
    'consumes an %s terminal read once',
    (first) => {
      const rows = fixture();
      const originalRead = [
        structuredClone(rows[3]),
        structuredClone(rows[4]),
      ] as const;
      if (first === '') {
        rows[4].message.content[0].content = '';
        rows[4].toolUseResult.stdout = '';
      } else rows[4].message.content[0].is_error = true;
      originalRead[0].uuid = 'read-retry';
      originalRead[0].message.content[0].id = 'read-retry';
      originalRead[1].uuid = 'output-retry';
      originalRead[1].sourceToolAssistantUUID = originalRead[0].uuid;
      originalRead[1].message.content[0].tool_use_id = 'read-retry';
      expect(
        reduce([...rows, ...originalRead]).deliverables.publicationCandidates,
      ).toBeUndefined();
    },
  );

  it('rejects ID reuse and conflicting provider completion', () => {
    const rows = fixture();
    const conflict = structuredClone(rows[2]);
    conflict.uuid = 'conflict';
    conflict.message.content = conflict.message.content.replace(
      '/tasks/',
      '/other/tasks/',
    );
    expect(
      reduce([...rows.slice(0, 3), conflict, ...rows.slice(3)]).deliverables
        .publicationCandidates,
    ).toBeUndefined();
    const duplicate = structuredClone(rows[1]);
    duplicate.uuid = 'background-replay';
    const call = structuredClone(rows[0]);
    call.uuid = 'call-replay';
    duplicate.sourceToolAssistantUUID = call.uuid;
    expect(
      reduce([...rows.slice(0, 2), call, duplicate, ...rows.slice(2)])
        .deliverables.publicationCandidates,
    ).toBeUndefined();
  });

  it('does not credit a replay after the successful terminal read', () => {
    const rows = fixture();
    const replay = [
      structuredClone(rows[3]),
      structuredClone(rows[4]),
    ] as const;
    replay[0].uuid = 'new-read';
    replay[0].message.content[0].id = 'new-read';
    replay[1].uuid = 'new-output';
    replay[1].sourceToolAssistantUUID = replay[0].uuid;
    replay[1].message.content[0].tool_use_id = 'new-read';
    replay[1].toolUseResult.stdout = 'https://github.com/octo/other/pull/99';
    replay[1].message.content[0].content = replay[1].toolUseResult.stdout;
    expect(
      reduce([...rows, ...replay]).deliverables.publicationCandidates,
    ).toEqual(published);
  });

  it('fails closed for background association overflow', () => {
    const rows = fixture();
    const starts = Array.from({ length: 65 }, (_, index) => {
      const pair = [
        structuredClone(rows[0]),
        structuredClone(rows[1]),
      ] as const;
      pair[0].uuid = `call-${index}`;
      pair[0].message.content[0].id = `tool-${index}`;
      pair[1].uuid = `result-${index}`;
      pair[1].sourceToolAssistantUUID = pair[0].uuid;
      pair[1].message.content[0].tool_use_id = `tool-${index}`;
      pair[1].toolUseResult.backgroundTaskId = `bg${index}`;
      return pair;
    }).flat();
    rows[2].message.content = rows[2].message.content
      .replaceAll('bg123', 'bg64')
      .replaceAll('toolu_create', 'tool-64');
    rows[3].message.content[0].input.command =
      rows[3].message.content[0].input.command.replaceAll('bg123', 'bg64');
    expect(
      reduce([...starts, ...rows.slice(2)]).deliverables.publicationCandidates,
    ).toBeUndefined();
  });
});

// Sanitized native mid-turn delivery: when the task completes while the
// session is busy, the provider records its notification as a queued-command
// attachment instead of a system turn (~1 in 3 observed completions).
type AttachmentRow = BaseRow & {
  type: string;
  attachment: {
    type: string;
    prompt: string;
    commandMode: string;
    origin: { kind: string; producer: string };
    runId?: string;
  };
};
function midTurn() {
  const rows = fixture();
  const completion = rows[2];
  const attachment: AttachmentRow = {
    type: 'attachment',
    sessionId: completion.sessionId,
    isSidechain: false,
    uuid: completion.uuid,
    timestamp: completion.timestamp,
    attachment: {
      type: 'queued_command',
      prompt: completion.message.content,
      commandMode: 'task-notification',
      origin: { kind: 'task-notification', producer: 'session-task' },
      runId: 'native-run-1',
    },
  };
  return [rows[0], rows[1], attachment, rows[3], rows[4]] as const;
}

describe('native Claude background publication completed mid-turn', () => {
  it('recovers the publication from the queued-command notification', () => {
    expect(reduce([...midTurn()]).deliverables.publicationCandidates).toEqual(
      published,
    );
  });

  it.each([
    [
      'human-queued prompt',
      (a: AttachmentRow) => {
        a.attachment.commandMode = 'prompt';
      },
    ],
    [
      'human origin',
      (a: AttachmentRow) => {
        a.attachment.origin = { kind: 'human', producer: 'session-task' };
      },
    ],
    [
      'missing run',
      (a: AttachmentRow) => {
        Reflect.deleteProperty(a.attachment, 'runId');
      },
    ],
    [
      'other attachment',
      (a: AttachmentRow) => {
        a.attachment.type = 'edited_text_file';
      },
    ],
    [
      'sidechain attachment',
      (a: AttachmentRow) => {
        a.isSidechain = true;
      },
    ],
    [
      'failed task',
      (a: AttachmentRow) => {
        a.attachment.prompt = a.attachment.prompt.replace(
          'exit code 0',
          'exit code 1',
        );
      },
    ],
  ] as const)('excludes %s', (_name, change) => {
    const rows = midTurn();
    change(rows[2]);
    expect(
      reduce([...rows]).deliverables.publicationCandidates,
    ).toBeUndefined();
  });
});
