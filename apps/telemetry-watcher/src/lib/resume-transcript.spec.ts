import { describe, expect, it, vi } from 'vitest';

import { resumeTranscript } from './resume-transcript';

describe('resumeTranscript', () => {
  it('writes the downloaded transcript to the slug-derived path', async () => {
    const download = vi.fn().mockResolvedValue('{"line":1}\n');
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const result = await resumeTranscript({
      sessionId: 'sess_1',
      transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      cwd: '/home/runner/work/agent-lcars/agent-lcars',
      claudeProjectsDir: '/home/runner/.claude/projects',
      download,
      mkdir,
      writeFile,
    });

    expect(mkdir).toHaveBeenCalledWith(
      '/home/runner/.claude/projects/-home-runner-work-agent-lcars-agent-lcars',
    );
    expect(writeFile).toHaveBeenCalledWith(
      '/home/runner/.claude/projects/-home-runner-work-agent-lcars-agent-lcars/sess_1.jsonl',
      '{"line":1}\n',
    );
    expect(result).toBe(
      '/home/runner/.claude/projects/-home-runner-work-agent-lcars-agent-lcars/sess_1.jsonl',
    );
  });

  it('passes the project id through to the injected download function', async () => {
    const download = vi.fn().mockResolvedValue('{"line":1}\n');
    await resumeTranscript({
      sessionId: 'sess_1',
      transcriptGcsUri: 'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      cwd: '/x',
      claudeProjectsDir: '/home/runner/.claude/projects',
      projectId: 'test-project',
      download,
      mkdir: () => undefined,
      writeFile: () => undefined,
    });

    expect(download).toHaveBeenCalledWith(
      'gs://bucket/runs/x/claude-code/sess_1.jsonl',
      { projectId: 'test-project' },
    );
  });

  it('fails soft: returns undefined when the download throws', async () => {
    const result = await resumeTranscript({
      sessionId: 'sess_1',
      transcriptGcsUri: 'gs://bucket/x.jsonl',
      cwd: '/x',
      claudeProjectsDir: '/home/runner/.claude/projects',
      download: async () => {
        throw new Error('network');
      },
      mkdir: () => undefined,
      writeFile: () => undefined,
    });
    expect(result).toBeUndefined();
  });

  it('fails soft: returns undefined when mkdir throws', async () => {
    const result = await resumeTranscript({
      sessionId: 'sess_1',
      transcriptGcsUri: 'gs://bucket/x.jsonl',
      cwd: '/x',
      claudeProjectsDir: '/home/runner/.claude/projects',
      download: async () => '{}\n',
      mkdir: () => {
        throw new Error('EACCES');
      },
      writeFile: () => undefined,
    });
    expect(result).toBeUndefined();
  });
});
