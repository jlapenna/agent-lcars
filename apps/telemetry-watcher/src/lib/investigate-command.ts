import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

import {
  INVESTIGATION_ERROR_MAX_BYTES,
  INVESTIGATION_REQUEST_MAX_BYTES,
  INVESTIGATION_RESPONSE_MAX_BYTES,
  INVESTIGATION_TRANSPORT_MS,
  investigationErrorSchema,
  investigationRequestSchema,
  investigationResultSchema,
  runIntrospectionSchema,
} from '@agent-lcars/work';

const CONSOLE_ORIGIN = 'https://lcars.jlapenna.net';
const GATEWAY_URL = 'https://investigate.lan.jlapenna.net/v1/investigations';
export const INVESTIGATE_CLI_USAGE =
  'usage: investigate --request-id <key> (--question <text> | --question-file <path>) [--context <text> | --context-file <path>]';

export interface InvestigateCommandDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  readFile: (path: string, maximumBytes: number) => Promise<string>;
  monotonic: () => number;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

async function boundedFile(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('invalid-input');
    const buffer = Buffer.alloc(maximumBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const part = await file.read(buffer, count, buffer.length - count, null);
      if (!part.bytesRead) break;
      count += part.bytesRead;
    }
    if (count > maximumBytes) throw new Error('invalid-input');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, count),
    );
  } finally {
    await file.close();
  }
}

