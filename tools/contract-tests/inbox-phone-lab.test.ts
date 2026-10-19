import { execFile, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  labOptions,
  measure,
  seed,
  stopTransportChild,
  tlsCertificate,
  tlsLaunchOptions,
  transportBuildHashes,
  transportExperiment,
  transportResponse,
  transportSummary,
} from '../e2e/measure-inbox-phone.mjs';

const environment = {
  E2E_HERMETIC: '1',
  PROJECT_ID: 'demo-no-project',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:4362',
};
const options = ['--origin', 'http://localhost:4204', '--out', '/tmp/lab.json'];

describe('phone performance lab safety boundary', () => {
  it('writes startup diagnostics without seeding when Chromium cannot launch', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'inbox-phone-launch-'),
    );
    const out = path.join(directory, 'failed.json');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.stubEnv(
      'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
      '/definitely-not-a-browser',
    );
    try {
      await expect(
        measure({ origin: 'http://localhost:4204', samples: 5, out }),
      ).rejects.toThrow();
      const report = JSON.parse(await readFile(out, 'utf8'));
      expect(report.error).toContain('/definitely-not-a-browser');
      expect(report.samples).toEqual([]);
      expect(report.summary).toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true });
    }
  });
  it.each([
    'https://lcars.jlapenna.net',
    'http://10.0.0.1:4204',
    'http://localhost:4204/inbox',
    'http://user:password@localhost:4204',
    'http://localhost:4204?redirect=example.com',
  ])('rejects unsafe origin %s before any fixture mutation', (origin) => {
    expect(() =>
      labOptions(['--origin', origin, '--out', '/tmp/lab.json'], environment),
    ).toThrow();
  });
  it.each([
    { ...environment, E2E_HERMETIC: '0' },
    { ...environment, PROJECT_ID: 'agent-lcars' },
    { ...environment, FIRESTORE_EMULATOR_HOST: '10.0.0.1:8080' },
  ])('rejects a non-hermetic environment', (env) => {
    expect(() => labOptions(options, env)).toThrow();
  });
  it.each(['0', '4', '61', '1.5', 'NaN'])(
    'rejects unbounded or undersampled count %s',
    (count) => {
      expect(() =>
        labOptions([...options, '--samples', count], environment),
      ).toThrow();
    },
  );
  it('accepts the bounded loopback profile and requires an artifact destination', () => {
    expect(labOptions(options, environment)).toMatchObject({
      origin: 'http://localhost:4204',
      samples: 30,
      out: '/tmp/lab.json',
    });
    expect(() =>
      labOptions(['--origin', 'http://localhost:4204'], environment),
    ).toThrow('Provide --out');
  });
});

