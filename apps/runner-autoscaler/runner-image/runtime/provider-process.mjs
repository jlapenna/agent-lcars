import { spawn } from 'node:child_process';
import { constants } from 'node:os';

// Called only for the workload, after credential/bootstrap setup. Arguments
// and output pass through unchanged; credentials never enter command argv.
const [command, ...args] = process.argv.slice(2);
if (!command) process.exit(127);
const child = spawn(command, args, { stdio: 'inherit' });
let spawnFailure;
let reporter;
let reportTimer;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('spawn', () => {
  // A spawned CLI may still fail authentication or never contact a model.
  // Transport failure leaves the durable observation unknown, not false.
  const runId = process.env.LCARS_RUN_ID;
  const token = process.env.LCARS_RUN_TOKEN;
  const consoleUrl = process.env.LCARS_CONSOLE_URL;
  if (!runId || !token || !consoleUrl) return;
  const url = `${consoleUrl}/api/work/v1/runs/${encodeURIComponent(runId)}/heartbeat`;
  reporter = spawn('curl', ['-sf', '--config', '-'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  // Match the bootstrap's stdin-only bearer discipline. Reporting may never
  // extend workload lifetime: quick exits can leave this observation unknown.
  reportTimer = setTimeout(() => reporter.kill('SIGKILL'), 6000);
  const finish = () => clearTimeout(reportTimer);
  reporter.on('error', finish);
  reporter.on('close', finish);
  reporter.stdin.on('error', () => {
    // Early report exit is best effort and cannot change workload status.
  });
  reporter.stdin.end(
    `url = ${JSON.stringify(url)}\nrequest = "POST"\n` +
      `header = ${JSON.stringify(`Authorization: Bearer ${token}`)}\n` +
      'header = "content-type: application/json"\n' +
      'connect-timeout = 2\nmax-time = 5\n' +
      'data = "{\\"providerProcessStarted\\":true}"\n',
  );
});
child.on('error', (error) => {
  // Failed exec is not a provider-start event. Avoid error text/argument leaks.
  spawnFailure = error.code === 'ENOENT' ? 127 : 126;
});
child.on('close', (code, signal) => {
  clearTimeout(reportTimer);
  reporter?.kill('SIGKILL');
  process.exit(spawnFailure ?? code ?? 128 + (constants.signals[signal] ?? 1));
});