export function defaultInvestigateCommandDeps(
  env: NodeJS.ProcessEnv,
): InvestigateCommandDeps {
  return {
    env,
    fetchImpl: globalThis.fetch,
    readFile: boundedFile,
    monotonic: () => performance.now(),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

async function body(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    throw new Error('invalid-response');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid-response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) throw new Error('invalid-response');
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks, size);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const errorsByStatus: Record<number, readonly string[]> = {
  400: ['invalid-request'],
  413: ['request-too-large'],
  401: ['unauthorized'],
  409: ['worker-fenced', 'request-id-conflict'],
  429: ['quota-exhausted', 'request-in-progress'],
  502: ['invalid-investigator-result'],
  503: [
    'authorization-unavailable',
    'investigator-unavailable',
    'audit-unavailable',
  ],
  504: ['deadline-exceeded'],
};

export async function executeInvestigateCommand(
  argv: string[],
  deps: InvestigateCommandDeps,
): Promise<{ ok: boolean }> {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    deps.stdout(INVESTIGATE_CLI_USAGE);
    return { ok: true };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let deadline = deps.monotonic() + INVESTIGATION_TRANSPORT_MS;
  const started = deps.monotonic();
  const arm = () => {
    clearTimeout(timer);
    const remaining = deadline - deps.monotonic();
    if (remaining <= 0) throw new Error('deadline-exceeded');
    timer = setTimeout(() => controller.abort(), remaining);
  };
  try {
    const { values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        'request-id': { type: 'string' },
        question: { type: 'string' },
        'question-file': { type: 'string' },
        context: { type: 'string' },
        'context-file': { type: 'string' },
      },
    });
    if (
      (values.question === undefined) ===
        (values['question-file'] === undefined) ||
      (values.context !== undefined && values['context-file'] !== undefined)
    )
      throw new Error('invalid-input');
    const question =
      values.question ??
      (await deps.readFile(values['question-file'] ?? '', 4096));
    const context =
      values.context ??
      (values['context-file'] === undefined
        ? ''
        : await deps.readFile(values['context-file'], 16384));
    const input = investigationRequestSchema.parse({
      version: 1,
      runId: deps.env['LCARS_RUN_ID'],
      requestId: values['request-id'],
      question,
      context,
      issueUrl: null,
    });
    const token = deps.env['LCARS_RUN_TOKEN'];
    if (
      !token ||
      token.length > 8192 ||
      Array.from(token).some(
        (character) =>
          /\s/u.test(character) ||
          character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127,
      )
    )
      throw new Error('invalid-input');
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const generation = deps.env['LCARS_WORKER_GENERATION'];
    const identityPath = deps.env['LCARS_WORKER_IDENTITY_FILE'];
    let identity: string | undefined;
    if (
      deps.env['LCARS_CAPACITY_RECEIPT'] ||
      generation !== undefined ||
      identityPath !== undefined
    ) {
      if (
        !generation ||
        !/^[1-9][0-9]*$/u.test(generation) ||
        !Number.isSafeInteger(Number(generation)) ||
        !identityPath
      )
        throw new Error('invalid-input');
      identity = (await deps.readFile(identityPath, 16384)).trim();
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(identity))
        throw new Error('invalid-input');
      headers['x-lcars-worker-identity'] = identity;
      headers['x-lcars-worker-generation'] = generation;
    }
    arm();
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error('deadline-exceeded')),
        { once: true },
      ),
    );
    const operation = async () => {
      const response = await deps.fetchImpl(
        `${CONSOLE_ORIGIN}/api/work/v1/runs/${encodeURIComponent(input.runId)}/introspect`,
        {
          headers,
          redirect: 'error',
          signal: controller.signal,
          cache: 'no-store',
        },
      );
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error(
          response.status === 401
            ? 'unauthorized'
            : response.status === 409
              ? 'worker-fenced'
              : 'authorization-unavailable',
        );
      }
      const authenticated = runIntrospectionSchema.parse(
        await body(response, 4096, controller.signal),
      );
      if (authenticated.runId !== input.runId)
        throw new Error('invalid-response');
      const expectedIssue =
        'repo' in authenticated.anchor
          ? `https://github.com/${authenticated.anchor.repo}/issues/${authenticated.anchor.issue}`
          : null;
      if (
        authenticated.issueUrl !== expectedIssue ||
        ('repo' in authenticated.anchor &&
          authenticated.anchor.repo !== authenticated.repository)
      )
        throw new Error('invalid-response');
      if (
        (authenticated.worker &&
          (!identity ||
            authenticated.worker.generation !== Number(generation))) ||
        (identity && !authenticated.worker)
      )
        throw new Error('worker-fenced');
      const validityMs =
        Date.parse(authenticated.validUntil) -
        Date.parse(authenticated.verifiedAt);
      deadline = Math.min(deadline, started + validityMs);
      arm();
      input.issueUrl = authenticated.issueUrl;
      const requestBody = JSON.stringify(
        investigationRequestSchema.parse(input),
      );
      if (Buffer.byteLength(requestBody) > INVESTIGATION_REQUEST_MAX_BYTES)
        throw new Error('invalid-input');
      const answer = await deps.fetchImpl(GATEWAY_URL, {
        method: 'POST',
        headers,
        body: requestBody,
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (answer.status !== 200) {
        const error = investigationErrorSchema.parse(
          await body(answer, INVESTIGATION_ERROR_MAX_BYTES, controller.signal),
        );
        if (
          (error.requestId !== null && error.requestId !== input.requestId) ||
          !errorsByStatus[answer.status]?.includes(error.error.code) ||
          error.error.retryable !==
            (answer.status === 503 ||
              error.error.code === 'request-in-progress')
        )
          throw new Error('invalid-response');
        throw new Error(error.error.code);
      }
      const result = investigationResultSchema.parse(
        await body(answer, INVESTIGATION_RESPONSE_MAX_BYTES, controller.signal),
      );
      if (result.runId !== input.runId || result.requestId !== input.requestId)
        throw new Error('invalid-response');
      const output = JSON.stringify(result);
      if (output.includes(token) || (identity && output.includes(identity)))
        throw new Error('invalid-response');
      if (deps.monotonic() >= deadline) throw new Error('deadline-exceeded');
      controller.signal.throwIfAborted();
      deps.stdout(output);
    };
    await Promise.race([operation(), aborted]);
    return { ok: true };
  } catch (error) {
    controller.abort();
    const known = new Set([
      'invalid-input',
      'invalid-response',
      'deadline-exceeded',
      ...Object.values(errorsByStatus).flat(),
    ]);
    const code =
      error instanceof Error && known.has(error.message)
        ? error.message
        : 'investigation-unavailable';
    deps.stderr(`investigate failed: ${code}`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
