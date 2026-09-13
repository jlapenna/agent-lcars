import { chmod, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

async function readBounded(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error(`body exceeded ${limit} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function providerModel(value) {
  if (typeof value !== 'string') return undefined;
  const separator = value.indexOf('/');
  const model = separator >= 0 ? value.slice(separator + 1) : value;
  return SAFE_MODEL.test(model) ? model : undefined;
}

export function resolvePhysicalModel(modelInfo, deploymentId) {
  if (!Array.isArray(modelInfo?.data) || typeof deploymentId !== 'string') {
    return undefined;
  }
  const matches = modelInfo.data.filter(
    (entry) => entry?.model_info?.id === deploymentId,
  );
  const canonical = matches
    .filter(
      (entry) =>
        providerModel(entry?.litellm_params?.model) === entry?.model_name,
    )
    .map((entry) => entry.model_name)
    .filter((model) => SAFE_MODEL.test(model));
  if (new Set(canonical).size === 1) return canonical[0];

  const configured = [
    ...new Set(
      matches
        .map((entry) => providerModel(entry?.litellm_params?.model))
        .filter(Boolean)
        .filter((model) => !['default', 'big'].includes(model)),
    ),
  ];
  return configured.length === 1 ? configured[0] : undefined;
}

async function recordResolvedModel(
  upstream,
  authorization,
  deploymentId,
  outputFile,
) {
  if (!authorization || !deploymentId) return;
  const response = await fetch(new URL('/model/info', upstream), {
    headers: { authorization },
    redirect: 'error',
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok || !response.body) return;
  const body = await readBounded(
    Readable.fromWeb(response.body),
    MAX_METADATA_BYTES,
  );
  const model = resolvePhysicalModel(
    JSON.parse(body.toString('utf8')),
    deploymentId,
  );
  if (!model) return;
  const temporary = `${outputFile}.tmp-${process.pid}`;
  await writeFile(temporary, `${model}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, outputFile);
}

export function createLiteLLMProxy({ upstream, outputFile }) {
  const upstreamOrigin = new URL(upstream);
  return createServer(async (request, response) => {
    try {
      const body = await readBounded(request, MAX_REQUEST_BYTES);
      const headers = { ...request.headers, host: upstreamOrigin.host };
      for (const header of HOP_BY_HOP) delete headers[header];
      const requestUrl = new URL(request.url ?? '/', 'http://loopback');
      const target = new URL(upstreamOrigin);
      target.pathname = requestUrl.pathname;
      target.search = requestUrl.search;
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers,
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : body,
        redirect: 'manual',
      });
      try {
        await recordResolvedModel(
          upstream,
          request.headers.authorization,
          upstreamResponse.headers.get('x-litellm-model-id'),
          outputFile,
        );
      } catch {
        // Telemetry is best-effort and must never replace a valid inference
        // response when model metadata is unavailable or malformed.
      }
      response.writeHead(
        upstreamResponse.status,
        Object.fromEntries(
          [...upstreamResponse.headers].filter(
            ([name]) => !HOP_BY_HOP.has(name.toLowerCase()),
          ),
        ),
      );
      if (upstreamResponse.body) {
        await pipeline(Readable.fromWeb(upstreamResponse.body), response);
      } else {
        response.end();
      }
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end('upstream request failed\n');
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const upstream = process.env.OPENCODE_PROXY_UPSTREAM;
  const outputFile = process.env.OPENCODE_PROXY_RESOLVED_MODEL_FILE;
  const portFile = process.env.OPENCODE_PROXY_PORT_FILE;
  if (!upstream || !outputFile || !portFile) process.exit(2);
  const server = createLiteLLMProxy({ upstream, outputFile });
  server.listen(0, '127.0.0.1', async () => {
    const address = server.address();
    if (!address || typeof address === 'string') process.exit(2);
    await writeFile(portFile, `${address.port}\n`, { mode: 0o600 });
  });
}
