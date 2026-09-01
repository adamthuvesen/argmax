import { ChevronRight, ClipboardCopy, FolderOpen } from "lucide-react";
import { useState, type JSX } from "react";
import type { DiagnosticsReport, ProjectSummary } from "../../../shared/types.js";
import { APP_VERSION_LABEL } from "../../../shared/appVersion.js";
import { formatBytes } from "../../lib/formatBytes.js";
import { saveLogsFile } from "../../lib/logDownload.js";
import { ProjectKnowledgePanel } from "../ProjectKnowledgePanel.js";
import {
  COLD_START_BUDGET_MS,
  ColdStartSummary,
  RendererPaintRow,
  SettingGroup,
  SettingNote,
  SettingRow,
  SettingValueRow
} from "./settingsPrimitives.js";

export function AdvancedSettings({
  projects,
  diagnostics,
  diagnosticsStatus,
  setDiagnosticsStatus,
  copyDiagnostics,
  revealDatabase,
  vacuumDatabase
}: {
  projects: ProjectSummary[];
  diagnostics: DiagnosticsReport | null;
  diagnosticsStatus: string | null;
  setDiagnosticsStatus: (status: string | null) => void;
  copyDiagnostics: () => Promise<void>;
  revealDatabase: () => Promise<void>;
  vacuumDatabase: () => Promise<void>;
}): JSX.Element {
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const stats = diagnostics?.databaseStats;
  const readyPhase = diagnostics?.startupPhases?.find((phase) => phase.phase === "window.ready-to-show");

  return (
    <>
      <SettingGroup id="settings-knowledge" label="Project knowledge" card={false}>
        <ProjectKnowledgePanel projects={projects} />
      </SettingGroup>

      <SettingGroup id="settings-diagnostics" label="Diagnostics">
        {diagnostics ? (
          <SettingRow
            label="Runtime details"
            description={`Version ${diagnostics.appVersion} · SQLite ${diagnostics.sqliteVersion} · ${diagnostics.platform} ${diagnostics.arch}`}
            control={
              <>
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => void copyDiagnostics()}
                  aria-label="Copy diagnostics"
                >
                  <ClipboardCopy size={13} aria-hidden="true" />
                  <span>Copy</span>
                </button>
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => void revealDatabase()}
                  aria-label="Reveal database file"
                >
                  <FolderOpen size={13} aria-hidden="true" />
                  <span>Reveal database</span>
                </button>
              </>
            }
          />
        ) : (
          <SettingNote>Loading runtime details…</SettingNote>
        )}

        <SettingRow
          label="Database"
          description={
            stats
              ? `${totalRows(stats).toLocaleString()} rows · WAL ${formatBytes(stats.walBytes)}`
              : diagnostics?.databasePath
          }
          control={
            <button
              type="button"
              className="settings-button"
              onClick={() => void vacuumDatabase()}
              aria-label="Vacuum database"
            >
              Vacuum
            </button>
          }
        />

        <SettingRow
          label="Logs"
          description={
            diagnostics?.recentLogs?.length
              ? `Main-process ring buffer, last ${diagnostics.recentLogs.length} entries.`
              : "Main-process ring buffer."
          }
          control={
            <button
              type="button"
              className="settings-button"
              onClick={() => saveLogsFile(diagnostics?.recentLogs ?? [], setDiagnosticsStatus)}
              disabled={!diagnostics || diagnostics.recentLogs.length === 0}
              aria-label="Save log file"
            >
              Save log file
            </button>
          }
        />

        <SettingRow
          label="Performance"
          description={
            readyPhase
              ? `Cold start ${readyPhase.elapsedMs.toFixed(0)} ms of a ${COLD_START_BUDGET_MS.toLocaleString()} ms budget.`
              : "Startup phases, IPC latency, and row counts for this boot."
          }
          control={
            <button
              type="button"
              className="settings-button settings-button-quiet"
              aria-expanded={performanceOpen}
              onClick={() => setPerformanceOpen((open) => !open)}
            >
              <span>{performanceOpen ? "Hide details" : "Show details"}</span>
              <ChevronRight size={13} aria-hidden="true" data-rotated={performanceOpen ? "true" : undefined} />
            </button>
          }
        />

        {diagnosticsStatus ? (
          <p className="settings-note settings-diagnostics-status" role="status">
            <span className="settings-diagnostics-status-dot" aria-hidden="true" />
            {diagnosticsStatus}
          </p>
        ) : null}
      </SettingGroup>

      {performanceOpen ? (
        <div className="settings-performance">
          {stats ? (
            <div className="settings-card">
              <h4 className="settings-card-title">Row counts</h4>
              <dl className="settings-metric-grid">
                {(
                  [
                    ["Projects", stats.rowCounts.projects],
                    ["Workspaces", stats.rowCounts.workspaces],
                    ["Sessions", stats.rowCounts.sessions],
                    ["Events", stats.rowCounts.events],
                    ["Raw outputs", stats.rowCounts.rawOutputs],
                    ["Approvals", stats.rowCounts.approvals],
                    ["Checks", stats.rowCounts.checks],
                    ["Learnings", stats.rowCounts.learnings],
                    ["Usage events", stats.rowCounts.usageEvents]
                  ] as const
                ).map(([label, count]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{count.toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {diagnostics?.startupPhases?.length ? (
            <div className="settings-card">
              <h4 className="settings-card-title">Startup phases</h4>
              <ColdStartSummary phases={diagnostics.startupPhases} />
              <table className="settings-startup-table" aria-label="Startup phase timings">
                <thead>
                  <tr>
                    <th scope="col">Phase</th>
                    <th scope="col">Elapsed</th>
                    <th scope="col">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostics.startupPhases.map((phase) => {
                    const overBudget =
                      phase.phase === "window.ready-to-show" && phase.elapsedMs > COLD_START_BUDGET_MS;
                    return (
                      <tr key={phase.phase} data-over-budget={overBudget || undefined}>
                        <td>
                          <code>{phase.phase}</code>
                          {overBudget ? (
                            <span className="settings-badge" role="status">
                              over budget
                            </span>
                          ) : null}
                        </td>
                        <td>{phase.elapsedMs.toFixed(2)} ms</td>
                        <td>{phase.deltaMs.toFixed(2)} ms</td>
                      </tr>
                    );
                  })}
                  <RendererPaintRow />
                </tbody>
              </table>
            </div>
          ) : null}

          {diagnostics?.ipcStats?.length ? (
            <div className="settings-card">
              <h4 className="settings-card-title">IPC latency</h4>
              <p className="settings-note">
                Per-channel p50 / p99 across the last 100 invocations. Refreshes when this page
                re-opens.
              </p>
              <table className="settings-startup-table" aria-label="IPC channel latency">
                <thead>
                  <tr>
                    <th scope="col">Channel</th>
                    <th scope="col">Count</th>
                    <th scope="col">p50</th>
                    <th scope="col">p99</th>
                  </tr>
                </thead>
                <tbody>
                  {diagnostics.ipcStats.map((stat) => (
                    <tr key={stat.channel}>
                      <td>
                        <code>{stat.channel}</code>
                      </td>
                      <td>{stat.count.toLocaleString()}</td>
                      <td>{stat.p50.toFixed(2)} ms</td>
                      <td>{stat.p99.toFixed(2)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {diagnostics?.recentLogs?.length ? (
            <div className="settings-card">
              <h4 className="settings-card-title">Recent logs</h4>
              <ul className="settings-logs-list" aria-label="Recent log entries">
                {diagnostics.recentLogs.map((entry, index) => (
                  <li key={`${entry.timestamp}-${index}`} data-log-level={entry.level} className="settings-logs-entry">
                    <span className="settings-logs-dot" aria-hidden="true" />
                    <span className="settings-logs-timestamp">{entry.timestamp}</span>
                    <span className="settings-logs-level">{entry.level}</span>
                    <code className="settings-logs-scope">{entry.scope}</code>
                    <span className="settings-logs-message">{entry.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <SettingGroup id="settings-about" label="About">
        <SettingValueRow label="Version" value={APP_VERSION_LABEL} />
        <SettingValueRow label="Runtime" value="Tauri · local, single user" />
        <SettingValueRow label="Storage" value="SQLite, on this device" />
        <SettingValueRow label="Network" value="Provider calls only" />
        <SettingValueRow label="Providers" value="Claude · Codex · Cursor · OpenCode · Grok" />
      </SettingGroup>
    </>
  );
}

function totalRows(stats: NonNullable<DiagnosticsReport["databaseStats"]>): number {
  return Object.values(stats.rowCounts).reduce((sum, count) => sum + count, 0);
}
