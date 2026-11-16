import { z } from 'zod';

import { readJobBody } from './repository-job-body';

/** One entry of a GitHub git tree. */
export interface RepositoryTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

/** A repository's default branch pinned at one commit, read through the
 * GitHub API. Repository-owned capabilities (`.lcars/jobs`, `.lcars/agents`)
 * are cataloged from this exact revision. */
export interface RepositorySource {
  /** The pinned commit SHA. */
  revision: string;
  /** The commit's root tree SHA. */
  rootTree: string;
  readTree(sha: string, recursive?: boolean): Promise<RepositoryTreeEntry[]>;
  /** The SHA of subdirectory `name` of tree `sha`, if it exists. */
  directory(sha: string | undefined, name: string): Promise<string | undefined>;
  /** `.lcars/<kind>` at the pinned revision, if the repository has one. */
  lcarsDirectory(kind: string): Promise<string | undefined>;
  readBlob(sha: string): Promise<Buffer>;
}

const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string(),
      size: z.number().optional(),
    }),
  ),
});

/** Pin `repository`'s default branch and return a reader for that commit.
 * Every request shares `signal`. API responses are read whole unless the
 * caller sets `maxResponseBytes` (the job catalog keeps its own bound). */
export async function openRepositorySource(
  repository: string,
  token: string,
  signal: AbortSignal,
  options: { maxResponseBytes?: number } = {},
): Promise<RepositorySource> {
  const get = async (path: string): Promise<unknown> => {
    // GitHub answers `/repos/{owner}/{repo}/` (trailing slash) with 404, so
    // the repository metadata request must omit the separator.
    const response = await fetch(
      `https://api.github.com/repos/${repository}${path ? `/${path}` : ''}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
        signal,
        cache: 'no-store',
      },
    );
    if (!response.ok) throw new Error(`Catalog source HTTP ${response.status}`);
    const text =
      options.maxResponseBytes === undefined
        ? await response.text()
        : await readJobBody(response, options.maxResponseBytes);
    return JSON.parse(text);
  };
  const metadata = z
    .object({ default_branch: z.string() })
    .parse(await get(''));
  const commit = z
    .object({
      sha: z.string().regex(/^[a-f0-9]{40}$/u),
      commit: z.object({ tree: z.object({ sha: z.string() }) }),
    })
    .parse(await get(`commits/${encodeURIComponent(metadata.default_branch)}`));
  const readTree = async (sha: string, recursive = false) => {
    const tree = treeSchema.parse(
      await get(`git/trees/${sha}${recursive ? '?recursive=1' : ''}`),
    );
    if (tree.truncated) throw new Error('Catalog tree truncated');
    return tree.tree;
  };
  // Walk one level at a time instead of reading the whole repository tree: a
  // repository without `.lcars` costs one small root read.
  const directory = async (sha: string | undefined, name: string) =>
    sha === undefined
      ? undefined
      : (await readTree(sha)).find(
          (entry) => entry.path === name && entry.type === 'tree',
        )?.sha;
  return {
    revision: commit.sha,
    rootTree: commit.commit.tree.sha,
    readTree,
    directory,
    lcarsDirectory: async (kind) =>
      directory(await directory(commit.commit.tree.sha, '.lcars'), kind),
    // Raw media type: the bytes themselves, with no JSON envelope or
    // response cap, so a file is read whole.
    readBlob: async (sha) => {
      const response = await fetch(
        `https://api.github.com/repos/${repository}/git/blobs/${sha}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.raw',
          },
          signal,
          cache: 'no-store',
        },
      );
      if (!response.ok)
        throw new Error(`Catalog source HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
