import { Gauge } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { ProviderId, UsageRemaining } from "../../shared/types.js";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { getCachedUsageRemaining } from "../lib/ledgerPageState.js";
import {
  lookUpUsageRemaining,
  remainingFiguresAreOld,
  summarizeProviderWithHeld
} from "../lib/usageRemainingLookup.js";
import { RemainingBar } from "./usage/RemainingBar.js";
import { formatRemainingPercent, formatResetIn } from "./usage/usageFormat.js";
import { providerLabel } from "./usage/usagePresentation.js";

const CHIP_TICK_MS = 60_000;

/** `2:05 PM`: when figures that have gone old were true. */
function formatAsOf(asOf: string): string {
  const at = new Date(asOf);
  return Number.isNaN(at.getTime())
    ? asOf
    : at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * How much is left on the plan behind the composer's provider: the tightest
 * window as a figure on the toolbar, every window and its reset time in a
 * popover. It is a read of what the account reports, from the Usage page's
 * own cache, and nothing else: it never asks a model anything and never
 * resumes a chat that hit a limit. The chip appears only for a provider whose
 * login reports plan windows (an API key or a signed-out login has none).
 * Pressing it refreshes the figures, at most once every half minute. When an
 * account fails to answer, the chip keeps the last figures it had and shows
 * the time they were true as of, rather than going blank or looking current.
 */
export function ComposerUsageChip({ provider }: { provider: ProviderId }): JSX.Element | null {
  const [remaining, setRemaining] = useState<UsageRemaining | null>(getCachedUsageRemaining);
  const [open, setOpen] = useState(false);
  const flyout = useAnchoredPopover({ open, placement: "bottom-start", strategy: "absolute" });
  useDismissOnOutsideOrEscape(flyout.anchorRef, open, () => setOpen(false));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const lookUp = useCallback(async (manual: boolean): Promise<void> => {
    try {
      const next = await lookUpUsageRemaining({ manual });
      if (mounted.current) setRemaining(next);
    } catch {
      // A failed read leaves the last figures standing; the Usage page says why.
    }
  }, []);

  // Joins the read the boot prefetch or another composer already has in flight.
  useEffect(() => {
    void lookUp(false);
  }, [lookUp]);

  // A composer can stay mounted for hours. Once a minute it asks again, which
  // the lookup answers from the cache until the figures are five minutes old
  // (and holds off after a failure), and it re-reads the clock so figures that
  // have gone old say so.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void lookUp(false);
    }, CHIP_TICK_MS);
    return () => window.clearInterval(timer);
  }, [lookUp]);

  const held = summarizeProviderWithHeld(remaining, provider);
  if (!held) return null;

  const { summary, asOf } = held;
  const { tightest, windows, planLabel } = summary;
  const old = remainingFiguresAreOld(asOf, now);
  const asOfTime = old ? formatAsOf(asOf) : null;
  const figure = formatRemainingPercent(tightest.remainingPercent);
  const reset = formatResetIn(tightest.resetsAt);
  const label = `${providerLabel(provider)} plan: ${figure} left in the ${tightest.label} window${
    reset ? `, ${reset}` : ""
  }${asOfTime ? `, as of ${asOfTime}` : ""}`;

  return (
    <div className="composer-usage-anchor" ref={flyout.setAnchor}>
      <button
        type="button"
        className="composer-footer-chip composer-usage-chip"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-low={tightest.remainingPercent < 10 ? "true" : undefined}
        data-old={old ? "true" : undefined}
        title={label}
        onClick={() => {
          setOpen((current) => !current);
          void lookUp(true);
        }}
      >
        <Gauge size={13} aria-hidden="true" />
        <span>{asOfTime ? `${figure} · ${asOfTime}` : figure}</span>
      </button>
      {open ? (
        <div
          className="composer-usage-popover"
          role="dialog"
          aria-label="Plan usage"
          ref={flyout.setPopover}
          style={flyout.floatingStyles}
        >
          <p className="composer-usage-head">
            {providerLabel(provider)}
            {planLabel ? <span className="composer-usage-plan"> · {planLabel}</span> : null}
          </p>
          <ul
            className="composer-usage-windows usage-series"
            data-provider={provider}
            aria-label={`${providerLabel(provider)} limits`}
          >
            {windows.map((window) => {
              const resetsIn = formatResetIn(window.resetsAt);
              return (
                <li key={window.id} className="identity-plans-window">
                  <span className="identity-plans-window-label">
                    {window.label}
                    {resetsIn ? (
                      <span className="identity-plans-window-reset"> · {resetsIn}</span>
                    ) : null}
                  </span>
                  <span className="identity-plans-window-left">
                    {formatRemainingPercent(window.remainingPercent)} left
                  </span>
                  <RemainingBar remaining={window.remainingPercent} />
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
