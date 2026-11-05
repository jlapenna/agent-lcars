import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeEach, expect, it, vi } from 'vitest';

import { executeJobSecretsCommand } from './job-secrets-command';
import type { WorkCommandDeps } from './work-command';

let deps: WorkCommandDeps;
beforeEach(() => {
  deps = {
    origin: 'https://console.test',
    token: async () => 'fixture-admin-token',
    fetchImpl: vi.fn(async () =>
      Response.json({ version: '2' }),
    ) as unknown as typeof fetch,
    stdout: vi.fn(),
    stderr: vi.fn(),
    now: () => new Date(),
    sleep: async () => undefined,
  };
});
it('uploads only protected stdin and prints only a validated version identifier', async () => {
  expect(
    await executeJobSecretsCommand(
      ['upload', 'example'],
      deps,
      () => 'fixture-private-value',
    ),
  ).toEqual({ ok: true });
  expect(deps.fetchImpl).toHaveBeenCalledWith(
    'https://console.test/api/work/v1/credentials/secrets/example/versions',
    expect.objectContaining({
      body: JSON.stringify({ value: 'fixture-private-value' }),
      redirect: 'error',
    }),
  );
  expect(deps.stdout).toHaveBeenCalledExactlyOnceWith('{"version":"2"}');
  expect(deps.stderr).not.toHaveBeenCalled();
});
it.each(['sdk-error', 'error-body', 'invalid-success'])(
  'does not reflect secrets from %s',
  async (failure) => {
    vi.mocked(deps.fetchImpl).mockImplementation(async () => {
      if (failure === 'sdk-error') throw new Error('fixture-private-value');
      return Response.json(
        { value: 'fixture-private-value', version: 'fixture-private-value' },
        { status: failure === 'error-body' ? 409 : 200 },
      );
    });
    expect(
      (
        await executeJobSecretsCommand(
          ['upload', 'example'],
          deps,
          () => 'fixture-private-value',
        )
      ).ok,
    ).toBe(false);
    expect(deps.stdout).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(deps.stderr).mock.calls)).not.toContain(
      'fixture-private-value',
    );
  },
);
it('does not accept a secret value as an extra argument', async () => {
  expect(
    (
      await executeJobSecretsCommand(
        ['upload', 'example', 'fixture-private-value'],
        deps,
      )
    ).ok,
  ).toBe(false);
  expect(deps.fetchImpl).not.toHaveBeenCalled();
});

it('waits for delayed protected pipe input instead of treating EAGAIN as failure', async () => {
  const moduleUrl = pathToFileURL(
    resolve(__dirname, 'job-secrets-command.ts'),
  ).href;
  const root = resolve(__dirname, '../../../..');
  const script = `import { executeJobSecretsCommand } from ${JSON.stringify(moduleUrl)};
    process.send('ready');
    const result = await executeJobSecretsCommand(['upload','example'], {
      origin:'https://fixture.invalid', token:async()=> 'fixture-admin-token',
      fetchImpl:async (_url,init)=> {
        if(JSON.parse(init.body).value !== 'fixture-delayed-value') throw new Error('fixture input mismatch');
        return Response.json({version:'3'});
      }, stdout:line=>process.stdout.write(line+'\\n'), stderr:()=>undefined
    });
    if(!result.ok) process.exitCode=1;
    process.disconnect();`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      timeout: 10000,
    },
  );
  const output: Buffer[] = [];
  child.stdout!.on('data', (chunk: Buffer) => output.push(chunk));
  child.stdin!.on('error', () => undefined);
  child.once('message', () =>
    setTimeout(() => child.stdin!.end('fixture-delayed-value'), 75),
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(code).toBe(0);
  expect(Buffer.concat(output).toString('utf8').trim()).toBe('{"version":"3"}');
}, 15000);
