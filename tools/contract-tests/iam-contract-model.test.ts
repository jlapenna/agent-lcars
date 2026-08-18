import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// The IAM contract's live half runs on a schedule against GitHub and GCP.
// These assertions are the credential-free half: they keep the checked-in
// model internally coherent, tied to Terraform, and actually wired into a
// scheduled workflow - the three ways a live checker rots without anyone
// noticing (jlapenna/agent-lcars#1376).

const repoRoot = path.resolve(import.meta.dirname, '../..');
const modelPath = path.join(repoRoot, 'tools/iam-contract/model.json');
const checkerPath = path.join(repoRoot, 'tools/iam-contract/check.mjs');
const workflowPath = path.join(
  repoRoot,
  '.github/workflows/iam-contract-audit.yml',
);

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
const checker = fs.readFileSync(checkerPath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');

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
      if (app.checkable) continue;
      expect(app.uncheckableReason ?? '').not.toHaveLength(0);
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

  it('runs every section the checker implements from the scheduled workflow', () => {
    const declared = checker.match(
      /const ALL_SECTIONS = \[([^\]]+)\]/,
    ) as RegExpMatchArray;
    const sections = [...declared[1].matchAll(/'([^']+)'/g)].map(
      (match) => match[1],
    );
    expect(sections.length).toBeGreaterThan(0);
    const invoked = new Set(
      [...workflow.matchAll(/check\.mjs --sections ([\w,-]+)/g)].flatMap(
        (match) => match[1].split(','),
      ),
    );
    // A section added to the checker but wired into no job would look like
    // coverage while asserting nothing.
    expect([...invoked].sort()).toEqual([...sections].sort());
  });

  it('runs the audit on a daily schedule', () => {
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron: '[^']+'/);
  });
});
