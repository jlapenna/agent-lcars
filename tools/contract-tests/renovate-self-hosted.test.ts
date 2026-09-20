import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

type RenovateConfig = {
  repositories?: string[];
  packageRules?: Array<Record<string, unknown>>;
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

// Extracts the backtick-quoted `owner/repo` names out of docs/renovate.md's
// "Hosted app" table row -- the doc, not this preset's own prose
// description, is the contract's source of truth (renovate-preset.json says
// so explicitly: "do not infer it from this list, which is prose, not a
// contract").
function extractHostedAppRepos(doc: string): string[] {
  const row = /\|\s*Hosted app\s*\|([^|]*)\|/u.exec(doc);
  if (!row) {
    throw new Error(
      'docs/renovate.md: could not find the "Hosted app" table row',
    );
  }
  return [...row[1].matchAll(/`([\w.-]+\/[\w.-]+)`/gu)].map((m) => m[1]);
}

describe('self-hosted Renovate contract', () => {
  it('never lists a repo the hosted app already covers', async () => {
    const doc = await readFile('docs/renovate.md', 'utf8');
    const hostedRepos = extractHostedAppRepos(doc);
    expect(hostedRepos.length).toBeGreaterThan(0);

    const selfHosted = await readJson<RenovateConfig>(
      '.github/renovate-self-hosted.json',
    );
    const selfHostedRepos = selfHosted.repositories ?? [];
    expect(selfHostedRepos.length).toBeGreaterThan(0);

    const overlap = selfHostedRepos.filter((repo) =>
      hostedRepos.includes(repo),
    );
    expect(overlap).toEqual([]);
  });

  it('requires config and never onboards a repo with none', async () => {
    const selfHosted = await readJson<Record<string, unknown>>(
      '.github/renovate-self-hosted.json',
    );
    expect(selfHosted.onboarding).toBe(false);
    expect(selfHosted.requireConfig).toBe('required');
    expect(selfHosted.platform).toBe('github');
  });

  it('gives every self-hosted PR the fleet bot git-author identity', async () => {
    const selfHosted = await readJson<Record<string, unknown>>(
      '.github/renovate-self-hosted.json',
    );
    expect(selfHosted.gitAuthor).toBe(
      'agent-lcars[bot] <agent-lcars[bot]@users.noreply.github.com>',
    );
  });

  it('opens major updates as draft PRs with automerge off, fleet-wide', async () => {
    // Lives in the shared preset, not the self-hosted global config: see
    // renovate-preset.json's own comment on this rule for why placement
    // here (rather than in renovate-self-hosted.json) is the only placement
    // a future repo-level packageRule cannot silently override.
    const preset = await readJson<RenovateConfig>('renovate-preset.json');

    expect(preset.packageRules).toContainEqual(
      expect.objectContaining({
        matchUpdateTypes: ['major'],
        draftPR: true,
        automerge: false,
      }),
    );
    // Draft is the guard. status:needs-human would route every major upgrade
    // in the fleet to the maintainer; a major is agent work.
    const majorRule = preset.packageRules?.find(
      (rule) => rule.draftPR === true,
    );
    expect(majorRule?.addLabels ?? []).not.toContain('status:needs-human');
  });

  it('pins every third-party action in the workflow by commit SHA', async () => {
    const workflow = await readFile(
      '.github/workflows/renovate-self-hosted.yml',
      'utf8',
    );
    const usesLines = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gmu)].map(
      (m) => m[1],
    );
    expect(usesLines.length).toBeGreaterThan(0);

    // First-party actions.checkout and this repo's own local composite
    // action are left as-is, matching every other workflow in this repo
    // (see docs/published-actions.md and AGENTS.md's action-pinning
    // convention); every other `uses:` must be commit-SHA pinned.
    const allowedUnpinned = new Set([
      'actions/checkout@v7',
      './.github/actions/mint-agent-token',
    ]);
    for (const uses of usesLines) {
      if (allowedUnpinned.has(uses)) continue;
      expect(uses, `${uses} must be pinned by commit SHA`).toMatch(
        /@[0-9a-f]{40}$/u,
      );
    }
  });

  it('pins renovatebot/github-action and the Renovate image version', async () => {
    const workflow = await readFile(
      '.github/workflows/renovate-self-hosted.yml',
      'utf8',
    );
    expect(workflow).toMatch(/renovatebot\/github-action@[0-9a-f]{40} # v\d/u);
    expect(workflow).toMatch(
      /renovate-version:\s*'\d+\.\d+\.\d+'\s*#\s*renovate:\s*datasource=docker\s+depName=ghcr\.io\/renovatebot\/renovate/u,
    );
  });

  it('computes the workflow matrix from renovate-self-hosted.json, not a hardcoded list', async () => {
    const workflow = await readFile(
      '.github/workflows/renovate-self-hosted.yml',
      'utf8',
    );
    expect(workflow).toContain('.github/renovate-self-hosted.json');
    expect(workflow).toContain('CONFIG=.github/renovate-self-hosted.json');
  });

  it('runs a matrix over both fleet owners with a per-owner concurrency guard', async () => {
    const workflow = parseYaml(
      await readFile('.github/workflows/renovate-self-hosted.yml', 'utf8'),
    ) as {
      jobs: Record<
        string,
        { concurrency?: { group?: string; 'cancel-in-progress'?: boolean } }
      >;
    };

    const renovateJob = workflow.jobs.renovate;
    expect(renovateJob.concurrency?.group).toContain('matrix.owner');
    expect(renovateJob.concurrency?.['cancel-in-progress']).toBe(false);
  });

  it("tracks the pinned renovate-version with a customManager in this repo's own renovate.json", async () => {
    const local = await readJson<{
      customManagers?: Array<Record<string, unknown>>;
    }>('renovate.json');

    expect(local.customManagers).toContainEqual(
      expect.objectContaining({
        customType: 'regex',
        managerFilePatterns: ['.github/workflows/renovate-self-hosted.yml'],
      }),
    );
  });
});
