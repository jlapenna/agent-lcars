import type { ReactNode } from 'react';

import { Sparkline } from './ops-primitives';

export interface ConsoleReadout {
  /** Stable key and test hook. */
  id: string;
  label: string;
  value: ReactNode;
  /** One short line of context; omit rather than pad. */
  detail?: ReactNode;
  /** The mockup's sparkline under the figure. Without `values` the slot
   * shows the unavailable mark instead of a flat line that reads as zero. */
  spark?: { label: string; values?: readonly (number | undefined)[] };
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
          {readout.spark &&
            (readout.spark.values ? (
              <Sparkline
                values={readout.spark.values}
                label={readout.spark.label}
              />
            ) : (
              <span
                className="lcars-readout__nospark"
                role="img"
                aria-label={`${readout.spark.label}: unavailable`}
                title={`${readout.spark.label}: unavailable`}
              >
                —
              </span>
            ))}
        </div>
      ))}
    </section>
  );
}
