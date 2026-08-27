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

  // sessionId arrives from untrusted document content (jq -r over the work
  // payload) and is joined directly into a filesystem path -- a traversal
  // shape like this must be rejected before any I/O, not just handled by
  // luck of where path.join happens to land.
  it('rejects a session id that is not a safe identifier (path traversal), writing nothing', async () => {
    const download = vi.fn().mockResolvedValue('{"line":1}\n');
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const result = await resumeTranscript({
      sessionId: '../../../etc/passwd',
      transcriptGcsUri: 'gs://bucket/x.jsonl',
      cwd: '/x',
      claudeProjectsDir: '/home/runner/.claude/projects',
      download,
      mkdir,
      writeFile,
    });

    expect(result).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
