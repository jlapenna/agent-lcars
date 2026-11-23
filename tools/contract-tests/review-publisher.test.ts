import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// The shared review publisher writes one verdict to two commits: the pull
// request's test merge commit and its head. A ruleset can only find a
// required check on the head (#3473), so these contracts hold the head check
// to the same verdict, name and writer as the merge-candidate check.

const PUBLISH = path.resolve('.github/actions/publish-lcars-review/publish.sh');
const FAKE_GH = path.resolve(
  'tools/contract-tests/fixtures/fake-gh-review-publisher.cjs',
);
const REPO = 'acme/widgets';
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const OTHER_CANDIDATE = 'd'.repeat(40);
const HEAD_CHECK = 'LCARS review';
const CANDIDATE_CHECK = 'LCARS review (merge candidate)';
const APP = 4457090;

interface Review {
  user: { login: string };
  state: string;
  commit_id: string;
  body: string;
  submitted_at: string;
  html_url: string;
}
interface CheckRun {
  id: number;
  name: string;
  external_id: string;
  conclusion: string;
}
interface Write {
  method: string;
  token: string;
  sha: string;
  name: string;
  conclusion: string;
}
interface State {
  checks: Record<string, CheckRun[]>;
  writes: Write[];
}

const review = (state: string, run = 1, pr = 7): Review => ({
  user: { login: 'agent-lcars[bot]' },
  state,
  commit_id: HEAD,
  body: `Reviewed.\n<!-- attempt-claim:g1:${REPO}#${pr}/r${run} -->`,
  submitted_at: `2026-11-23T0${run}:00:00Z`,
  html_url: `https://github.com/${REPO}/pull/${pr}#pullrequestreview-${run}`,
});
const requires = (context: string) => [
  {
    type: 'required_status_checks',
    parameters: {
      required_status_checks: [{ context, integration_id: APP }],
    },
  },
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

// `second` adds another open pull request at the same head. GitHub gives it
// its own test merge commit.
function publisher(options: {
  reviews?: Review[];
  rules?: unknown[];
  candidate?: boolean;
  second?: Review[];
}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'review-publisher-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  symlinkSync(FAKE_GH, path.join(bin, 'gh'));
  const statePath = path.join(root, 'state.json');
  const read = (): State => JSON.parse(readFileSync(statePath, 'utf8'));
  const pulls = [
    {
      number: 7,
      head: HEAD,
      baseOid: BASE,
      candidate:
        options.candidate === false
          ? null
          : { oid: CANDIDATE, parents: [BASE, HEAD] },
      reviews: options.reviews ?? [],
    },
  ];
  if (options.second)
    pulls.push({
      number: 8,
      head: HEAD,
      baseOid: BASE,
      candidate: { oid: OTHER_CANDIDATE, parents: [BASE, HEAD] },
      reviews: options.second,
    });
  writeFileSync(
    statePath,
    JSON.stringify({
      repo: REPO,
      rules: options.rules ?? [],
      pulls,
      checks: {},
      writes: [],
      nextId: 1,
    }),
  );
  return {
    read,
    setReviews(reviews: Review[]) {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state.pulls[0].reviews = reviews;
      state.writes = [];
      writeFileSync(statePath, JSON.stringify(state));
    },
    run() {
      const result = spawnSync('bash', [PUBLISH], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env['PATH']}`,
          FAKE_GH_STATE: statePath,
          GH_TOKEN: 'workflow-token',
          PUBLISHER_TOKEN: 'app-token',
          REPO,
          BASE: 'main',
        },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      return read();
    },
  };
}
const conclusions = (state: State) =>
  Object.fromEntries(
    Object.entries(state.checks).flatMap(([sha, runs]) =>
      runs.map((run) => [`${sha[0]}:${run.name}`, run.conclusion]),
    ),
  );

describe('shared LCARS review publisher', () => {
  it('publishes an approval on the test merge commit and on the head', () => {
    const state = publisher({ reviews: [review('APPROVED')] }).run();

    expect(conclusions(state)).toEqual({
      [`c:${CANDIDATE_CHECK}`]: 'success',
      [`a:${HEAD_CHECK}`]: 'success',
    });
    expect(state.checks[HEAD]?.[0]?.external_id).toBe('lcars-review');
    expect(state.checks[CANDIDATE]?.[0]?.external_id).toBe(
      'lcars-review-merge-candidate',
    );
    // Only the App's token may write: the ruleset pins the check to the App.
    expect(state.writes.map((write) => write.token)).toEqual([
      'app-token',
      'app-token',
    ]);
  });

  it('publishes nothing for an unreviewed pull request while no ruleset requires a check', () => {
    expect(publisher({}).run().writes).toEqual([]);
  });

  it('fails the head check of an unreviewed pull request once a ruleset requires it', () => {
    const state = publisher({ rules: requires(HEAD_CHECK) }).run();

    expect(conclusions(state)).toEqual({ [`a:${HEAD_CHECK}`]: 'failure' });
  });

  it('keeps the two requirements independent', () => {
    const state = publisher({ rules: requires(CANDIDATE_CHECK) }).run();

    expect(conclusions(state)).toEqual({ [`c:${CANDIDATE_CHECK}`]: 'failure' });
  });

  it('revokes the head check when a later review requests changes', () => {
    const subject = publisher({ reviews: [review('APPROVED')] });
    subject.run();
    subject.setReviews([review('APPROVED'), review('CHANGES_REQUESTED', 2)]);

    const state = subject.run();

    expect(conclusions(state)).toEqual({
      [`c:${CANDIDATE_CHECK}`]: 'failure',
      [`a:${HEAD_CHECK}`]: 'failure',
    });
    expect(state.writes.map((write) => write.method)).toEqual([
      'PATCH',
      'PATCH',
    ]);
    expect(state.checks[HEAD]).toHaveLength(1);
  });

  it('writes nothing more when the published checks already match', () => {
    const subject = publisher({ reviews: [review('APPROVED')] });
    subject.run();
    subject.setReviews([review('APPROVED')]);

    expect(subject.run().writes).toEqual([]);
  });

  it('publishes the head verdict while GitHub has no test merge commit', () => {
    const state = publisher({
      reviews: [review('APPROVED')],
      candidate: false,
    }).run();

    expect(conclusions(state)).toEqual({ [`a:${HEAD_CHECK}`]: 'success' });
  });

  it('revokes the head check of a pull request GitHub cannot merge', () => {
    const subject = publisher({
      reviews: [review('APPROVED')],
      candidate: false,
    });
    subject.run();
    subject.setReviews([review('APPROVED'), review('CHANGES_REQUESTED', 2)]);

    expect(conclusions(subject.run())).toEqual({
      [`a:${HEAD_CHECK}`]: 'failure',
    });
  });

  it('passes a shared head only when every pull request at it has passed', () => {
    const state = publisher({
      reviews: [review('APPROVED')],
      second: [],
      rules: requires(HEAD_CHECK),
    }).run();

    // Each pull request keeps its own merge-candidate verdict. The head is
    // one commit for both, so the unreviewed one holds it at failure.
    expect(conclusions(state)).toEqual({
      [`c:${CANDIDATE_CHECK}`]: 'success',
      [`a:${HEAD_CHECK}`]: 'failure',
    });
    expect(state.checks[HEAD]).toHaveLength(1);
  });

  it('passes a shared head once each pull request has its own approval', () => {
    const state = publisher({
      reviews: [review('APPROVED')],
      second: [review('APPROVED', 1, 8)],
    }).run();

    expect(conclusions(state)).toEqual({
      [`c:${CANDIDATE_CHECK}`]: 'success',
      [`d:${CANDIDATE_CHECK}`]: 'success',
      [`a:${HEAD_CHECK}`]: 'success',
    });
  });
});
