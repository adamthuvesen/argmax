import type { JSX } from "react";
import type { UsageLimitWindow, UsageProviderRemaining, UsageRemaining } from "../../../shared/types.js";
import { WebLink } from "../WebLink.js";
import { formatResetIn } from "./usageFormat.js";
import { providerLabel } from "./usagePresentation.js";

function barWidth(remaining: number): number {
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.min(100, Math.max(0.8, remaining));
}

function formatLeft(percent: number): string {
  if (!Number.isFinite(percent)) return "—";
  if (percent > 0 && percent < 0.1) return "<0.1% left";
  if (percent >= 10) return `${Math.round(percent)}% left`;
  return `${percent.toFixed(1)}% left`;
}

function kindLabel(row: UsageProviderRemaining): string {
  if (row.planLabel) return row.planLabel;
  switch (row.kind) {
    case "enterprise":
      return "Enterprise";
    case "api_key":
      return "API key";
    default:
      return "";
  }
}

function WindowMeter({ window, timeZone }: { window: UsageLimitWindow; timeZone: string }): JSX.Element {
  const reset = formatResetIn(window.resetsAt, timeZone);
  return (
    <div className="usage-remaining-window">
      <div className="usage-remaining-window-meta">
        <span className="usage-remaining-window-label">{window.label}</span>
        <span className="usage-remaining-window-left">{formatLeft(window.remainingPercent)}</span>
        {reset ? <span className="usage-remaining-window-reset">{reset}</span> : null}
      </div>
      <svg
        className="usage-remaining-bar"
        viewBox="0 0 100 3"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <rect className="usage-remaining-bar-track" x="0" y="1" width="100" height="1" />
        <rect
          className="usage-remaining-bar-fill"
          x="0"
          y="0"
          width={barWidth(window.remainingPercent)}
          height="3"
        />
      </svg>
    </div>
  );
}

function RemainingDetail({
  message,
  messageUrl
}: {
  message: string;
  messageUrl?: string | null;
}): JSX.Element {
  if (!messageUrl) {
    return <p className="usage-remaining-detail">{message}</p>;
  }
  const linkText = "Spending dashboard";
  const linkAt = message.indexOf(linkText);
  if (linkAt < 0) {
    return (
      <p className="usage-remaining-detail">
        <WebLink href={messageUrl} className="usage-remaining-link">
          {message}
        </WebLink>
      </p>
    );
  }
  return (
    <p className="usage-remaining-detail">
      {message.slice(0, linkAt)}
      <WebLink href={messageUrl} className="usage-remaining-link">
        {linkText}
      </WebLink>
      {message.slice(linkAt + linkText.length)}
    </p>
  );
}

function RemainingRow({
  row,
  timeZone
}: {
  row: UsageProviderRemaining;
  timeZone: string;
}): JSX.Element {
  const title = kindLabel(row);
  const showWindows = row.kind === "subscription" && row.windows.length > 0;
  return (
    <li className="usage-remaining-row usage-series" data-provider={row.provider} data-kind={row.kind}>
      <div className="usage-remaining-head">
        <span className="usage-series-dot" aria-hidden="true" />
        <span className="usage-remaining-name">{providerLabel(row.provider)}</span>
        {title ? <span className="usage-remaining-plan">{title}</span> : null}
      </div>
      {showWindows ? (
        <div className="usage-remaining-windows">
          {row.windows.map((window) => (
            <WindowMeter key={window.id} window={window} timeZone={timeZone} />
          ))}
        </div>
      ) : (
        <RemainingDetail message={row.message ?? "No remaining usage to show."} messageUrl={row.messageUrl} />
      )}
      {showWindows && row.message ? (
        <RemainingDetail message={row.message} messageUrl={row.messageUrl} />
      ) : null}
    </li>
  );
}

export function UsageRemainingCard({
  remaining,
  error,
  timeZone,
  onRefresh
}: {
  remaining: UsageRemaining | null;
  error: string | null;
  timeZone: string;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <section className="usage-section usage-remaining" aria-label="Remaining on your plans">
      <div className="usage-section-head">
        <h2 className="usage-section-title">Remaining on your plans</h2>
        <button type="button" className="sched-button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <p className="usage-remaining-caption">
        From each provider’s account, including use outside Argmax. Not the list-price spend above.
      </p>
      {error ? (
        <p className="usage-remaining-detail" role="status">
          {error}
        </p>
      ) : null}
      {remaining ? (
        <ul className="usage-remaining-list" aria-label="Remaining usage by provider">
          {remaining.providers.map((row) => (
            <RemainingRow key={row.provider} row={row} timeZone={timeZone} />
          ))}
        </ul>
      ) : error ? null : (
        <p className="usage-remaining-detail" role="status">
          Reading remaining usage from each provider login.
        </p>
      )}
    </section>
  );
}