// These controls exercise real Node TLS without launching a browser or proxy.
// Browser SPKI controls live in the opt-in qualified-sandbox spec.
describe('opt-in loopback TLS diagnostic', () => {
  let directory: string;
  let cert: string;
  let key: string;
  let unrelatedCert: string;
  let unrelatedKey: string;
  const args = (origin = 'https://127.0.0.1:4204') => [
    '--origin',
    origin,
    '--out',
    '/tmp/tls-lab.json',
    '--tls-diagnostic',
    '--tls-certificate',
    cert,
  ];
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'inbox-tls-contract-'));
    for (const name of ['selected', 'unrelated']) {
      await promisify(execFile)(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-sha256',
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=IP:127.0.0.1,DNS:localhost',
          '-out',
          path.join(directory, `${name}.pem`),
          '-keyout',
          path.join(directory, `${name}.key`),
        ],
        { timeout: 15_000, maxBuffer: 64 * 1024 },
      );
    }
    cert = path.join(directory, 'selected.pem');
    key = path.join(directory, 'selected.key');
    unrelatedCert = path.join(directory, 'unrelated.pem');
    unrelatedKey = path.join(directory, 'unrelated.key');
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps default launch options unchanged and derives exactly one SPKI allowlist', () => {
    expect(tlsLaunchOptions(undefined)).toEqual({});
    expect(labOptions(options, environment)).not.toHaveProperty('tls');
    const parsed = labOptions(args(), environment);
    const x509 = new X509Certificate(readFileSync(cert));
    const expected = createHash('sha256')
      .update(x509.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    expect(parsed.tls.spkiSHA256).toBe(expected);
    expect(parsed.tls.certificateSHA256).toBe(
      createHash('sha256').update(x509.raw).digest('hex'),
    );
    expect(tlsLaunchOptions(parsed.tls)).toEqual({
      args: [`--ignore-certificate-errors-spki-list=${expected}`],
    });
    expect(labOptions(args('https://localhost:4204'), environment).origin).toBe(
      'https://localhost:4204',
    );
  });

  it.each([
    ['--origin', 'https://localhost:4204', '--out', '/tmp/lab.json'],
    [
      '--origin',
      'https://localhost:4204',
      '--out',
      '/tmp/lab.json',
      '--tls-diagnostic',
    ],
    [
      '--origin',
      'http://localhost:4204',
      '--out',
      '/tmp/lab.json',
      '--tls-diagnostic',
    ],
  ])(
    'refuses an incomplete TLS opt-in before certificate, browser or seed work (%j)',
    (...argv) => {
      expect(() => labOptions(argv, environment)).toThrow('TLS requires');
    },
  );
  it('refuses certificate without flag, or TLS flags with an HTTP origin/profile', () => {
    expect(() =>
      labOptions(
        [
          '--origin',
          'https://localhost:4204',
          '--out',
          '/tmp/a',
          '--tls-certificate',
          cert,
        ],
        environment,
      ),
    ).toThrow('TLS requires');
    expect(() =>
      labOptions(args('http://localhost:4204'), environment),
    ).toThrow('TLS requires');
    expect(() =>
      labOptions([...args(), '--cpu-profile-out', '/tmp/profile'], environment),
    ).toThrow('TLS requires');
  });
  it.each([
    'https://lcars.jlapenna.net',
    'https://10.0.0.1',
    'https://user:password@127.0.0.1',
    'https://127.0.0.1/inbox',
    'https://127.0.0.1?x=y',
    'https://127.0.0.1/#fragment',
  ])('rejects unsafe HTTPS destination %s', (origin) => {
    expect(() => labOptions(args(origin), environment)).toThrow(
      'Only explicit loopback',
    );
  });
  it.each([
    { ...environment, PROJECT_ID: 'production' },
    { ...environment, E2E_HERMETIC: '0' },
    { ...environment, FIRESTORE_EMULATOR_HOST: '10.0.0.1:8080' },
    {
      ...environment,
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080/not-an-emulator',
    },
    { ...environment, FIRESTORE_EMULATOR_HOST: 'user:password@127.0.0.1:8080' },
    { ...environment, AUTH_SECRET: 'not-dummy' },
    { ...environment, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ])('rejects unsafe TLS environment %j', (env) => {
    expect(() => labOptions(args(), env)).toThrow();
  });
  it('refuses non-certificate bytes, multiple certificates, wrong hostname and a shared certificate directory', async () => {
    const invalid = path.join(directory, 'invalid.pem');
    await writeFile(invalid, 'not a public certificate');
    expect(() => tlsCertificate(invalid, '127.0.0.1')).toThrow(
      'public certificate',
    );
    await writeFile(invalid, (await readFile(cert, 'utf8')).repeat(2));
    expect(() => tlsCertificate(invalid, '127.0.0.1')).toThrow(
      'public certificate',
    );
    expect(() => tlsCertificate(cert, 'remote.invalid')).toThrow(
      'loopback host',
    );
    await chmod(directory, 0o755);
    try {
      expect(() => tlsCertificate(cert, '127.0.0.1')).toThrow('task-local');
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it('refuses experiment setup without its exact boolean opt-in before downloading or launching anything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      for (const value of ['', '0', 'true', 'yes']) {
        vi.stubEnv('E2E_INBOX_TLS_DIAGNOSTIC', value);
        await expect(
          transportExperiment({
            origin: 'http://127.0.0.1:4204',
            out: path.join(directory, 'never.json'),
          }),
        ).rejects.toThrow('exact hermetic opt-in');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('seeds using the explicit CA and refuses an unrelated real certificate without posting', async () => {
    const tls = labOptions(args(), environment).tls;
    let selectedPosts = 0;
    let unrelatedPosts = 0;
    const selected = createHttpsServer(
      { cert: await readFile(cert), key: await readFile(key) },
      (req, res) => {
        if (req.method === 'POST' && req.url === '/api/e2e/seed')
          selectedPosts++;
        res.end('{}');
      },
    );
    const unrelated = createHttpsServer(
      {
        cert: await readFile(unrelatedCert),
        key: await readFile(unrelatedKey),
      },
      (_req, res) => {
        unrelatedPosts++;
        res.end('{}');
      },
    );
    const listen = async (server: ReturnType<typeof createHttpsServer>) => {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('No TLS fixture port');
      return `https://127.0.0.1:${address.port}`;
    };
    try {
      const selectedOrigin = await listen(selected);
      const unrelatedOrigin = await listen(unrelated);
      await seed(selectedOrigin, tls);
      await expect(seed(unrelatedOrigin, tls)).rejects.toMatchObject({
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      });
      expect(selectedPosts).toBe(1);
      expect(unrelatedPosts).toBe(0);
    } finally {
      await Promise.all(
        [selected, unrelated].map(async (server) => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }),
      );
    }
  });

  it('selects the actual Inbox Document and excludes otherwise identical Fetch/RSC responses and their private metadata', () => {
    const response = {
      url: 'https://127.0.0.1:4204/inbox?item=private-item&_rsc=private-rsc',
      protocol: 'h2',
      status: 200,
      headers: {
        'content-encoding': 'gzip',
        'set-cookie': 'private-cookie',
        'x-private': 'private-header',
      },
    };
    const document = transportResponse(
      response,
      'https://127.0.0.1:4204',
      'Document',
    );
    expect(document).toMatchObject({
      path: '/inbox',
      type: 'Document',
      protocol: 'h2',
      encoding: 'gzip',
    });
    expect(JSON.stringify(document)).not.toContain('private-');
    expect(
      transportResponse(response, 'https://127.0.0.1:4204', 'Fetch'),
    ).toBeUndefined();
    expect(
      transportResponse(response, 'https://127.0.0.1:4204', undefined),
    ).toBeUndefined();
  });

  it('retains only safe bounded response fields and removes URL queries', () => {
    expect(
      transportResponse(
        {
          url: 'https://127.0.0.1:4204/inbox?item=private',
          protocol: 'h2',
          status: 200,
          headers: {
            'Set-Cookie': 'secret',
            Authorization: 'secret',
            'Content-Encoding': 'gzip',
            Vary: 'A'.repeat(500),
            'Content-Length': '123',
          },
        },
        'https://127.0.0.1:4204',
        'Document',
      ),
    ).toEqual({
      path: '/inbox',
      type: 'Document',
      protocol: 'h2',
      status: 200,
      encoding: 'gzip',
      headers: {
        'content-encoding': 'gzip',
        vary: 'A'.repeat(256),
        'content-length': '123',
      },
    });
    expect(
      transportResponse(
        {
          url: 'https://127.0.0.1:4204/_next/static/tiny.js',
          protocol: 'h2',
          status: 200,
          headers: {},
        },
        'https://127.0.0.1:4204',
      ).encoding,
    ).toBe('identity');
    for (const url of [
      'https://remote.invalid/_next/static/a.js',
      'https://127.0.0.1:4204/api/auth/session',
      'https://127.0.0.1:4204/_next/static/a.js?private=secret',
    ])
      expect(
        transportResponse({ url, headers: {} }, 'https://127.0.0.1:4204'),
      ).toBeUndefined();
  });
});

function transportBlocks() {
  return ['h1', 'h2', 'h2', 'h1'].map((arm) => ({
    arm,
    report: {
      sourceRevision: 'same-head',
      browserVersion: 'same-browser',
      profile: { cpuSlowdown: 4 },
      transport: {
        certificateSHA256: 'same-cert',
        spkiSHA256: 'same-spki',
        buildHashes: { BUILD_ID: 'same-build' },
      },
      samples: Array.from({ length: 15 }, (_, index) =>
        ['cold', 'warm'].map((cache) => ({
          cache,
          readyMs: 2_001 + index,
          nextHopProtocol: arm === 'h1' ? 'http/1.1' : 'h2',
          resources: [
            {
              path: '/_next/static/chunks/a.js',
              nextHopProtocol: arm === 'h1' ? 'http/1.1' : 'h2',
            },
            {
              path: '/_next/static/chunks/tiny.js',
              nextHopProtocol: arm === 'h1' ? 'http/1.1' : 'h2',
            },
          ],
          transportResponses: [
            '/inbox',
            '/_next/static/chunks/a.js',
            '/_next/static/chunks/tiny.js',
          ].map((path) => ({
            path,
            type: path === '/inbox' ? 'Document' : 'Script',
            encoding: path.endsWith('/tiny.js') ? 'identity' : 'gzip',
            protocol: arm === 'h1' ? 'http/1.1' : 'h2',
            status: 200,
            headers: path.endsWith('/tiny.js')
              ? {}
              : { 'content-encoding': 'gzip' },
          })),
          scriptCorpus: [
            {
              path: '/_next/static/chunks/a.js',
              sha256: 'same-decoded-bytes',
              decodedBytes: 100,
              encodedBytes: 50,
            },
            {
              path: '/_next/static/chunks/tiny.js',
              sha256: 'same-tiny-decoded-bytes',
              encodedBytes: 314,
              decodedBytes: 314,
            },
          ],
        })),
      ).flat(),
    },
  }));
}

describe('transport cohort qualification', () => {
  it('accepts mixed gzip and tiny identity scripts with separate n30 summaries despite a budget miss', () => {
    const summary = transportSummary(transportBlocks());
    expect(summary.h1.cold).toEqual({
      n: 30,
      p50Ms: 2008,
      p95Ms: 2015,
      maxMs: 2015,
      targetMet: false,
    });
    expect(summary.h2.warm.n).toBe(30);
  });
  it.each([
    'protocol',
    'resource-protocol',
    'gzip',
    'static-bytes',
    'encoded-bytes',
    'encoding-change',
    'build',
    'browser',
    'partial',
    'failure',
    'order',
  ])('rejects %s confounding without producing a summary', (kind) => {
    const blocks = transportBlocks();
    const sample = blocks[1].report.samples[0];
    if (kind === 'protocol') sample.nextHopProtocol = 'http/1.1';
    if (kind === 'resource-protocol')
      sample.resources[0].nextHopProtocol = 'http/1.1';
    if (kind === 'gzip')
      sample.transportResponses[0].headers['content-encoding'] = 'br';
    if (kind === 'encoding-change')
      sample.transportResponses[2].headers['content-encoding'] = 'gzip';
    if (kind === 'static-bytes') sample.scriptCorpus[0].sha256 = 'different';
    if (kind === 'encoded-bytes') sample.scriptCorpus[0].encodedBytes++;
    if (kind === 'build')
      blocks[1].report.transport.buildHashes.BUILD_ID = 'different';
    if (kind === 'browser') blocks[1].report.browserVersion = 'different';
    if (kind === 'partial') blocks[1].report.samples.pop();
    if (kind === 'failure')
      Object.assign(blocks[1].report, { error: 'preserved failure' });
    if (kind === 'order') [blocks[0], blocks[1]] = [blocks[1], blocks[0]];
    expect(() => transportSummary(blocks)).toThrow();
  });
});

describe('TLS diagnostic hermetic forwarding', () => {
  it('forwards only exact 1, rejects other booleans before tooling, and keeps caller TLS controls out', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'tls-env-boundary-'),
    );
    const shellQuote = (value: string) =>
      "'" + value.replaceAll("'", "'\\''") + "'";
    const probe = path.join(directory, 'probe.mjs');
    const node = path.join(directory, 'node');
    const pnpm = path.join(directory, 'pnpm');
    const witness = path.join(directory, 'called');
    await writeFile(
      probe,
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(witness)}, 'called'); process.stdout.write(JSON.stringify({optin: process.env.E2E_INBOX_TLS_DIAGNOSTIC ?? null, cert: process.env.INBOX_TLS_CERTIFICATE ?? null, flags: process.env.CHROMIUM_FLAGS ?? null}));`,
    );
    await writeFile(
      node,
      `#!/bin/sh\ncase "$1" in */tools/e2e/check-browser.mjs) exit 0 ;; esac\nexec ${shellQuote(process.execPath)} "$@"\n`,
    );
    await writeFile(
      pnpm,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(probe)}\n`,
    );
    await chmod(node, 0o755);
    await chmod(pnpm, 0o755);
    const run = (value: string) =>
      promisify(execFile)('bash', [path.resolve('tools/e2e-local.sh')], {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          E2E_INBOX_TLS_DIAGNOSTIC: value,
          E2E_LOCAL_LOCK_FILE: path.join(directory, `lock-${value || 'unset'}`),
          INBOX_TLS_CERTIFICATE: 'must-not-forward',
          CHROMIUM_FLAGS: 'must-not-forward',
        },
      });
    try {
      await expect(run('true')).rejects.toThrow('must be exactly 1 or unset');
      await expect(readFile(witness)).rejects.toThrow();
      await expect(
        readFile(path.join(directory, 'lock-true')),
      ).rejects.toThrow();
      expect(JSON.parse((await run('1')).stdout)).toEqual({
        optin: '1',
        cert: null,
        flags: null,
      });
      expect(JSON.parse((await run('')).stdout)).toEqual({
        optin: null,
        cert: null,
        flags: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('transport build evidence at the supported Next16 layout', () => {
  it('binds emitted per-route manifests without requiring legacy root manifests and fails on missing evidence', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tls-next-layout-'));
    const files = [
      'BUILD_ID',
      'server/app/inbox/page_client-reference-manifest.js',
      'server/app/inbox/page/build-manifest.json',
    ];
    try {
      for (const file of files) {
        await mkdir(path.dirname(path.join(directory, file)), {
          recursive: true,
        });
        await writeFile(path.join(directory, file), `emitted ${file}`);
      }
      const hashes = await transportBuildHashes(directory);
      expect(Object.keys(hashes)).toEqual(files);
      expect(hashes.BUILD_ID).toBe(
        createHash('sha256').update('emitted BUILD_ID').digest('hex'),
      );
      await rm(path.join(directory, files[2]));
      await expect(transportBuildHashes(directory)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('transport child deadline cleanup', () => {
  it('reaps an already-terminating owned helper without interrupting its diagnostic flush with a second TERM', async () => {
    const child = spawn(process.execPath, [
      '-e',
      `let signals = 0; process.on('SIGTERM', () => { signals++; process.stdout.write('stopping\\n'); setTimeout(() => { process.stdout.write('flushed:' + signals); process.exit(0); }, 80); }); setInterval(() => {}, 1000); process.stdout.write('ready\\n');`,
    ]);
    try {
      await once(child.stdout, 'data');
      const stopping = once(child.stdout, 'data');
      child.kill('SIGTERM');
      await stopping;
      let remaining = '';
      child.stdout.on('data', (bytes) => {
        remaining += bytes.toString();
      });
      await stopTransportChild(child);
      expect(remaining).toBe('flushed:1');
      expect(child.exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
