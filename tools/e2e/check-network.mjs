#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Validate an operator-provided namespace; never change host networking. */
export function checkNetworkBoundary(
  mode = process.env.E2E_NETWORK_MODE ?? 'host',
) {
  if (mode === 'host') return { mode };
  if (mode !== 'loopback') {
    throw new Error('E2E_NETWORK_MODE must be host or loopback.');
  }
  if (os.platform() !== 'linux') {
    throw new Error(
      'Loopback mode requires a prepared Linux network namespace.',
    );
  }
  // /proc/self/net follows this process's namespace, including unconfigured
  // interfaces. Address enumeration alone would miss a down/unnumbered veth.
  const interfaces = fs
    .readFileSync('/proc/self/net/dev', 'utf8')
    .split('\n')
    .slice(2)
    .filter((line) => line.includes(':'))
    .map((line) => line.slice(0, line.indexOf(':')).trim());
  const addresses = os.networkInterfaces().lo ?? [];
  if (
    interfaces.length !== 1 ||
    interfaces[0] !== 'lo' ||
    !addresses.some((address) => address.address === '127.0.0.1') ||
    addresses.some((address) => !address.internal)
  ) {
    throw new Error(
      'Loopback mode requires only an active lo interface. Run the entire E2E helper in a prepared PrivateNetwork unit, including emulators, app and browser.',
    );
  }
  return {
    mode,
    namespace: fs.readlinkSync('/proc/self/ns/net'),
    interfaces,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(`e2e-network: ${JSON.stringify(checkNetworkBoundary())}`);
  } catch (error) {
    console.error(`e2e-network: ${error.message}`);
    process.exitCode = 1;
  }
}
