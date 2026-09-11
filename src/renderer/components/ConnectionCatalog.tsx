import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Copy,
  Link2,
  PlugZap,
  Puzzle,
  RefreshCw
} from "lucide-react";
import { useCallback, useEffect, useState, type JSX } from "react";
import { PROVIDER_DISPLAY_NAMES } from "../../shared/providerModels.js";
import type { ConnectionSummary, ProviderId } from "../../shared/types.js";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";
import { LoadingLine } from "./LoadingLine.js";

type LoadState =
  | { state: "loading"; rows: ConnectionSummary[] }
  | { state: "ready"; rows: ConnectionSummary[] }
  | { state: "error"; rows: ConnectionSummary[]; message: string };

export function ConnectionCatalog({
  provider,
  workspaceId = null,
  compact = false
}: {
  provider: ProviderId;
  workspaceId?: string | null;
  compact?: boolean;
}): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ state: "loading", rows: [] });
  const loadConnections = useCallback(async (): Promise<void> => {
    setLoad((current) => ({ state: "loading", rows: current.rows }));
    try {
      const rows = await window.argmax?.connections.list({ provider, workspaceId });
      if (!rows) throw new Error("Connection inventory is unavailable in this preview.");
      setLoad({ state: "ready", rows });
    } catch (error) {
      setLoad((current) => ({
        state: "error",
        rows: current.rows,
        message: error instanceof Error ? error.message : "Could not load connections."
      }));
    }
  }, [provider, workspaceId]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const counts = summarize(load.rows);
  return (
    <div className="connection-catalog" data-compact={compact || undefined}>
      <div className="connection-catalog-summary">
        <span>
          {load.state === "loading" && load.rows.length === 0 ? (
            <>Checking {PROVIDER_DISPLAY_NAMES[provider]}</>
          ) : (
            <>
              <strong>{load.rows.length}</strong> available to {PROVIDER_DISPLAY_NAMES[provider]}
            </>
          )}
        </span>
        {load.state === "ready" ? (
          <span className="connection-catalog-counts">
            {counts.connected} confirmed
            {counts.needsAuthentication > 0
              ? ` · ${counts.needsAuthentication} need${counts.needsAuthentication === 1 ? "s" : ""} login`
              : ""}
          </span>
        ) : null}
        <button
          type="button"
          className="connection-refresh"
          onClick={() => void loadConnections()}
          disabled={load.state === "loading"}
          aria-label={`Refresh ${PROVIDER_DISPLAY_NAMES[provider]} connections`}
          title="Refresh connections"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      {load.state === "loading" && load.rows.length === 0 ? (
        <LoadingLine label="Checking provider connections" />
      ) : null}
      {load.state === "error" ? (
        <p className="connection-catalog-error" role="alert">
          {load.message}
        </p>
      ) : null}
      {load.rows.length > 0 ? (
        <ul className="connection-list" aria-label={`${PROVIDER_DISPLAY_NAMES[provider]} connections`}>
          {load.rows.map((connection) => (
            <ConnectionRow
              key={`${connection.kind}:${connection.name}`}
              connection={connection}
            />
          ))}
        </ul>
      ) : load.state === "ready" ? (
        <p className="connection-catalog-empty">No connections found.</p>
      ) : null}
      <p className="connection-catalog-footnote">
        Confirmed means the provider health-check succeeded. Unknown means the provider does not
        expose login validity. It does not mean that login failed.
      </p>
    </div>
  );
}

function ConnectionRow({ connection }: { connection: ConnectionSummary }): JSX.Element {
  const [copyState, copy] = useCopyToClipboard();
  const status = rowStatus(connection);
  const KindIcon =
    connection.kind === "plugin" ? Puzzle : connection.kind === "connector" ? Link2 : PlugZap;
  const StatusIcon =
    status === "connected" || status === "available"
      ? CircleCheck
      : status === "needs-authentication"
        ? CircleAlert
        : CircleHelp;
  return (
    <li className="connection-row" data-status={status}>
      <span className="connection-kind-icon" data-kind={connection.kind} aria-hidden="true">
        <KindIcon size={15} />
      </span>
      <span className="connection-row-copy">
        <span className="connection-row-title">
          <strong>{connection.name}</strong>
          <span className="connection-kind">{kindLabel(connection.kind)}</span>
          <span className="connection-scope">{scopeLabel(connection.scope)}</span>
        </span>
        <span className="connection-detail">{connection.statusDetail}</span>
      </span>
      <span className="connection-status" data-status={status}>
        <StatusIcon size={13} aria-hidden="true" />
        {statusLabel(status)}
      </span>
      {connection.authenticationCommand ? (
        <button
          type="button"
          className="connection-auth-action"
          onClick={() => void copy(connection.authenticationCommand ?? "")}
          aria-label={`Copy authentication instructions for ${connection.name}`}
          title={connection.authenticationCommand}
        >
          {copyState === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copyState === "copied" ? "Copied" : "Login"}
        </button>
      ) : null}
    </li>
  );
}

function summarize(rows: ConnectionSummary[]): {
  connected: number;
  needsAuthentication: number;
} {
  return rows.reduce(
    (counts, row) => ({
      connected:
        counts.connected + (row.authentication === "authenticated" ? 1 : 0),
      needsAuthentication:
        counts.needsAuthentication + (row.authentication === "required" ? 1 : 0)
    }),
    { connected: 0, needsAuthentication: 0 }
  );
}

function kindLabel(kind: ConnectionSummary["kind"]): string {
  if (kind === "mcp-server") return "MCP";
  return kind === "plugin" ? "Plugin" : "Connector";
}

function scopeLabel(scope: ConnectionSummary["scope"]): string {
  if (scope === "built-in") return "Argmax";
  return scope === "project" ? "Project" : "User";
}

type RowStatus = "connected" | "needs-authentication" | "available" | "unknown" | "disabled";

function rowStatus(connection: ConnectionSummary): RowStatus {
  if (connection.availability === "disabled") return "disabled";
  if (connection.authentication === "authenticated") return "connected";
  if (connection.authentication === "required") return "needs-authentication";
  if (connection.authentication === "not-applicable") return "available";
  return "unknown";
}

function statusLabel(status: RowStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "needs-authentication":
      return "Needs login";
    case "available":
      return "Available";
    case "disabled":
      return "Disabled";
    case "unknown":
      return "Unknown";
  }
}
