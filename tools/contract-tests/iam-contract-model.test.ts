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

  it('models the permission set of every App', () => {
    // An App gaining a permission is the other half of what makes
    // repository_selection load-bearing: administration:write over "all
    // repositories" is admin over every repo in the account.
    for (const app of model.githubApps) {
      expect(Object.keys(app.permissions ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('records repository_selection for every installation', () => {
    // The autoscaler App's installations are both "all", which is exactly why
    // this has to be modelled: a scope widening must be drift, not a surprise.
    for (const app of model.githubApps) {
      for (const installation of app.installations) {
        expect({
          installation: installation.id,
          selection: installation.repositorySelection,
        }).toEqual({
          installation: installation.id,
          selection: expect.stringMatching(/^(all|selected)$/),
        });
      }
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

  it('keeps CLAUDE_CODE_OAUTH_TOKEN modelled as exactly one binding', () => {
    const entry = model.secretIamPolicies.find(
      (candidate) => candidate.secret === 'CLAUDE_CODE_OAUTH_TOKEN',
    );
    expect(entry?.bindings).toEqual({
      'roles/secretmanager.secretAccessor': [
        'serviceAccount:claude-token-reader@agent-lcars.iam.gserviceaccount.com',
      ],
    });
  });

  it('keeps every modelled provider condition tied to a real workflow file', () => {
    // The consumer asserts these refs against live GitHub. Here we only check
    // the shape, so a typo cannot reach the collector as an unresolvable ref.
    const pattern =
      /([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/\.github\/workflows\/([A-Za-z0-9_.-]+\.ya?ml)/g;
    const refs = new Set<string>();
    for (const project of Object.values(model.gcpProjects)) {
      for (const pool of Object.values(project.pools)) {
        for (const provider of Object.values(pool.providers ?? {})) {
          for (const match of (provider.attributeCondition ?? '').matchAll(
            pattern,
          )) {
            refs.add(match[0]);
          }
        }
      }
    }
    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/^[^/]+\/[^/]+\/\.github\/workflows\/[^/]+\.ya?ml$/);
    }
  });

  it('models every installation with an id, an account and a repository list', () => {
    for (const app of model.githubApps) {
      expect(app.installations.length).toBeGreaterThan(0);
      for (const installation of app.installations) {
        expect(Number.isInteger(installation.id)).toBe(true);
        expect(installation.account).not.toHaveLength(0);
      }
    }
    // Only a checkable App's repository list is asserted live, so only it has
    // to carry one; recording a guess for the other would be worse than
    // recording nothing.
    for (const app of model.githubApps.filter(
      (candidate) => candidate.checkable,
    )) {
      for (const installation of app.installations) {
        expect(installation.repositories).toBeDefined();
      }
    }
  });
});
