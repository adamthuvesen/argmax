import { useEffect, useState, type JSX } from "react";
import type { UsageLimitWindow, UsageProviderRemaining, UsageRemaining } from "../../shared/types.js";
import {
  getCachedUsageRemaining,
  requestUsageRemaining,
  setCachedUsageRemaining
} from "../lib/ledgerPageState.js";
import { LoadingLine } from "./LoadingLine.js";
import { RemainingBar } from "./usage/RemainingBar.js";
import { formatRemainingPercent, formatResetShort } from "./usage/usageFormat.js";
import { providerLabel } from "./usage/usagePresentation.js";

/**
 * How long a remaining read stands before an open refreshes it. The figures
 * come from provider accounts over the network and Claude's endpoint
 * rate-limits, so opening the menu twice in a minute must not fetch twice.
 */
const STALE_AFTER_MS = 5 * 60_000;

async function fetchRemaining(): Promise<UsageRemaining> {
  const api = globalThis.window?.argmax;
  if (api?.usage.remaining) return api.usage.remaining();
  // No bridge (browser preview / screenshot harness): the demo fixture is
  // dynamic-imported so it never reaches the packaged bundle.
  const { demoUsageRemaining } = await import("../demoUsage.js");
  return demoUsageRemaining();
}

function isStale(remaining: UsageRemaining | null, now: number): boolean {
  if (!remaining) return true;
  const fetchedAt = Date.parse(remaining.fetchedAt);
  return !Number.isFinite(fetchedAt) || now - fetchedAt > STALE_AFTER_MS;
}

/** A provider is shown only where its account actually reported windows. */
function hasWindows(row: UsageProviderRemaining): boolean {
  return row.kind === "subscription" && row.windows.length > 0;
}

function PlanWindow({ window }: { window: UsageLimitWindow }): JSX.Element {
  const reset = formatResetShort(window.resetsAt);
  return (
    <div className="identity-plans-window">
      <span className="identity-plans-window-label">
        {window.label}
        {reset ? <span className="identity-plans-window-reset"> · {reset}</span> : null}
      </span>
      <span className="identity-plans-window-left">
        {formatRemainingPercent(window.remainingPercent)}
      </span>
      <RemainingBar remaining={window.remainingPercent} />
    </div>
  );
}

/**
 * Plan remaining inside the sidebar's Argmax menu: every limit window each
 * provider login reports, so the answer to "how much have I got left?" is one
 * click from anywhere. Providers that report nothing (Cursor, an API key, a
 * signed-out login) are left out rather than shown as empty — the Usage page
 * is where the full story, including why a provider is silent, is told.
 *
 * The read is the one the Usage page uses, shared through the ledger cache, so
 * a menu open normally paints figures the boot prefetch already has.
 */
export function IdentityPlans({ onOpenUsage }: { onOpenUsage: () => void }): JSX.Element | null {
  const [remaining, setRemaining] = useState<UsageRemaining | null>(() =>
    getCachedUsageRemaining()
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isStale(getCachedUsageRemaining(), Date.now())) return;
    let live = true;
    void requestUsageRemaining(fetchRemaining).then(
      (next) => {
        if (live) setRemaining(next);
      },
      (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : "Could not read remaining usage.";
        setCachedUsageRemaining(null, message);
        if (live) setFailed(true);
      }
    );
    return () => {
      live = false;
    };
  }, []);

  const rows = (remaining?.providers ?? []).filter(hasWindows);

  // Nothing to say yet, and nothing to say at all, look the same from here:
  // the menu keeps the shape it has always had. A failed read is reported on
  // the Usage page, not in a menu the user opened to reach Settings.
  if (rows.length === 0) {
    if (remaining !== null || failed) return null;
    return (
      <li className="identity-plans" role="presentation">
        <LoadingLine label="Reading how much is left on your plans." />
      </li>
    );
  }

  return (
    <>
      <li className="identity-plans" role="presentation">
        <div className="identity-plans-head">
          <span className="identity-plans-label">Plans left</span>
          <button type="button" className="identity-plans-more" onClick={onOpenUsage}>
            Usage
          </button>
        </div>
        <ul className="identity-plans-list" aria-label="Remaining on your plans">
          {rows.map((row) => (
            <li
              key={row.provider}
              className="identity-plans-row usage-series"
              data-provider={row.provider}
            >
              <div className="identity-plans-provider">
                <span className="usage-series-dot" aria-hidden="true" />
                <span className="identity-plans-name">{providerLabel(row.provider)}</span>
                {row.planLabel ? (
                  <span className="identity-plans-plan">{row.planLabel}</span>
                ) : null}
              </div>
              {row.windows.map((window) => (
                <PlanWindow key={window.id} window={window} />
              ))}
            </li>
          ))}
        </ul>
      </li>
      <li className="project-picker-divider" role="separator" />
    </>
  );
}
