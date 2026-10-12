import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// This repo owns the MODEL of the fleet's identity state. Comparing it to
// live GitHub and GCP is drift detection, which is monitoring, and monitoring
// lives in one place in this fleet: jlapenna/homelab's observability layer
// (bin/emit-iam-contract-metrics.py reads this file from main and publishes
// node_homelab_iam_contract_* for node-exporter).
//
// What belongs here is the offline half - the model must stay internally
// coherent and tied to the Terraform it describes, which needs no credentials
// and is a real test (jlapenna/agent-lcars#1376).

const repoRoot = path.resolve(import.meta.dirname, '../..');
const modelPath = path.join(repoRoot, 'tools/iam-contract/model.json');

type Provider = {
  attributeCondition?: string | null;
};
type Pool = {
  providers?: Record<string, Provider>;
  providersListable?: boolean;
};
type Installation = {
  id: number;
  account: string;
  repositorySelection?: string;
  repositories?: string[];
};
type Model = {
  fleetRepositories: string[];
  fleetCoverageExceptions?: { repository: string; reason: string }[];
  githubApps: {
    slug: string;
    clientId: string;
    checkable: boolean;
    uncheckableReason?: string;
    permissions?: Record<string, string>;
    installations: Installation[];
  }[];
  gcpProjects: Record<
    string,
    {
      pools: Record<string, Pool>;
      userManagedKeyAllowlist?: { serviceAccount: string; reason: string }[];
    }
  >;
  secretIamPolicies: {
    project: string;
    secret: string;
    bindings: Record<string, string[]>;
  }[];
};

const model = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as Model;

/**
 * Reproduce `local.github_repositories` from infra/terraform without running
 * Terraform: the shared `github` pool's condition is generated from it, so a
 * repo added to one and not the other is exactly the drift this catches.
 */
function terraformFleetRepositories(): string[] {
  const variables = fs.readFileSync(
    path.join(repoRoot, 'infra/terraform/variables.tf'),
    'utf8',
  );
  const scalar = (name: string): string => {
    const match = variables.match(
      new RegExp(`variable "${name}" \\{[^}]*?default\\s*=\\s*"([^"]+)"`, 's'),
    );
    if (!match) throw new Error(`no default for variable ${name}`);
    return match[1];
  };
  const additionalBlock = variables.match(
    /variable "additional_fleet_repositories" \{.*?default\s*=\s*\[(.*?)\]/s,
  );
  if (!additionalBlock) {
    throw new Error('no default for variable additional_fleet_repositories');
  }
  const additional = [...additionalBlock[1].matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  return [
    `${scalar('github_owner')}/${scalar('github_repository')}`,
    scalar('sprinkles_repository'),
    scalar('homelab_repository'),
    ...additional,
  ];
}

describe('IAM contract model', () => {
  it('lists exactly the fleet repositories Terraform builds the shared pool from', () => {
    expect([...model.fleetRepositories].sort()).toEqual(
      [...terraformFleetRepositories()].sort(),
    );
  });

  it("pins the shared github pool's condition to that same generated string", () => {
    const condition =
      model.gcpProjects['agent-lcars'].pools['github'].providers?.['github']
        ?.attributeCondition;
    const generated = `assertion.repository in [${terraformFleetRepositories()
      .map((repository) => `'${repository}'`)
      .join(', ')}]`;
    expect(condition).toBe(generated);
  });

  it('documents why every unassertable App is unassertable', () => {
    for (const app of model.githubApps) {
      // Every App is either asserted against live GitHub, or says why not.
      // Written unconditionally so it keeps testing something once every App
      // is checkable, which is the state this repo is trying to reach.
      expect({
        slug: app.slug,
        explained: app.checkable || (app.uncheckableReason ?? '').length > 0,
      }).toEqual({ slug: app.slug, explained: true });
    }
  });

  it('gives every exemption a reason and a fleet repository', () => {
    for (const exception of model.fleetCoverageExceptions ?? []) {
      expect(model.fleetRepositories).toContain(exception.repository);
      expect(exception.reason).not.toHaveLength(0);
    }
    for (const project of Object.values(model.gcpProjects)) {
      for (const entry of project.userManagedKeyAllowlist ?? []) {
        expect(entry.serviceAccount).toMatch(/@.+\.iam\.gserviceaccount\.com$/);
        expect(entry.reason).not.toHaveLength(0);
      }
    }
  });
});
