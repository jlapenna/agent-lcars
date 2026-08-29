import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const lane = readFileSync(
  path.join(repoRoot, '.github/workflows/agent-lane.yml'),
  'utf8',
);
const directStore = readFileSync(
  path.join(repoRoot, 'apps/console/src/lib/codex-auth-store.ts'),
  'utf8',
);
const runsRouter = readFileSync(
  path.join(repoRoot, 'apps/console/src/lib/runs-router.ts'),
  'utf8',
);
const credentialsGuide = readFileSync(
  path.join(repoRoot, 'docs/fleet-credentials.md'),
  'utf8',
);

describe('Codex subscription lease contract', () => {
  it('has one generation-CAS lease object shared by hosted and direct executors', () => {
    expect(directStore).toContain(
      "CODEX_GLOBAL_LEASE_OBJECT = '_leases/codex-subscription.json'",
    );
    expect(directStore).toContain('expiresAt: string;');
    expect(lane).toContain(
      'CODEX_AUTH_LEASE_OBJECT: gs://agent-lcars-codex-auth/_leases/codex-subscription.json',
    );
    expect(lane).toContain('"expiresAt": sys.argv[4]');
    expect(lane).toContain('CODEX_AUTH_LEASE_DURATION_MINUTES');
    expect(lane).toContain('actions/runs/$GITHUB_RUN_ID');
    expect(lane).toContain('get("run_started_at")');
    expect(lane).toContain('inputs.job-timeout-minutes');
    expect(lane).toContain('datetime.timedelta(minutes=minutes)');
    expect(lane).not.toContain(
      'date -u -d "+${CODEX_AUTH_LEASE_DURATION_MINUTES} minutes"',
    );
    expect(lane).toContain('--if-generation-match=0');
    expect(lane).toContain('--if-generation-match="$generation"');
  });

  it('holds the hosted lease across restore and persistence, then releases it best effort', () => {
    const acquire = lane.indexOf('- name: Acquire Codex subscription lease');
    const restore = lane.indexOf('- name: Restore subscription authentication');
    const persist = lane.indexOf(
      '- name: Persist refreshed subscription authentication',
    );
    const release = lane.indexOf('- name: Release Codex subscription lease');

    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(acquire).toBeLessThan(restore);
    expect(restore).toBeLessThan(persist);
    expect(persist).toBeLessThan(release);
    expect(lane).toContain("steps.codex-auth-lease.outcome == 'success'");
    expect(lane).toContain('it expires automatically');
  });

  it('does not launder a Codex refresh failure from hosted execution into a credential rotation', () => {
    // This is a workflow-boundary contract: its consumer is the required
    // Verify job, which blocks a hosted lane regression before it can write
    // a burned generation back to the credential store.
    expect(lane).toContain('mkfifo "$codex_stderr_pipe"');
    expect(lane).toContain(
      'tee "$RUNNER_TEMP/codex-stderr.log" < "$codex_stderr_pipe" >&2 &',
    );
    expect(lane).toContain('codex_stderr_tee_pid=$!');
    expect(lane).toContain('wait "$codex_stderr_tee_pid" || true');
    const stderrTee = lane.indexOf(
      'tee "$RUNNER_TEMP/codex-stderr.log" < "$codex_stderr_pipe" >&2 &',
    );
    const stderrWait = lane.indexOf('wait "$codex_stderr_tee_pid" || true');
    const persist = lane.indexOf(
      '- name: Persist refreshed subscription authentication',
    );
    expect(stderrTee).toBeGreaterThanOrEqual(0);
    expect(stderrTee).toBeLessThan(stderrWait);
    expect(stderrWait).toBeLessThan(persist);
    expect(lane).toContain(
      'codex_failure_messages="$RUNNER_TEMP/codex-failure-messages"',
    );
    expect(lane).toContain(
      '.type == "error" and (.message | type) == "string"',
    );
    expect(lane).toContain(
      '.type == "turn.failed" and (.error.message | type) == "string"',
    );
    expect(lane).toContain(
      'grep -qF -- \'Your access token could not be refreshed\' "$codex_failure_messages" "$codex_stderr"',
    );
    expect(lane).toContain(
      'grep -qF -- \'refresh token was already used\' "$codex_failure_messages" "$codex_stderr"',
    );
    expect(runsRouter).toContain("result = { status: 'skipped-burned' }");
    expect(lane).toContain('--if-generation-match="$RESTORED_GENERATION"');
    expect(lane).toContain(
      'Could not release the Codex subscription lease; it expires automatically.',
    );
  });

  it('enables one shared authority for hosted and direct Codex execution', () => {
    expect(lane).toContain(
      "if: ${{ inputs.pipeline == 'codex' && inputs.codex-shared-lease }}",
    );
    expect(lane).toContain(
      "if: always() && inputs.pipeline == 'codex' && inputs.codex-shared-lease && steps.codex-auth-lease.outcome == 'success'",
    );
    expect(lane).toContain('default: true');
    expect(credentialsGuide).toContain(
      'svc:telemetry-writer` `work.executor` grant covers `claude`,',
    );
    expect(credentialsGuide).toContain('`codex`, and `opencode`.');
    expect(credentialsGuide).toContain(
      'AGENT_LCARS_UNIFIED_QUEUE_ENABLED=true',
    );
    expect(credentialsGuide).toContain('LCARS_CODEX_SHARED_LEASE_ENABLED=true');
  });
});
