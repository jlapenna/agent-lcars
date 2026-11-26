const { fork } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const root = process.env.SMOKE_FIXTURE_ROOT;
const kind = process.env.SMOKE_FIXTURE_KIND;
const foreign = process.argv.includes('--foreign');
const record = (file, value) =>
  appendFileSync(path.join(root, file), `${JSON.stringify(value)}\n`);
record('processes.jsonl', { pid: process.pid, foreign });
let attempt = 0;
if (!foreign) {
  record('attempts.jsonl', { port: process.env.PORT });
  attempt = readFileSync(path.join(root, 'attempts.jsonl'), 'utf8')
    .trim()
    .split('\n').length;
}
const port = Number(process.env.PORT);
const host = '127.0.0.1';

function failBind(error) {
  console.error(error);
  process.exitCode = 1;
}

function listen() {
  const server = http.createServer((req, res) => {
    record('requests.jsonl', {
      foreign,
      method: req.method,
      url: req.url,
      signature: req.headers['x-hub-signature-256'],
    });
    if (kind === 'hung-response' && !foreign) return;
    res.writeHead(401);
    if (kind === 'hung-body' && !foreign) {
      res.flushHeaders();
      return;
    }
    res.end('fixture refusal');
  });
  server.on('error', (error) => {
    failBind(error);
    // Leave time for a premature probe to reach the separate 401 listener.
    if (kind === 'collision-once' && !foreign) {
      setTimeout(() => process.exit(1), 1_200);
    }
  });
  server.listen(port, host, () => {
    if (foreign) {
      process.send('listening');
      process.disconnect();
    } else if (kind === 'no-readiness') {
      // Deterministic ambient ingress must not be attributed to the smoke.
      http
        .get(`http://127.0.0.1:${process.env.PORT}/`, (res) => res.resume())
        .on('error', () => undefined);
    } else console.log('Ready in 1ms');
  });
}
if (foreign) listen();
else if (kind === 'startup-error') {
  console.error('Missing traced dependency');
  process.exit(1);
} else if (kind === 'collision-always') {
  // Reserve the candidate in this boot process. The second bind still goes
  // through the kernel, and the reservation dies with this attempt.
  const blocker = net.createServer((socket) => socket.destroy());
  blocker.on('error', failBind);
  blocker.listen(port, host, () => {
    blocker.unref();
    listen();
  });
} else if (kind === 'collision-once' && attempt === 1) {
  const child = fork(__filename, ['--foreign'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  child.once('message', listen);
} else listen();
