import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  adapterFor,
  claudeCodeAdapter,
  codexAdapter,
  getTranscriptAdapter,
  TRANSCRIPT_ADAPTERS,
} from './transcript-adapter';

function readFixtureLines(name: string): string[] {
  return fs
    .readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
    .split('\n');
}

describe('claudeCodeAdapter', () => {
  it('is registered under the claude-code agent name', () => {
    expect(claudeCodeAdapter.agent).toBe('claude-code');
    expect(TRANSCRIPT_ADAPTERS).toContain(claudeCodeAdapter);
  });

  describe('detect', () => {
    it('detects a real Claude Code transcript fixture', () => {
      const lines = readFixtureLines('normal-session.jsonl');
      expect(claudeCodeAdapter.detect(lines, '/whatever/session.jsonl')).toBe(
        true,
      );
    });

    it('detects from a single matching line among the first few', () => {
      const lines = [
        '',
        JSON.stringify({ sessionId: 'abc', type: 'user' }),
        'not json at all',
      ];
      expect(claudeCodeAdapter.detect(lines, 'x.jsonl')).toBe(true);
    });

    it('rejects empty input', () => {
      expect(claudeCodeAdapter.detect([], 'x.jsonl')).toBe(false);
    });

    it('rejects lines with no parseable JSON', () => {
      expect(
        claudeCodeAdapter.detect(['not json', 'also not json'], 'x.jsonl'),
      ).toBe(false);
    });

    it('rejects well-formed JSON objects missing sessionId', () => {
      expect(
        claudeCodeAdapter.detect([JSON.stringify({ foo: 'bar' })], 'x.jsonl'),
      ).toBe(false);
    });

    it('rejects a JSON array line (not an object)', () => {
      expect(
        claudeCodeAdapter.detect([JSON.stringify([1, 2, 3])], 'x.jsonl'),
      ).toBe(false);
    });
  });

  describe('reduce', () => {
    it('reduces a single file worth of lines the same way reduceTranscript does', () => {
      const lines = readFixtureLines('normal-session.jsonl');
      const [summary] = claudeCodeAdapter.reduce(lines);

      expect(summary.sessionId).toBe('session-normal-1');
      expect(summary.agent).toBe('claude-code');
      expect(summary.source).toBe('issue-agent');
    });
  });
});

describe('adapterFor', () => {
  it('resolves the claude-code adapter by content sniffing', () => {
    const lines = readFixtureLines('normal-session.jsonl');
    expect(adapterFor(lines, '/some/session.jsonl')).toBe(claudeCodeAdapter);
  });

  it('resolves the codex adapter by content sniffing', () => {
    const lines = readFixtureLines('codex-session.jsonl');
    expect(adapterFor(lines, '/some/rollout.jsonl')).toBe(codexAdapter);
  });

  it('returns undefined when no adapter recognizes the content', () => {
    expect(adapterFor(['not a transcript line'], 'x.jsonl')).toBeUndefined();
  });
});

describe('getTranscriptAdapter', () => {
  it('resolves claude-code by name', () => {
    expect(getTranscriptAdapter('claude-code')).toBe(claudeCodeAdapter);
  });

  it('resolves codex by name', () => {
    expect(getTranscriptAdapter('codex')).toBe(codexAdapter);
  });

  it('returns undefined for an agent with no registered adapter yet', () => {
    expect(getTranscriptAdapter('opencode')).toBeUndefined();
    expect(getTranscriptAdapter('gemini')).toBeUndefined();
    expect(getTranscriptAdapter('antigravity')).toBeUndefined();
  });
});
