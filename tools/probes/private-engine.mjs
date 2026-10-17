#!/usr/bin/env node
// Task-owned Docker engine for qualification on a shared host (#2848).
//
// Any dockerd that shares the host network namespace manages host links:
// with --bridge=none it deletes the host's docker0 at startup
// (moby daemon_unix.go configureNetworking -> removeDefaultBridgeInterface),
// and with any other bridge setting it creates or reconfigures host links.
// Private data/exec roots, sockets and mount namespaces do not change that.
// This launcher therefore starts dockerd only inside a fresh network and
// mount namespace and proves the isolation before the daemon binary runs.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ISOLATION_REFUSED = 97;

// Runs as root inside the new namespaces, before exec of the daemon. Every
// check fails closed: an unreadable namespace link refuses the launch.
export const isolationGuard = `set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
refuse() { echo "private-engine: refusing to start dockerd: $1" >&2; exit ${ISOLATION_REFUSED}; }
own=$(readlink /proc/self/ns/net 2>/dev/null) || own=
host=$(readlink /proc/1/ns/net 2>/dev/null) || host=
[ -n "$own" ] && [ -n "$host" ] || refuse "cannot compare network namespaces"
[ "$own" != "$host" ] || refuse "network namespace is shared with PID 1 ($own)"
links=$(ip -o link show 2>/dev/null | awk -F': ' '{ sub(/@.*/, "", $2); print $2 }' | tr '\\n' ' ')
[ "$links" = "lo " ] || refuse "network namespace is not empty: $links"
[ "$(readlink /proc/self/ns/mnt)" != "$(readlink /proc/1/ns/mnt)" ] || refuse "mount namespace is shared with PID 1"
# Hide the production containerd and Docker runtime directories so dockerd
# starts its own managed containerd instead of attaching to the host one.
mount -t tmpfs -o mode=0711 lcars-private-engine /run/containerd
mount -t tmpfs -o mode=0711 lcars-private-engine /run/docker
exec "$@"`;

export function dockerdArgs(root, { dockerd = '/usr/bin/dockerd' } = {}) {
  return [
    dockerd,
    '--config-file=' + join(root, 'daemon.json'),
    '--data-root=' + join(root, 'data'),
    '--exec-root=' + join(root, 'exec'),
    '--host=unix://' + join(root, 'docker.sock'),
    '--pidfile=' + join(root, 'docker.pid'),
    // Inside the empty namespace these only affect that namespace.
    '--bridge=none',
    '--iptables=false',
    '--ip6tables=false',
    '--ip-forward=false',
    '--ip-masq=false',
    '--userland-proxy=false',
  ];
}

export function privateEngineCommand(
  root,
  { unshare = 'unshare', dockerd } = {},
) {
  return [
    unshare,
    '--net',
    '--mount',
    '--propagation',
    'private',
    '--',
    '/bin/sh',
    '-c',
    isolationGuard,
    'private-engine',
    ...dockerdArgs(root, { dockerd }),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [rootArg, ...extra] = process.argv.slice(2);
  // A unix socket path is limited to 108 bytes.
  if (!rootArg || extra.length || resolve(rootArg).length > 80)
    throw new Error('usage: private-engine.mjs <new-short-root-directory>');
  if (process.getuid() !== 0)
    throw new Error('private-engine must run as root');
  const root = resolve(rootArg);
  mkdirSync(root, { mode: 0o700 }); // Never reuse another engine's state.
  writeFileSync(join(root, 'daemon.json'), '{}\n');
  const [binary, ...args] = privateEngineCommand(root);
  const child = spawn(binary, args, { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
    process.on(signal, () => child.kill('SIGTERM'));
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
