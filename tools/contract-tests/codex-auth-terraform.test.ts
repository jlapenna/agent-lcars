import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const terraform = readFileSync(
  path.join(repoRoot, 'infra/terraform/main.tf'),
  'utf8',
);
const codexLane = readFileSync(
  path.join(repoRoot, '.github/workflows/agent-lane.yml'),
  'utf8',
);
const codexShim = readFileSync(
  path.join(repoRoot, '.github/workflows/agent-lane-codex.yml'),
  'utf8',
);

describe('Codex auth Terraform retirement (#761)', () => {
  it('keeps runtime access on the versioned GCS CAS store', () => {
    expect(terraform).toContain(
      'resource "google_storage_bucket" "codex_auth"',
    );
    expect(terraform).toContain(
      'resource "google_storage_bucket_iam_member" "codex_auth_runtime"',
    );
    expect(terraform).toContain(
      'resource "google_storage_bucket_iam_member" "codex_auth_shared_lease_runtime"',
    );
    expect(terraform).toContain(
      'resource "google_storage_bucket_iam_member" "apphosting_codex_auth_broker"',
    );
    expect(terraform).toContain('objects/_leases/codex-subscription.json');
    expect(terraform).toContain('storage.objects.create');
    expect(terraform).toContain('storage.objects.get');
    expect(terraform).toContain('storage.objects.delete');
  });

  it('contains no legacy Codex Secret Manager containers or runtime grants', () => {
    for (const retired of [
      'resource "google_secret_manager_secret" "codex_auth"',
      'resource "google_secret_manager_secret" "homelab_codex_auth"',
      'resource "google_secret_manager_secret" "fleet_codex_auth"',
      'resource "google_secret_manager_secret_iam_member" "codex_auth_accessor"',
      'resource "google_secret_manager_secret_iam_member" "codex_auth_version_adder"',
      'resource "google_secret_manager_secret_iam_member" "homelab_codex_auth_accessor"',
      'resource "google_secret_manager_secret_iam_member" "homelab_codex_auth_version_adder"',
      'resource "google_secret_manager_secret_iam_member" "fleet_codex_auth_accessor"',
      'resource "google_secret_manager_secret_iam_member" "fleet_codex_auth_version_adder"',
      'CODEX_AUTH_JSON',
      'HOMELAB_CODEX_AUTH_JSON',
      'WWW_CODEX_AUTH_JSON',
      'GIROSF_CODEX_AUTH_JSON',
      'NX_CACHE_SERVER_CODEX_AUTH_JSON',
      'SYNC_PADD_CODEX_AUTH_JSON',
    ]) {
      expect(terraform).not.toContain(retired);
    }
  });

  it('does not publish or execute the retired Secret Manager compatibility path', () => {
    expect(codexShim).not.toContain('codex-auth-secret-name');
    expect(codexLane).not.toContain('codex-auth-secret-name');
    expect(codexLane).not.toContain('LEGACY_CODEX_AUTH_SECRET_NAME');
    expect(codexLane).not.toContain('auth-store=secret-manager');
  });
});
