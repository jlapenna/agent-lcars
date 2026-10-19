import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  labOptions,
  measure,
  seed,
  tlsCertificate,
  tlsLaunchOptions,
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
      await expect(seed(unrelatedOrigin, tls)).rejects.toThrow(
        /self-signed certificate/,
      );
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
      ),
    ).toEqual({
      path: '/inbox',
      protocol: 'h2',
      status: 200,
      headers: {
        'content-encoding': 'gzip',
        vary: 'A'.repeat(256),
        'content-length': '123',
      },
    });
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
          ],
          transportResponses: ['/inbox', '/_next/static/chunks/a.js'].map(
            (path) => ({
              path,
              protocol: arm === 'h1' ? 'http/1.1' : 'h2',
              status: 200,
              headers: { 'content-encoding': 'gzip' },
            }),
          ),
          scriptCorpus: [
            {
              path: '/_next/static/chunks/a.js',
              sha256: 'same-decoded-bytes',
              decodedBytes: 100,
              encodedBytes: 50,
            },
          ],
        })),
      ).flat(),
    },
  }));
}

describe('transport cohort qualification', () => {
  it('summarizes exactly 30 observations per arm/cache without making a missed budget fail', () => {
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
