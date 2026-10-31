import Link from 'next/link';

import type { CatalogJob, JobOccurrence } from '@/lib/repository-job-store';

import { StateMark } from '../ops-primitives';
import styles from './jobs.module.css';

export async function jobsApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/work/v1/jobs${path}`, {
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Job operation failed');
  return result as T;
}

export function jobTitle(name: string) {
  return name
    .replaceAll('-', ' ')
    .replace(/^./u, (letter) => letter.toUpperCase());
}

export function jobSchedule(job: CatalogJob): string {
  if (!job.definition) return 'Schedule unavailable';
  const schedule = job.definition.job.triggers.schedule;
  if (!schedule)
    return job.definition.job.triggers.manual ? 'Manual only' : 'No triggers';
  const match = /^(\d+) (\d+) \* \* ([0-6]|\*)$/u.exec(schedule.cron);
  if (!match) return `${schedule.cron} (${schedule.timezone})`;
  const days = [
    'Sundays',
    'Mondays',
    'Tuesdays',
    'Wednesdays',
    'Thursdays',
    'Fridays',
    'Saturdays',
  ];
  return `${match[3] === '*' ? 'Daily' : days[Number(match[3])]} at ${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')} ${schedule.timezone}`;
}

export function RunResult({ occurrence }: { occurrence: JobOccurrence }) {
  return (
    <div className={styles.section}>
      <StateMark
        tone={
          occurrence.skipped
            ? 'warn'
            : occurrence.successful === true
              ? 'ok'
              : occurrence.successful === false
                ? 'fail'
                : 'neutral'
        }
      >
        {occurrence.skipped
          ? 'Skipped: another run is active'
          : occurrence.successful === true
            ? 'Completed successfully'
            : occurrence.successful === false
              ? 'Unsuccessful'
              : 'Result pending'}
      </StateMark>
      <dl className={styles.facts}>
        <div>
          <dt>Requested</dt>
          <dd>
            <time dateTime={occurrence.createdAt}>
              {new Date(occurrence.createdAt).toLocaleString('en-US', {
                timeZone: 'UTC',
                timeZoneName: 'short',
              })}
            </time>
          </dd>
        </div>
        <div>
          <dt>Trigger</dt>
          <dd>{occurrence.trigger}</dd>
        </div>
      </dl>
      {!occurrence.skipped ? (
        <Link href={`/work/${encodeURIComponent(occurrence.workId)}`}>
          Open Work for status and cancellation
        </Link>
      ) : null}
      {occurrence.artifact ? (
        <details>
          <summary>Validated artifacts</summary>
          <pre>{JSON.stringify(occurrence.artifact.artifacts, null, 2)}</pre>
        </details>
      ) : (
        <p className={styles.muted}>No validated artifacts yet.</p>
      )}
    </div>
  );
}
