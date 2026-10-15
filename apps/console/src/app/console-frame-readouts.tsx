'use client';

import { useEffect, useState } from 'react';

import {
  compactNumber,
  stardate,
  useLiveState,
  useMinuteClock,
  useShellReadouts,
} from './console-shell-state';
import { formatCompactRelativeTime } from './format';

const UNAVAILABLE = '—';

/**
 * The rail's readout blocks (design/fleet-console.html): fleet online, queue
 * depth, tokens and merges over the last day, and the date. The same figures
 * on every route. Maintainer data only; other sessions see the frame alone.
 */
export function RailReadouts() {
  const state = useShellReadouts();
  const now = useMinuteClock();
  const readouts = state.status === 'ready' ? state.readouts : undefined;
  // Loading, or a session without maintainer data: frame only. A failed
  // read, or a missing figure for a maintainer: an explicit unavailable mark.
  const shown =
    state.status === 'unavailable' ||
    (readouts?.user.grants.includes('admin') ?? false);
  const value = (figure: string | undefined) =>
    shown ? (figure ?? UNAVAILABLE) : undefined;

  const fleet = readouts?.fleet;
  const blocks = [
    {
      key: 'fleet',
      modifier: 'short',
      label: 'Fleet online',
      value: value(
        fleet?.online === undefined
          ? undefined
          : fleet.capacity === undefined
            ? String(fleet.online)
            : `${fleet.online}/${fleet.capacity}`,
      ),
    },
    {
      key: 'queue',
      modifier: 'medium',
      label: 'Queue depth',
      value: value(
        readouts?.queueDepth === undefined
          ? undefined
          : String(readouts.queueDepth).padStart(2, '0'),
      ),
    },
    {
      key: 'tokens',
      modifier: 'tall',
      label: 'Tokens · 24h sessions',
      value: value(
        readouts?.tokens24h === undefined
          ? undefined
          : `${compactNumber(readouts.tokens24h)}${readouts.tokens24hPartial ? '+' : ''}`,
      ),
    },
    {
      key: 'merged',
      modifier: 'fill',
      label: 'Merged · 24h',
      value: value(
        readouts?.merged24h === undefined
          ? undefined
          : `${readouts.merged24h}${readouts.merged24hPartial ? '+' : ''}`,
      ),
    },
  ];

  return (
    <div className="lcars-rail-body" aria-label="Fleet readouts" role="group">
      {blocks.map((block) => (
        <div
          key={block.key}
          className={`lcars-rail-block lcars-rail-block--${block.modifier}`}
          data-testid={`rail-readout-${block.key}`}
        >
          {block.value !== undefined ? (
            <>
              <b>{block.value}</b>
              <span>{block.label}</span>
            </>
          ) : null}
        </div>
      ))}
      <div className="lcars-rail-block lcars-rail-block--end">
        {now ? <b>{stardate(now)}</b> : null}
      </div>
    </div>
  );
}

/** The rail head's environment line: the host this console serves. */
export function RailEnvironment() {
  const state = useShellReadouts();
  const environment =
    state.status === 'ready' ? state.readouts.environment : undefined;
  return environment ? (
    <span className="lcars-rail-code">{environment}</span>
  ) : null;
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour12: false });
}

/** "■ LIVE · synced 14:32:08" for routes with a live stream; otherwise the
 * time the page was loaded, labelled as a snapshot. */
export function ConsoleLiveStatus({
  dataAt,
  compact = false,
}: {
  dataAt?: string;
  /** One line under the title where the header's sync block does not fit
   * (below 80em): the same status, without the refresh hint. */
  compact?: boolean;
} = {}) {
  const live = useLiveState();
  // The page's own load time, captured once: a snapshot does not advance.
  const [loadedAt, setLoadedAt] = useState<number>();
  useEffect(() => setLoadedAt(Date.now()), []);
  // A snapshot served from cached sources says how old its data is, not when
  // the page loaded. Formatted after mount: relative time differs between the
  // server render and hydration.
  // The minute clock re-reads the age, as the rail's figures do.
  const now = useMinuteClock();
  const [dataAge, setDataAge] = useState<string>();
  useEffect(() => {
    if (dataAt && now) setDataAge(formatCompactRelativeTime(dataAt));
  }, [dataAt, now]);
  const mode = live?.mode;
  const tone =
    mode === 'live' || mode === 'updating'
      ? 'ok'
      : mode === undefined
        ? 'idle'
        : 'warn';
  const headline =
    mode === undefined
      ? 'Snapshot'
      : mode === 'live'
        ? 'Live'
        : mode === 'updating'
          ? 'Updating'
          : mode === 'connecting'
            ? 'Connecting'
            : 'Degraded';
  // A live route shows a sync time only after a sync actually happened.
  const at = mode === undefined ? loadedAt : live?.syncedAt;
  return (
    <div
      className={
        compact
          ? 'console-live-status console-live-status--compact'
          : 'console-live-status'
      }
      data-tone={tone}
      data-testid={
        compact ? 'console-live-status-compact' : 'console-live-status'
      }
      title={live?.label}
    >
      <b>■ {headline}</b>
      {mode === undefined && dataAge !== undefined ? (
        <span>
          {' · '}data {dataAge}
        </span>
      ) : at !== undefined ? (
        <span>
          {' · '}
          {mode === undefined ? 'loaded' : 'synced'} {clockTime(at)}
        </span>
      ) : null}
      {compact ? null : (
        <>
          <br />
          <span>
            {mode === undefined ? 'refresh to update' : 'auto-refresh 5 s'}
          </span>
        </>
      )}
    </div>
  );
}

/** Avatar initials, login and grants for the signed-in session. */
export function ConsoleIdentity() {
  const state = useShellReadouts();
  if (state.status !== 'ready') return null;
  const { user } = state.readouts;
  return (
    <div className="console-identity" data-testid="console-identity">
      <span className="console-identity__avatar" aria-hidden="true">
        {user.initials}
      </span>
      <span className="console-identity__text">
        <span className="console-identity__login">{user.login}</span>
        {user.grants.length > 0 ? (
          <span className="console-identity__grants">
            {user.grants.join(' · ')}
          </span>
        ) : null}
      </span>
    </div>
  );
}
