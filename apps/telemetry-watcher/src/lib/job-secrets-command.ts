import { parseArgs } from 'node:util';

import {
  credentialSetSchema,
  jobCredentialGrantSchema,
  jobSecretRecordSchema,
} from '@agent-lcars/work';
import { z } from 'zod';

import type { WorkCommandDeps } from './work-command';

async function stdin(maximum = 65536): Promise<string> {
  if (process.stdin.isTTY)
    throw new Error(
      'Pipe secret input on stdin; values are never accepted as arguments',
    );
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maximum) {
      process.stdin.destroy();
      throw new Error('Credential input exceeds supported size');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Only non-secret metadata reaches stdout. Upload errors are deliberately
 * independent of the response body and input, including malformed JSON. */
export async function executeJobSecretsCommand(
  argv: string[],
  deps: WorkCommandDeps,
  readInput: () => string | Promise<string> = stdin,
): Promise<{ ok: boolean }> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { version: { type: 'string' } },
      strict: true,
    });
    const [action, name] = positionals;
    let path: string;
    let body: unknown;
    if (
      ['secrets', 'sets', 'grants'].includes(action ?? '') &&
      positionals.length === 1
    ) {
      path = `/${action}`;
    } else if (
      ['register', 'publish', 'grant'].includes(action ?? '') &&
      positionals.length === 1
    ) {
      path = `/${action === 'register' ? 'secrets' : action === 'publish' ? 'sets' : 'grants'}`;
      body = JSON.parse(await readInput());
    } else if (
      ['upload', 'promote', 'disable', 'enable'].includes(action ?? '') &&
      positionals.length === 2 &&
      /^[a-z][a-z0-9-]{0,63}$/u.test(name!)
    ) {
      path = `/secrets/${name}/${action === 'upload' ? 'versions' : action}`;
      if (action === 'upload') body = { value: await readInput() };
      else if (
        action === 'promote' &&
        /^[1-9][0-9]*$/u.test(values.version ?? '')
      )
        body = { version: values.version };
      else if (action === 'disable' || action === 'enable') body = {};
      else throw new Error('Version required');
    } else throw new Error('Invalid credential operation');
    const response = await deps.fetchImpl(
      `${deps.origin}/api/work/v1/credentials${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${await deps.token()}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // The public response schema contains metadata only; never echo arbitrary
    // server bytes here, even on a successful upload through a broken proxy.
    const result = await response.json();
    if (action === 'upload') {
      const { version } = z
        .strictObject({ version: z.string().regex(/^[1-9][0-9]*$/u) })
        .parse(result);
      deps.stdout(JSON.stringify({ version }));
    } else {
      const schema =
        path === '/sets'
          ? credentialSetSchema
          : path === '/grants'
            ? jobCredentialGrantSchema
            : jobSecretRecordSchema;
      deps.stdout(
        JSON.stringify(
          Array.isArray(result)
            ? result.map((row) => schema.parse(row))
            : schema.parse(result),
        ),
      );
    }
    return { ok: true };
  } catch {
    deps.stderr(
      'Credential operation failed; check secrets.admin access, metadata and backend availability. Secret values are not shown.',
    );
    return { ok: false };
  }
}
