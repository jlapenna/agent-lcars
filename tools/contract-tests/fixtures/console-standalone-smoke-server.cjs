const { fork } = require('node:child_process');
const { appendFileSync, readFileSync } = require('node:fs');
const http = require('node:http');
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
    console.error(error);
    // Slow exit permits the old script to falsely probe another listener.
    setTimeout(() => process.exit(1), 1_200);
  });
  server.listen(Number(process.env.PORT), '127.0.0.1', () => {
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
} else if (
  kind === 'collision-always' ||
  (kind === 'collision-once' && attempt === 1)
) {
  const child = fork(__filename, ['--foreign'], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.once('message', listen);
} else listen();
