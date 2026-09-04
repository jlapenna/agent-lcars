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

  it('writes a codex rollout under the codex home, keyed only by session id', async () => {
    const written: Record<string, string> = {};
    const path = await resumeTranscript({
      agent: 'codex',
      sessionId: '019fb1be-238c-77d2-a0b2-14961c202368',
      transcriptGcsUri:
        'gs://b/runs/r1/codex/019fb1be-238c-77d2-a0b2-14961c202368.jsonl',
      cwd: '/home/runner/_work/checkout',
      claudeProjectsDir: '/home/runner/.claude/projects',
      codexHome: '/run/codex/home',
      download: async () => '{"type":"session_meta"}\n',
      mkdir: () => undefined,
      writeFile: (p, c) => {
        written[p] = c;
      },
    });
    // Codex resolves a thread purely by the uuid in the basename; the date
    // path is inert, so it is a constant rather than derived from anything.
    expect(path).toBe(
      '/run/codex/home/sessions/1970/01/01/rollout-1970-01-01T00-00-00-019fb1be-238c-77d2-a0b2-14961c202368.jsonl',
    );
    expect(written[path!]).toContain('session_meta');
  });

  it('still writes a claude session to the claude projects dir', async () => {
    const download = vi.fn().mockResolvedValue('{"line":1}\n');
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const result = await resumeTranscript({
      agent: 'claude-code',
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

  it('rejects an unsafe codex session id before touching the filesystem', async () => {
    const download = vi.fn().mockResolvedValue('{"line":1}\n');
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const path = await resumeTranscript({
      agent: 'codex',
      sessionId: '../../etc/passwd',
      transcriptGcsUri: 'gs://b/runs/r1/codex/x.jsonl',
      cwd: '/home/runner/_work/checkout',
      claudeProjectsDir: '/home/runner/.claude/projects',
      codexHome: '/run/codex/home',
      download,
      mkdir,
      writeFile,
    });

    expect(path).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('imports an opencode export through the trusted binary', async () => {
    const ran: string[][] = [];
    const path = await resumeTranscript({
      agent: 'opencode',
      sessionId: 'ses_1',
      transcriptGcsUri: 'gs://b/runs/r1/opencode/ses_1.export.json',
      cwd: '/home/runner/_work/checkout',
      claudeProjectsDir: '/home/runner/.claude/projects',
      download: async () => '{"info":{"id":"ses_1"},"messages":[]}',
      runOpenCode: async (args) => {
        ran.push(args);
        return '';
      },
      mkdir: () => undefined,
      writeFile: () => undefined,
    });
    expect(ran[0]).toEqual(['--pure', 'import', expect.any(String)]);
    expect(path).toBe('ses_1');
  });

  it('returns undefined when no trusted opencode binary is available', async () => {
    // Never fall back to PATH: that is the existing capture-side boundary.
    // No runOpenCode/opencodeExecutable override -- the default resolves
    // only the real trusted root-owned path, which this test environment
    // never has.
    const path = await resumeTranscript({
      agent: 'opencode',
      sessionId: 'ses_1',
      transcriptGcsUri: 'gs://b/runs/r1/opencode/ses_1.export.json',
      cwd: '/home/runner/_work/checkout',
      claudeProjectsDir: '/home/runner/.claude/projects',
      download: async () => '{"info":{"id":"ses_1"},"messages":[]}',
      mkdir: () => undefined,
      writeFile: () => undefined,
    });
    expect(path).toBeUndefined();
  });

  it('rejects an unsafe opencode session id before running anything', async () => {
    const download = vi.fn().mockResolvedValue('{}');
    const writeFile = vi.fn();
    const runOpenCode = vi.fn();
    const path = await resumeTranscript({
      agent: 'opencode',
      sessionId: '../../etc/passwd',
      transcriptGcsUri: 'gs://b/runs/r1/opencode/x.export.json',
      cwd: '/home/runner/_work/checkout',
      claudeProjectsDir: '/home/runner/.claude/projects',
      download,
      runOpenCode,
      mkdir: () => undefined,
      writeFile,
    });

    expect(path).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(runOpenCode).not.toHaveBeenCalled();
  });

  it('returns undefined for codex when no codex home was given', async () => {
    const download = vi.fn().mockResolvedValue('{"line":1}\n');
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const path = await resumeTranscript({
      agent: 'codex',
      sessionId: '019fb1be-238c-77d2-a0b2-14961c202368',
      transcriptGcsUri:
        'gs://b/runs/r1/codex/019fb1be-238c-77d2-a0b2-14961c202368.jsonl',
      cwd: '/home/runner/_work/checkout',
      claudeProjectsDir: '/home/runner/.claude/projects',
      download,
      mkdir,
      writeFile,
    });

    // The caller is direct-runner.sh, which only knows CODEX_HOME inside
    // the codex branch; a missing one here is a caller bug, not a crash.
    expect(path).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
