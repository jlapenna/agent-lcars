'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { CatalogJob, JobOccurrence } from '@/lib/repository-job-store';

async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(
    `/api/work/v1/jobs${path}`,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Job operation failed');
  return result;
}
export function JobsPanel({ repositories }: { repositories: string[] }) {
  const [jobs, setJobs] = useState<CatalogJob[]>([]);
  const [repository, setRepository] = useState(repositories[0] ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [parameters, setParameters] = useState<
    Record<string, Record<string, string>>
  >({});
  const [occurrence, setOccurrence] = useState<JobOccurrence>();
  const load = async () => setJobs((await api('')) as CatalogJob[]);
  useEffect(() => {
    let active = true;
    void api('')
      .then((value) => {
        if (active) setJobs(value as CatalogJob[]);
      })
      .catch((reason: Error) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function act(operation: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await operation();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Operation failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-busy={busy}>
      <p>Recipes stay disabled until you enable the reviewed definition.</p>
      <label>
        Repository{' '}
        <select
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
        >
          {repositories.map((repo) => (
            <option key={repo}>{repo}</option>
          ))}
        </select>
      </label>
      <button
        disabled={busy || !repository}
        onClick={() => void act(() => api('/refresh', { repository }))}
      >
        Refresh definitions
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {jobs.length === 0 ? <p>No job definitions discovered.</p> : null}
      {jobs.map((job) => (
        <article key={job.id} className="console-workspace__section">
          <h2>
            {job.repository} / {job.name}
          </h2>
          <p>{job.error ?? job.definition?.job.description}</p>
          <p>
            {job.enabled ? 'Enabled' : 'Disabled'} ·{' '}
            {job.definition?.job.triggers.schedule
              ? `${job.definition.job.triggers.schedule.cron} (${job.definition.job.triggers.schedule.timezone})`
              : 'Manual only'}
          </p>
          {job.definition ? (
            <details>
              <summary>Review definition</summary>
              <p>Commit {job.definition.revision}</p>
              <pre>{JSON.stringify(job.definition.job, null, 2)}</pre>
              <pre>{job.definition.recipeText}</pre>
            </details>
          ) : null}
          <button
            disabled={
              busy || (!job.enabled && (!job.definition || Boolean(job.error)))
            }
            onClick={() =>
              void act(() =>
                api(`/${job.id}/enable`, {
                  digest: job.definition?.digest ?? '',
                  enabled: !job.enabled,
                }),
              )
            }
          >
            {job.enabled ? 'Disable' : 'Enable reviewed definition'}
          </button>
          {job.definition?.parameters.map((parameter) => (
            <label key={parameter.key}>
              {parameter.description}
              <input
                aria-label={parameter.key}
                maxLength={2048}
                required={
                  parameter.requirement === 'required' &&
                  parameter.default === undefined
                }
                value={
                  parameters[job.id]?.[parameter.key] ?? parameter.default ?? ''
                }
                onChange={(event) =>
                  setParameters((current) => ({
                    ...current,
                    [job.id]: {
                      ...current[job.id],
                      [parameter.key]: event.target.value,
                    },
                  }))
                }
              />
            </label>
          ))}
          <button
            disabled={
              busy || !job.enabled || !job.definition?.job.triggers.manual
            }
            onClick={() =>
              void act(async () => {
                setOccurrence(
                  (await api(`/${job.id}/invoke`, {
                    digest: job.definition?.digest,
                    requestId: crypto.randomUUID(),
                    parameters: parameters[job.id] ?? {},
                  })) as JobOccurrence,
                );
              })
            }
          >
            Run now
          </button>
          {job.latest ? (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setOccurrence(
                    (await api(`/occurrences/${job.latest}`)) as JobOccurrence,
                  );
                })
              }
            >
              Latest occurrence
            </button>
          ) : null}
        </article>
      ))}
      {occurrence ? (
        <section>
          <h2>Occurrence</h2>
          <p>
            {occurrence.skipped ? (
              'Skipped: another occurrence is active'
            ) : (
              <Link href={`/work/${occurrence.workId}`}>
                Open Work for status and cancellation
              </Link>
            )}
          </p>
          {occurrence.artifact ? (
            <pre>{JSON.stringify(occurrence.artifact.artifacts, null, 2)}</pre>
          ) : (
            <p>No validated artifacts yet.</p>
          )}
        </section>
      ) : null}
    </section>
  );
}
