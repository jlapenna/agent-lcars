'use client';

import { Button, TextInput } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

import type { CatalogJob, JobOccurrence } from '@/lib/repository-job-store';

import { ConsoleWorkspace } from '../console-workspace';
import { StateMark } from '../ops-primitives';
import { JobDetail } from './job-detail';
import { jobsApi, jobSchedule, jobTitle } from './job-presentation';
import styles from './jobs.module.css';

export function JobsPanel({ repositories }: { repositories: string[] }) {
  const [jobs, setJobs] = useState<CatalogJob[]>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [sources, setSources] = useState(false);
  const [repository, setRepository] = useState(repositories[0] ?? '');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const readVersion = useRef(0);
  const listTitle = useRef<HTMLHeadingElement>(null);
  const [parameters, setParameters] = useState<
    Record<string, Record<string, string>>
  >({});
  const [occurrences, setOccurrences] = useState<Record<string, JobOccurrence>>(
    {},
  );

  useEffect(() => {
    let active = true;
    const version = ++readVersion.current;
    void jobsApi<CatalogJob[]>('')
      .then((value) => {
        if (active && version === readVersion.current) setJobs(value);
      })
      .catch((reason: Error) => {
        if (active && version === readVersion.current) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, []);

  async function act(operation?: () => Promise<unknown>, success = '') {
    if (lock.current) return;
    lock.current = true;
    readVersion.current += 1;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation?.();
      setNotice(success);
      setJobs(await jobsApi<CatalogJob[]>(''));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Operation failed');
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  const catalog = jobs ?? [];
  const matches = catalog.filter(
    (job) =>
      `${job.name} ${jobTitle(job.name)} ${job.repository}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'enabled' && job.enabled) ||
        (filter === 'disabled' && !job.enabled) ||
        (filter === 'issues' && Boolean(job.error))),
  );
  const job = matches.find((entry) => entry.id === selected) ?? matches[0];
  const issues = catalog.filter((entry) => entry.error).length;
  function back() {
    setDetailOpen(false);
    requestAnimationFrame(() => listTitle.current?.focus());
  }
  return (
    <ConsoleWorkspace
      ariaLabel="Repository jobs"
      className="jobs-workspace"
      warnings={false}
      toolbar={
        <div className={styles.toolbar}>
          <div className="console-toolbar__filters">
            <TextInput
              type="search"
              aria-label="Search jobs"
              placeholder="Find a job or repository"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setDetailOpen(false);
              }}
              className={styles.search}
            />
            <label className="console-toolbar__field console-toolbar__toggle">
              <input className="console-toolbar__fold" type="checkbox" />
              Filters
            </label>
            <select
              className={`console-toolbar__field console-toolbar__select ${styles.filter}`}
              aria-label="Job state"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setDetailOpen(false);
              }}
            >
              <option value="all">All jobs</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
              <option value="issues">Source issues</option>
            </select>
          </div>
          <Button variant="light" disabled={busy} onClick={() => void act()}>
            Refresh list
          </Button>
          <Button
            onClick={() => setSources(!sources)}
            aria-expanded={sources}
            aria-controls="job-sources"
          >
            {sources ? 'Close sources' : 'Repository sources'}
          </Button>
        </div>
      }
    >
      <div
        className={styles.body}
        aria-busy={busy || (jobs === undefined && !error)}
      >
        {error ? (
          <div className={styles.notice} role="alert">
            <strong>Jobs could not be updated</strong>
            <p>{error}</p>
            <Button variant="light" disabled={busy} onClick={() => void act()}>
              Retry list
            </Button>
          </div>
        ) : null}
        {notice ? (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        ) : null}
        {sources ? (
          <section
            className={styles.sources}
            id="job-sources"
            aria-label="Repository sources"
          >
            <h2>Repository sources</h2>
            <p className={styles.muted}>
              Install or refresh job definitions from a repository. Changed
              definitions must be reviewed before enabling.
            </p>
            <form
              className={styles.sourceForm}
              onSubmit={(event) => {
                event.preventDefault();
                void act(
                  () => jobsApi('/refresh', { repository }),
                  `Definitions refreshed from ${repository}.`,
                );
              }}
            >
              <label>
                Repository
                <select
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                  disabled={busy}
                >
                  {repositories.map((repo) => (
                    <option key={repo}>{repo}</option>
                  ))}
                </select>
              </label>
              <Button type="submit" loading={busy} disabled={!repository}>
                Install / refresh jobs
              </Button>
            </form>
            {!repositories.length ? (
              <p>No repositories are available for installation.</p>
            ) : null}
          </section>
        ) : null}
        {jobs === undefined ? (
          !error ? (
            <div className={styles.empty} role="status">
              <h2>Loading registered jobs</h2>
              <p>Reading the registry, including disabled jobs.</p>
            </div>
          ) : null
        ) : (
          <>
            <div className={styles.summary}>
              <strong>{catalog.length} registered</strong>
              <span>
                {catalog.filter((entry) => entry.enabled).length} enabled
              </span>
              <span>
                {catalog.filter((entry) => !entry.enabled).length} disabled
              </span>
              {issues ? (
                <StateMark tone="warn">
                  {issues} source {issues === 1 ? 'issue' : 'issues'}
                </StateMark>
              ) : null}
            </div>
            {!catalog.length ? (
              <div className={styles.empty}>
                <h2>No jobs registered</h2>
                <p>
                  Install repository definitions, then review and enable each
                  job.
                </p>
                <Button onClick={() => setSources(true)}>
                  Install repository jobs
                </Button>
              </div>
            ) : (
              <div
                className={styles.grid}
                data-detail={detailOpen && Boolean(job)}
              >
                <section
                  className={styles.registry}
                  aria-labelledby="job-list-title"
                >
                  <div className={styles.listHeading}>
                    <h2 id="job-list-title" ref={listTitle} tabIndex={-1}>
                      Registered jobs
                    </h2>
                    <span className={styles.muted}>
                      {matches.length} of {catalog.length}
                    </span>
                  </div>
                  <ul className={styles.list}>
                    {matches.map((entry) => (
                      <li key={entry.id}>
                        <button
                          className={styles.row}
                          aria-current={
                            job?.id === entry.id ? 'true' : undefined
                          }
                          onClick={() => {
                            setSelected(entry.id);
                            setDetailOpen(true);
                          }}
                        >
                          <span className={styles.identity}>
                            <strong>{jobTitle(entry.name)}</strong>
                            <span className={styles.repo}>
                              {entry.repository}
                            </span>
                          </span>
                          <StateMark tone={entry.enabled ? 'ok' : 'idle'}>
                            {entry.enabled ? 'Enabled' : 'Disabled'}
                          </StateMark>
                          <span className={styles.rowMeta}>
                            {entry.error ? (
                              <StateMark tone="warn">Source issue</StateMark>
                            ) : (
                              <span>{jobSchedule(entry)}</span>
                            )}
                            <span>
                              {entry.active
                                ? 'Run active'
                                : entry.latest
                                  ? 'Latest run available'
                                  : 'No runs recorded'}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!matches.length ? (
                    <div className={styles.empty}>
                      <h3>No matching jobs</h3>
                      <p>Try a different name, repository or state.</p>
                      <Button
                        variant="light"
                        onClick={() => {
                          setQuery('');
                          setFilter('all');
                        }}
                      >
                        Clear filters
                      </Button>
                    </div>
                  ) : null}
                </section>
                {job ? (
                  <JobDetail
                    key={`${job.id}:${job.definition?.digest}`}
                    job={job}
                    busy={busy}
                    focus={detailOpen}
                    back={back}
                    parameters={
                      parameters[`${job.id}:${job.definition?.digest}`] ?? {}
                    }
                    setParameters={(value) =>
                      setParameters((current) => ({
                        ...current,
                        [`${job.id}:${job.definition?.digest}`]: value,
                      }))
                    }
                    occurrence={occurrences[job.id]}
                    onOccurrence={(value) =>
                      setOccurrences((current) => ({
                        ...current,
                        [job.id]: value,
                      }))
                    }
                    act={act}
                    openSource={() => {
                      setRepository(job.repository);
                      setSources(true);
                      back();
                    }}
                  />
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
    </ConsoleWorkspace>
  );
}
