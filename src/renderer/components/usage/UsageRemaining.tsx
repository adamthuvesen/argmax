import type { JSX } from "react";
import type { UsageLimitWindow, UsageProviderRemaining, UsageRemaining } from "../../../shared/types.js";
import { WebLink } from "../WebLink.js";
import { LoadingLine } from "../LoadingLine.js";
import { RemainingBar } from "./RemainingBar.js";
import { formatRemainingPercent, formatResetIn } from "./usageFormat.js";
import { providerLabel } from "./usagePresentation.js";

function formatLeft(percent: number): string {
  const figure = formatRemainingPercent(percent);
  return figure === "—" ? figure : `${figure} left`;
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

function WindowMeter({ window }: { window: UsageLimitWindow }): JSX.Element {
  const reset = formatResetIn(window.resetsAt);
  return (
    <div className="usage-remaining-window">
      <div className="usage-remaining-window-meta">
        <span className="usage-remaining-window-label">{window.label}</span>
        <span className="usage-remaining-window-left">{formatLeft(window.remainingPercent)}</span>
        {reset ? <span className="usage-remaining-window-reset">{reset}</span> : null}
      </div>
      <RemainingBar remaining={window.remainingPercent} />
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
  row
}: {
  row: UsageProviderRemaining;
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
            <WindowMeter key={window.id} window={window} />
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
  onRefresh
}: {
  remaining: UsageRemaining | null;
  error: string | null;
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
            <RemainingRow key={row.provider} row={row} />
          ))}
        </ul>
      ) : error ? null : (
        <LoadingLine label="Reading remaining usage from each provider login." />
      )}
    </section>
  );
}
