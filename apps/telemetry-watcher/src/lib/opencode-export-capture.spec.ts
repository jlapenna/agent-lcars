import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  captureOpenCodeExports,
  isTrustedOpenCodePath,
  OPENCODE_CAPTURE_LIMITS,
  resolveTrustedOpenCodeExecutable,
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
    vi.unstubAllEnvs();
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
            id: args[2],
            directory: '[redacted:session-directory]',
            title: '[redacted:session-title]',
            time: { created: 100, updated: 200, metadata: 'secret-time' },
            metadata: { apiKey: 'writer-secret-info' },
            share: { url: 'writer-secret-share' },
            permission: { bash: 'allow' },
            path: '/writer-secret-path',
          },
          metadata: { topLevel: 'writer-secret-top' },
          messages: [
            {
              info: {
                role: 'assistant',
                providerID: 'homelab',
                modelID: 'default',
                time: { created: 110, completed: 190 },
                cost: 0.25,
                tokens: {
                  input: 10,
                  output: 2,
                  cache: { read: 5, write: 1 },
                  metadata: 'writer-secret-tokens',
                },
                metadata: { credential: 'writer-secret-message' },
              },
              parts: [
                { type: 'text', text: 'writer-secret-text' },
                {
                  type: 'tool',
                  tool: 'bash',
                  state: {
                    time: { start: 120, end: 180 },
                    input: { command: 'echo writer-secret-command' },
                    output: 'writer-secret-output',
                    path: '/writer-secret-tool-path',
                  },
                },
              ],
            },
          ],
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
        '--pure',
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
      args: ['--pure', 'export', 'ses_current', '--sanitize'],
      maxBytes: OPENCODE_CAPTURE_LIMITS.exportBytes,
      timeout: OPENCODE_CAPTURE_LIMITS.timeoutMs,
    });
    const materialized = fs.readFileSync(
      path.join(root, 'sessions', 'ses_current.jsonl'),
      'utf8',
    );
    expect(JSON.parse(materialized)).toEqual({
      info: {
        id: 'ses_current',
        directory: workspace,
        time: { created: 100, updated: 200 },
      },
      messages: [
        {
          info: {
            role: 'assistant',
            time: { created: 110, completed: 190 },
            providerID: 'homelab',
            modelID: 'default',
            tokens: {
              input: 10,
              output: 2,
              cache: { read: 5, write: 1 },
            },
            cost: 0.25,
          },
          parts: [
            {
              type: 'tool',
              tool: 'bash',
              state: { time: { start: 120, end: 180 } },
            },
          ],
        },
      ],
    });
    expect(materialized).not.toContain('writer-secret');
    expect(materialized).not.toMatch(
      /metadata|share|permission|path|command|text/i,
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
      exports.push(args[2] as string);
      fs.writeFileSync(
        output,
        JSON.stringify({ info: { id: args[2] }, messages: [] }),
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

  it('requires root ownership and rejects writable or symlinked executable paths', () => {
    expect(resolveTrustedOpenCodeExecutable('/usr/bin/bash')).toBe(
      '/usr/bin/bash',
    );

    const installDir = path.join(root, 'image');
    const binDir = path.join(installDir, 'bin');
    const executable = path.join(binDir, 'opencode');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(installDir, 0o700);
    fs.chmodSync(binDir, 0o700);
    fs.writeFileSync(executable, '#!/bin/bash\nexit 0\n', { mode: 0o700 });

    // A same-uid action install is never trusted by the production resolver.
    expect(resolveTrustedOpenCodeExecutable(executable)).toBeUndefined();
    const currentUid = process.getuid?.() ?? -1;
    expect(isTrustedOpenCodePath(executable, currentUid)).toBe(true);

    fs.chmodSync(executable, 0o722);
    expect(isTrustedOpenCodePath(executable, currentUid)).toBe(false);

    fs.chmodSync(executable, 0o700);
    const symlink = path.join(binDir, 'opencode-link');
    fs.symlinkSync(executable, symlink);
    expect(isTrustedOpenCodePath(symlink, currentUid)).toBe(false);
  });

  it('uses pure mode and a credential-free child environment for real processes', async () => {
    const executable = path.join(root, 'fake-opencode');
    const argsLog = path.join(root, 'args.log');
    const envLog = path.join(root, 'env.log');
    const sessions = JSON.stringify([{ id: 'ses_env', directory: workspace }]);
    fs.writeFileSync(
      executable,
      `#!/bin/bash\n/usr/bin/printf '%s\\n' '---' "$@" >> ${JSON.stringify(argsLog)}\n/usr/bin/env >> ${JSON.stringify(envLog)}\nif [ "$2" = session ]; then\n  /usr/bin/printf '%s\\n' '${sessions}'\nelse\n  /usr/bin/printf '%s\\n' '{"info":{"id":"ses_env"},"messages":[]}'\nfi\n`,
      { mode: 0o700 },
    );
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/writer-secret.json');
    vi.stubEnv('GOOGLE_GHA_CREDS_PATH', '/tmp/writer-secret-gha.json');
    vi.stubEnv(
      'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
      '/tmp/writer-secret-cloudsdk.json',
    );
    vi.stubEnv('AGENT_TELEMETRY_WRITER_KEY_JSON', 'writer-secret-json');
    vi.stubEnv('WRITER_CREDENTIALS_FILE', '/tmp/writer-secret-explicit.json');
    vi.stubEnv('OPENCODE_LLM_API_KEY', 'writer-secret-model-key');

    expect(
      await captureOpenCodeExports({
        workspaceDir: workspace,
        exportsDir: root,
        opencodeExecutable: executable,
      }),
    ).toEqual({ status: 'ok', selected: 1, exported: 1, failed: 0 });

    const args = fs.readFileSync(argsLog, 'utf8');
    expect(args).toContain(
      `---\n--pure\nsession\nlist\n--format\njson\n-n\n${OPENCODE_CAPTURE_LIMITS.list}\n`,
    );
    expect(args).toContain('---\n--pure\nexport\nses_env\n--sanitize\n');
    const env = fs.readFileSync(envLog, 'utf8');
    expect(env).not.toContain('writer-secret');
    expect(env).not.toMatch(
      /GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GHA_CREDS_PATH|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE|AGENT_TELEMETRY_WRITER_KEY_JSON|WRITER_CREDENTIALS_FILE|OPENCODE_LLM_API_KEY/,
    );
  });

  it('enforces the export byte cap in the kernel for a fast real process', async () => {
    const executable = path.join(root, 'oversized-opencode');
    const observedSize = path.join(root, 'observed-size');
    const sessions = JSON.stringify([
      { id: 'ses_oversized', directory: workspace },
    ]);
    fs.writeFileSync(
      executable,
      `#!/bin/bash\nif [ "$2" = session ]; then\n  /usr/bin/printf '%s\\n' '${sessions}'\n  exit 0\nfi\nset +e\n/bin/dd if=/dev/zero bs=1024 count=128 status=none\nstatus=$?\n/usr/bin/stat -Lc %s /proc/$$/fd/1 > ${JSON.stringify(observedSize)}\nexit "$status"\n`,
      { mode: 0o700 },
    );
    const hardLimit = 64 * 1024;

    const result = await captureOpenCodeExports({
      workspaceDir: workspace,
      exportsDir: root,
      opencodeExecutable: executable,
      limits: { exportBytes: hardLimit, timeoutMs: 2_000 },
    });

    expect(result).toEqual({
      status: 'ok',
      selected: 1,
      exported: 0,
      failed: 1,
    });
    expect(
      Number(fs.readFileSync(observedSize, 'utf8').trim()),
    ).toBeLessThanOrEqual(hardLimit);
  });

  it('kills a timed-out real process within the configured command bound', async () => {
    const executable = path.join(root, 'sleeping-opencode');
    fs.writeFileSync(executable, '#!/bin/bash\n/bin/sleep 5\n', {
      mode: 0o700,
    });
    const startedAt = Date.now();

    const result = await captureOpenCodeExports({
      workspaceDir: workspace,
      exportsDir: root,
      opencodeExecutable: executable,
      limits: { timeoutMs: 100 },
    });

    expect(result).toEqual({
      status: 'list-failed',
      selected: 0,
      exported: 0,
      failed: 0,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('prunes only stale materialized JSONL files from its task-owned directory', async () => {
    const sessionsDir = path.join(root, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'ses_stale.jsonl'), '{}');
    fs.writeFileSync(path.join(sessionsDir, 'keep.txt'), 'keep');
    const runOpenCode = vi.fn<RunOpenCode>((args) => {
      if (args[0] === '--pure' && args[1] === 'session') return '[]';
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
