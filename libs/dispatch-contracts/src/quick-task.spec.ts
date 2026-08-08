import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  formatQuickTaskMarker,
  parseQuickTaskMarker,
  parseTerminalQuickTaskBody,
  QUICK_TASK_MARKER_RE,
  quickTaskDigest,
  quickTaskMarkerMatcher,
} from './quick-task';

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

const identity = {
  repository: 'jlapenna/agent-lcars',
  pipeline: 'codex',
  title: 'A quick task',
  description: 'Do the thing.',
};

describe('quickTaskDigest', () => {
  it('produces the digest already written into live issue markers', () => {
    // This is the guard, and the reason it is a hardcoded literal rather than
    // a round-trip: `JSON.stringify` emits keys in insertion order, so the
    // field order inside `serializeIdentity` is wire format. Every Quick Task
    // marker on an open GitHub issue carries a digest computed with that
    // exact order. Reordering the literal -- which reads as harmless tidying
    // -- would recompute all of them differently, and the next label event on
    // any such issue would throw 'Quick Task marker digest mismatch' and
    // crash normalization. If this assertion fails, the wire format moved.
    expect(quickTaskDigest(identity, sha256Hex)).toBe(
      sha256Hex(
        JSON.stringify({
          repository: 'jlapenna/agent-lcars',
          pipeline: 'codex',
          title: 'A quick task',
          description: 'Do the thing.',
        }),
      ),
    );
  });

  it('ignores the key order of the object handed in', () => {
    // Callers must not have to know the wire order; only the module does.
    const shuffled = {
      description: identity.description,
      title: identity.title,
      pipeline: identity.pipeline,
      repository: identity.repository,
    };
    expect(quickTaskDigest(shuffled, sha256Hex)).toBe(
      quickTaskDigest(identity, sha256Hex),
    );
  });

  it('changes when any identity field changes', () => {
    for (const field of ['repository', 'pipeline', 'title', 'description']) {
      expect(
        quickTaskDigest({ ...identity, [field]: 'different' }, sha256Hex),
      ).not.toBe(quickTaskDigest(identity, sha256Hex));
    }
  });
});

describe('the Quick Task marker', () => {
  const requestId = '80df296f-07d8-4e9b-b33f-1fd1b8d2fa9c';
  const digest = quickTaskDigest(identity, sha256Hex);

  it('round-trips', () => {
    expect(
      parseQuickTaskMarker(formatQuickTaskMarker({ requestId, digest })),
    ).toEqual({ requestId, digest });
  });

  it('finds a marker embedded in an issue body', () => {
    const body = `Some description.\n\n${formatQuickTaskMarker({ requestId, digest })}`;
    expect(parseQuickTaskMarker(body)).toEqual({ requestId, digest });
  });

  it('requires a real UUID v4, not merely 36 hex-ish characters', () => {
    // The console's old copy accepted any `[0-9a-f-]{36}`, the broker's
    // required v4. Reading with the looser shape let a hand-edited body
    // smuggle an ID the writer would never mint.
    const notV4 = '80df296f-07d8-1e9b-b33f-1fd1b8d2fa9c';
    expect(
      parseQuickTaskMarker(
        `<!-- agent-lcars:quick-task-request:v1 id=${notV4} digest=${digest} -->`,
      ),
    ).toBe(undefined);
  });

  it('rejects a malformed digest', () => {
    expect(
      parseQuickTaskMarker(
        `<!-- agent-lcars:quick-task-request:v1 id=${requestId} digest=abc -->`,
      ),
    ).toBe(undefined);
  });

  it('tolerates a missing body', () => {
    expect(parseQuickTaskMarker(undefined)).toBe(undefined);
    expect(parseQuickTaskMarker('no marker here')).toBe(undefined);
  });

  it('hands out a fresh matcher rather than sharing lastIndex', () => {
    // A shared global regex carries mutable `lastIndex`, so a second caller
    // silently starts mid-string and misses the match.
    const body = formatQuickTaskMarker({ requestId, digest });
    expect([...body.matchAll(quickTaskMarkerMatcher())]).toHaveLength(1);
    expect([...body.matchAll(quickTaskMarkerMatcher())]).toHaveLength(1);
  });

  it('keeps the non-global matcher free of lastIndex state', () => {
    expect(QUICK_TASK_MARKER_RE.global).toBe(false);
  });

  it('separates a terminal identity marker from the editable description', () => {
    const body = `Some description.\n\n${formatQuickTaskMarker({ requestId, digest })}`;
    expect(parseTerminalQuickTaskBody(body)).toEqual({
      requestId,
      digest,
      description: 'Some description.',
    });
  });

  it('does not treat duplicate or non-terminal markers as an editable Quick Task body', () => {
    const marker = formatQuickTaskMarker({ requestId, digest });
    expect(
      parseTerminalQuickTaskBody(`${marker}\n\n${marker}`),
    ).toBeUndefined();
    expect(
      parseTerminalQuickTaskBody(`${marker}\n\nVisible text after it`),
    ).toBeUndefined();
  });
});
