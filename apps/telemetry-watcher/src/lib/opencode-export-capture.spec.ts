import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureOpenCodeExports,
  OPENCODE_CAPTURE_LIMITS,
  RunOpenCode,
  RunOpenCodeToFile,
} from './opencode-export-capture';

describe('captureOpenCodeExports', () => {
  let root: string;
  const workspace = '/home/runner/_work/agent-lcars/agent-lcars';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-capture-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists a bounded set, selects the exact workspace, and materializes compact JSONL', async () => {
    const calls: Array<{ args: string[]; maxBytes: number; timeout: number }> =
      [];
    const runOpenCode: RunOpenCode = (args, options) => {
      calls.push({ args, ...options });
      return JSON.stringify([
        {
          id: 'ses_current',
          directory: workspace,
          title: 'Potentially sensitive prompt title',
          updated: 200,
          created: 100,
        },
        {
          id: 'ses_other',
          directory: '/other/workspace',
          updated: 300,
        },
      ]);
    };
    const runOpenCodeToFile: RunOpenCodeToFile = (args, output, options) => {
      calls.push({ args, ...options });
      fs.writeFileSync(
        output,
        JSON.stringify({
          info: {
            id: args[1],
            directory: '[redacted:session-directory]',
            title: '[redacted:session-title]',
          },
          messages: [],
        }),
      );
    };

    expect(
      await captureOpenCodeExports({
        workspaceDir: workspace,
        exportsDir: root,
        runOpenCode,
        runOpenCodeToFile,
      }),
    ).toEqual({ status: 'ok', selected: 1, exported: 1, failed: 0 });

    expect(calls[0]).toEqual({
      args: [
        'session',
        'list',
        '--format',
        'json',
        '-n',
        String(OPENCODE_CAPTURE_LIMITS.list),
      ],
      maxBytes: OPENCODE_CAPTURE_LIMITS.listBytes,
      timeout: OPENCODE_CAPTURE_LIMITS.timeoutMs,
    });
    expect(calls[1]).toEqual({
      args: ['export', 'ses_current', '--sanitize'],
      maxBytes: OPENCODE_CAPTURE_LIMITS.exportBytes,
      timeout: OPENCODE_CAPTURE_LIMITS.timeoutMs,
    });
    expect(
      fs.readFileSync(path.join(root, 'sessions', 'ses_current.jsonl'), 'utf8'),
    ).toBe(
      `${JSON.stringify({ info: { id: 'ses_current', directory: workspace }, messages: [] })}\n`,
    );
  });

  it('accepts legacy nested time fields and caps exports to the newest sessions', async () => {
    const sessions = Array.from(
      { length: OPENCODE_CAPTURE_LIMITS.sessions + 5 },
      (_, index) => ({
        id: `ses_${index}`,
        directory: workspace,
        time: { updated: index },
      }),
    );
    const exports: string[] = [];
    const runOpenCode: RunOpenCode = () => JSON.stringify(sessions);
    const runOpenCodeToFile: RunOpenCodeToFile = (args, output) => {
      exports.push(args[1] as string);
      fs.writeFileSync(
        output,
        JSON.stringify({ info: { id: args[1] }, messages: [] }),
      );
    };

    const result = await captureOpenCodeExports({
      workspaceDir: workspace,
      exportsDir: root,
      runOpenCode,
      runOpenCodeToFile,
    });

    expect(result.selected).toBe(OPENCODE_CAPTURE_LIMITS.sessions);
    expect(exports).toHaveLength(OPENCODE_CAPTURE_LIMITS.sessions);
    expect(exports[0]).toBe(`ses_${sessions.length - 1}`);
    expect(exports).not.toContain('ses_0');
  });

  it('fails soft for a missing CLI and malformed list output', async () => {
    const unavailable = Object.assign(new Error('spawn opencode ENOENT'), {
      code: 'ENOENT',
    });
    expect(
      await captureOpenCodeExports({
        workspaceDir: workspace,
        exportsDir: root,
        runOpenCode: () => {
          throw unavailable;
        },
      }),
    ).toEqual({
      status: 'cli-unavailable',
      selected: 0,
      exported: 0,
      failed: 0,
    });

    expect(
      await captureOpenCodeExports({
        workspaceDir: workspace,
        exportsDir: root,
        runOpenCode: () => '{broken',
      }),
    ).toEqual({
      status: 'list-failed',
      selected: 0,
      exported: 0,
      failed: 0,
    });
  });

  it('rejects an export whose session id does not match the request', async () => {
    const result = await captureOpenCodeExports({
      workspaceDir: workspace,
      exportsDir: root,
      runOpenCode: () =>
        JSON.stringify([{ id: 'ses_expected', directory: workspace }]),
      runOpenCodeToFile: (_args, output) => {
        fs.writeFileSync(
          output,
          JSON.stringify({ info: { id: 'ses_different' }, messages: [] }),
        );
      },
    });

    expect(result).toEqual({
      status: 'ok',
      selected: 1,
      exported: 0,
      failed: 1,
    });
    expect(
      fs.existsSync(path.join(root, 'sessions', 'ses_expected.jsonl')),
    ).toBe(false);
  });

  it('prunes only stale materialized JSONL files from its task-owned directory', async () => {
    const sessionsDir = path.join(root, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'ses_stale.jsonl'), '{}');
    fs.writeFileSync(path.join(sessionsDir, 'keep.txt'), 'keep');
    const runOpenCode = vi.fn<RunOpenCode>((args) => {
      if (args[0] === 'session') return '[]';
      throw new Error('unexpected export');
    });

    await captureOpenCodeExports({
      workspaceDir: workspace,
      exportsDir: root,
      runOpenCode,
    });

    expect(fs.existsSync(path.join(sessionsDir, 'ses_stale.jsonl'))).toBe(
      false,
    );
    expect(fs.readFileSync(path.join(sessionsDir, 'keep.txt'), 'utf8')).toBe(
      'keep',
    );
  });
});
