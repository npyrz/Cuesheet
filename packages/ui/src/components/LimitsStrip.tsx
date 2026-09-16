/**
 * The limits strip — every vendor's windows on one line.
 *
 * Deliberately thin. Every decision about what a row *means* is in
 * `../limits.ts`, because vitest does not collect `.tsx` in this project and a
 * rule that lives here is a rule no test can reach. This file maps rows onto
 * elements and does nothing else.
 *
 * The one thing it must never do is draw a bar for a row whose `bar` is
 * `null`. That is not a style choice: three of `UsageWindow`'s four variants
 * carry no measurement at all, and a progress element sitting at zero for a
 * vendor that reported a *status* is the authoritative-looking screen this
 * phase exists to prevent.
 */
import type { HarnessUsage, Limits } from "@cuesheet/core";
import { describeUsage, type WindowRow } from "../limits.js";

export interface LimitsStripProps {
  /** `null` until the first `/usage` fetch lands. */
  usage: HarnessUsage[] | null;
  limits: Limits;
}

export function LimitsStrip({
  usage,
  limits,
}: LimitsStripProps): React.JSX.Element | null {
  // Nothing at all rather than an empty frame: a strip with no rows is furniture
  // that tells an operator less than the space it occupies.
  if (usage === null || usage.length === 0) return null;
  const vendors = describeUsage(usage, limits);
  if (vendors.length === 0) return null;

  return (
    <section className="limits" aria-label="Plan usage">
      {vendors.map((vendor) => (
        <div className="limits-vendor" key={vendor.vendor}>
          <span className="limits-name" title={vendor.harnesses.join(", ")}>
            {vendor.vendor}
          </span>
          <div className="limits-windows">
            {vendor.windows.map((row) => (
              <UsageRow key={`${vendor.vendor}-${row.window}`} row={row} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function UsageRow({ row }: { row: WindowRow }): React.JSX.Element {
  return (
    <div className={`limits-row tone-${row.tone}`} title={row.note}>
      <span className="limits-window">{row.window}</span>
      {row.bar === null ? (
        // No track, not an empty one. An empty track reads as "0% of a real
        // cap", which is the claim this row exists to avoid making.
        <span className="limits-nobar">{row.note}</span>
      ) : (
        <span
          className="limits-bar"
          role="meter"
          aria-valuenow={Math.round(row.bar * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${row.window} usage`}
        >
          <span
            className="limits-fill"
            style={{ width: `${String(Math.round(row.bar * 100))}%` }}
          />
        </span>
      )}
      <span className="limits-value">{row.value}</span>
    </div>
  );
}
