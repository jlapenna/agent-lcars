'use client';

import { Button, Checkbox, TextInput } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';

import type { CatalogJob, JobOccurrence } from '@/lib/repository-job-store';

import { StateMark } from '../ops-primitives';
import { jobsApi, jobSchedule, jobTitle, RunResult } from './job-presentation';
import styles from './jobs.module.css';

export function JobDetail({
  job,
  busy,
  focus,
  back,
  parameters,
  setParameters,
  occurrence,
  onOccurrence,
  act,
  openSource,
}: {
  job: CatalogJob;
  busy: boolean;
  focus: boolean;
  back: () => void;
  parameters: Record<string, string>;
  setParameters: (value: Record<string, string>) => void;
  occurrence?: JobOccurrence;
  onOccurrence: (value: JobOccurrence) => void;
  act: (operation?: () => Promise<unknown>, success?: string) => Promise<void>;
  openSource: () => void;
}) {
  const [tab, setTab] = useState('overview');
  const [reviewed, setReviewed] = useState(false);
  const [run, setRun] = useState(false);
  const [latest, setLatest] = useState<JobOccurrence>();
  const [readError, setReadError] = useState('');
  const [reading, setReading] = useState(false);
  const [reload, setReload] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const definition = job.definition;
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  useEffect(() => {
    if (tab === 'definition' && !run) reviewHeading.current?.focus();
  }, [tab, run]);
  useEffect(() => {
    let active = true;
    if (tab !== 'latest' || !job.latest) return;
    setReading(true);
    setReadError('');
    void jobsApi<JobOccurrence>(`/occurrences/${job.latest}`)
      .then((value) => {
        if (active) setLatest(value);
      })
      .catch((reason: Error) => {
        if (active) setReadError(reason.message);
      })
      .finally(() => {
        if (active) setReading(false);
      });
    return () => {
      active = false;
    };
  }, [tab, job.latest, reload]);
  const result =
    latest && (!occurrence || latest.createdAt >= occurrence.createdAt)
      ? latest
      : occurrence;
  return (
    <section className={styles.detail} aria-labelledby="job-detail-title">
      <Button className={styles.back} variant="light" onClick={back}>
        All jobs
      </Button>
      <header className={styles.detailHead}>
        <span className={styles.repo}>{job.repository}</span>
        <h2 id="job-detail-title" ref={heading} tabIndex={-1}>
          {jobTitle(job.name)}
        </h2>
        <div className={styles.actions}>
          <StateMark tone={job.enabled ? 'ok' : 'idle'}>
            {job.enabled ? 'Enabled' : 'Disabled'}
          </StateMark>
          {job.enabled ? (
            <Button
              variant="light"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    jobsApi(`/${job.id}/enable`, {
                      digest: definition?.digest ?? '',
                      enabled: false,
                    }),
                  'Job disabled. Existing Work continues.',
                )
              }
            >
              Disable
            </Button>
          ) : null}
          {definition?.job.triggers.manual && !run ? (
            <Button
              disabled={busy || !job.enabled || Boolean(job.error)}
              onClick={() => setRun(true)}
            >
              Run now
            </Button>
          ) : null}
        </div>
        {!job.enabled ? (
          <p className={styles.muted}>
            Review and enable this job before it can run.
          </p>
        ) : null}
      </header>
      {job.error ? (
        <div className={styles.notice}>
          <StateMark tone="warn">Source needs attention</StateMark>
          <p>{job.error}</p>
          <Button variant="light" onClick={openSource}>
            Review repository source
          </Button>
        </div>
      ) : null}
      <nav className={styles.tabs} aria-label="Selected job sections">
        {[
          ['overview', 'Overview'],
          ['definition', 'Definition & recipe'],
          ['latest', 'Latest run'],
        ].map(([key, title]) => (
          <button
            key={key}
            aria-pressed={tab === key && !run}
            onClick={() => {
              setTab(key);
              setRun(false);
            }}
          >
            {title}
          </button>
        ))}
      </nav>
      {run && definition ? (
        <form
          className={styles.section}
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const admitted = await jobsApi<JobOccurrence>(
                `/${job.id}/invoke`,
                {
                  digest: definition.digest,
                  requestId: crypto.randomUUID(),
                  parameters,
                },
              );
              onOccurrence(admitted);
              setRun(false);
              setTab('latest');
            });
          }}
        >
          <h3>Run once</h3>
          <p className={styles.muted}>
            Start this installed recipe with the parameters below. The schedule
            stays unchanged.
          </p>
          {definition.parameters.map((parameter) => (
            <TextInput
              key={parameter.key}
              label={parameter.key}
              description={parameter.description}
              maxLength={2048}
              required={
                parameter.requirement === 'required' &&
                parameter.default === undefined
              }
              value={parameters[parameter.key] ?? parameter.default ?? ''}
              disabled={busy}
              onChange={(event) =>
                setParameters({
                  ...parameters,
                  [parameter.key]: event.currentTarget.value,
                })
              }
            />
          ))}
          {!definition.parameters.length ? (
            <p>No parameters required.</p>
          ) : null}
          <div className={styles.actions}>
            <Button
              type="submit"
              loading={busy}
              disabled={!job.enabled || Boolean(job.error)}
            >
              Start run
            </Button>
            <Button
              variant="light"
              disabled={busy}
              onClick={() => setRun(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : tab === 'overview' ? (
        <div className={styles.section}>
          <p>
            {definition?.job.description ??
              'Refresh the repository source to load this job’s definition.'}
          </p>
          <dl className={styles.facts}>
            <div>
              <dt>Schedule</dt>
              <dd>{jobSchedule(job)}</dd>
            </div>
            <div>
              <dt>Manual run</dt>
              <dd>
                {definition
                  ? definition.job.triggers.manual
                    ? 'Available when enabled'
                    : 'Not configured'
                  : 'Unavailable'}
              </dd>
            </div>
            <div>
              <dt>Activity</dt>
              <dd>
                {job.active
                  ? 'Run active'
                  : job.latest
                    ? 'Latest run available'
                    : 'No runs recorded'}
              </dd>
            </div>
            {definition ? (
              <>
                <div>
                  <dt>Run timeout</dt>
                  <dd>
                    {definition.job.execution.timeout.replace('m', ' minutes')}
                  </dd>
                </div>
                <div>
                  <dt>Overlapping runs</dt>
                  <dd>Skip while another run is active</dd>
                </div>
              </>
            ) : null}
          </dl>
          {!job.enabled && definition ? (
            <Button onClick={() => setTab('definition')}>
              Review to enable
            </Button>
          ) : null}
        </div>
      ) : tab === 'definition' ? (
        <div className={styles.section}>
          <h3 ref={reviewHeading} tabIndex={-1}>
            Review definition and recipe
          </h3>
          {job.error ? (
            <p>Refresh the repository source before enabling this job.</p>
          ) : !job.enabled ? (
            <p className={styles.muted}>
              Read the definition and recipe below, then confirm your review to
              enable this job.
            </p>
          ) : null}
          {definition ? (
            <>
              <dl className={styles.facts}>
                <div>
                  <dt>Job key</dt>
                  <dd>{job.name}</dd>
                </div>
                <div>
                  <dt>Commit</dt>
                  <dd>
                    <a
                      href={`https://github.com/${job.repository}/commit/${definition.revision}`}
                    >
                      {definition.revision.slice(0, 12)}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>Definition digest</dt>
                  <dd className={styles.digest}>{definition.digest}</dd>
                </div>
              </dl>
              <details open>
                <summary>Job definition</summary>
                <pre>{JSON.stringify(definition.job, null, 2)}</pre>
              </details>
              <details open>
                <summary>Recipe</summary>
                <pre>{definition.recipeText}</pre>
              </details>
              {!job.enabled ? (
                <>
                  <Checkbox
                    label="I reviewed this definition and recipe"
                    checked={reviewed}
                    onChange={(event) =>
                      setReviewed(event.currentTarget.checked)
                    }
                    disabled={busy || Boolean(job.error)}
                  />
                  <p className={styles.muted}>
                    Enabling permits{' '}
                    {definition.job.triggers.schedule ? 'scheduled' : 'manual'}{' '}
                    runs. It does not start a run now.
                  </p>
                  <Button
                    disabled={busy || !reviewed || Boolean(job.error)}
                    onClick={() =>
                      void act(
                        () =>
                          jobsApi(`/${job.id}/enable`, {
                            digest: definition.digest,
                            enabled: true,
                          }),
                        'Reviewed definition enabled.',
                      )
                    }
                  >
                    Enable reviewed definition
                  </Button>
                </>
              ) : null}
            </>
          ) : (
            <p>
              No valid definition is available. Refresh the repository source.
            </p>
          )}
        </div>
      ) : (
        <div className={styles.section}>
          {readError ? <p role="alert">{readError}</p> : null}
          {reading ? (
            <p role="status">Loading latest run…</p>
          ) : result ? (
            <RunResult occurrence={result} />
          ) : (
            <p className={styles.muted}>
              {job.latest
                ? 'Latest run could not be loaded.'
                : 'No runs recorded for this job.'}
            </p>
          )}
          {job.latest ? (
            <Button
              variant="light"
              disabled={reading}
              onClick={() => setReload((value) => value + 1)}
            >
              Refresh run
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
