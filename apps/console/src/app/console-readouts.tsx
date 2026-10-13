import type { ReactNode } from 'react';

export interface ConsoleReadout {
  /** Stable key and test hook. */
  id: string;
  label: string;
  value: ReactNode;
  /** One short line of context; omit rather than pad. */
  detail?: ReactNode;
}

/**
 * The row of large figures at the top of a workspace (design/fleet-console.html
 * "readouts"). Each value must come from data the route already holds: a
 * readout with no honest source is left out, never shown as zero.
 */
export function ConsoleReadouts({
  label,
  readouts,
}: {
  label: string;
  readouts: readonly ConsoleReadout[];
}) {
  return (
    <section className="lcars-readouts" aria-label={label}>
      {readouts.map((readout) => (
        <div
          key={readout.id}
          className="lcars-readout"
          data-testid={`readout-${readout.id}`}
        >
          <span className="lcars-eyebrow lcars-readout__label">
            {readout.label}
          </span>
          <span className="lcars-readout__value">{readout.value}</span>
          {readout.detail ? (
            <span className="lcars-readout__detail">{readout.detail}</span>
          ) : null}
        </div>
      ))}
    </section>
  );
}
