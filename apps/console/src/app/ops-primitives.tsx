import type { ReactNode } from 'react';

/** Building blocks of the operations panels (design/fleet-console.html).
 * Dependency-free so client islands such as Shuttlebay can use them. */

export const UNAVAILABLE = '—';

/** Compact token count: 980, 12.2k, 1.42M. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** Panel chrome: spine, uppercase head with count and trailing meta. */
export function OpsPanel({
  title,
  count,
  meta,
  signalled = false,
  className,
  children,
  ...rest
}: {
  title: string;
  count?: ReactNode;
  meta?: ReactNode;
  /** The decision inbox carries the signal bar down its trailing edge. */
  signalled?: boolean;
  className?: string;
  children: ReactNode;
  'data-testid'?: string;
  'aria-label'?: string;
}) {
  return (
    <section
      className={['ops-panel', className].filter(Boolean).join(' ')}
      data-signalled={signalled ? '' : undefined}
      {...rest}
    >
      <div className="ops-panel__body">
        <div className="ops-panel__head">
          <h2 className="ops-panel__title">{title}</h2>
          {count !== undefined && (
            <span className="ops-panel__count">{count}</span>
          )}
          {meta && <span className="ops-panel__meta">{meta}</span>}
        </div>
        {children}
      </div>
    </section>
  );
}

/** A coloured square and its label: run and runner state. */
export function StateMark({
  tone,
  children,
  ...rest
}: {
  tone: 'ok' | 'fail' | 'warn' | 'busy' | 'idle' | 'neutral';
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <span className="ops-state" data-tone={tone} {...rest}>
      {children}
    </span>
  );
}

/** A flat track with a fill: budget, load, share of a total. */
export function Meter({
  fraction,
  tone,
  label,
}: {
  fraction: number;
  tone?: 'warn' | 'fail';
  label: string;
}) {
  const value = Math.max(0, Math.min(1, fraction));
  return (
    <div
      className="ops-meter"
      data-tone={tone}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      <i style={{ width: `${value * 100}%` }} />
    </div>
  );
}
