import { ClipboardCopy, FolderOpen } from "lucide-react";
import type { JSX } from "react";
import type { DiagnosticsReport, ProjectSummary } from "../../../shared/types.js";
import { formatBytes } from "../../lib/formatBytes.js";
import { saveLogsFile } from "../../lib/logDownload.js";
import { ProjectKnowledgePanel } from "../ProjectKnowledgePanel.js";
import {
  COLD_START_BUDGET_MS,
  ColdStartSummary,
  KeyValueList,
  RendererPaintRow,
  SectionHeader
} from "./settingsPrimitives.js";

export function SystemSettings({
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
  return (
    <>
      <section className="settings-section" id="settings-knowledge" aria-labelledby="settings-knowledge-h">
        <SectionHeader
          index={0}
          id="settings-knowledge-h"
          eyebrow="Memory"
          title="Project knowledge"
          description="Learnings Argmax has captured from your sessions. The top-K of these are injected as a preamble for every new launch — verified ones stick to the top of the list."
        />
        <ProjectKnowledgePanel projects={projects} />
      </section>

      <section className="settings-section" id="settings-diagnostics" aria-labelledby="settings-diagnostics-h">
        <SectionHeader
          index={1}
          id="settings-diagnostics-h"
          eyebrow="Telemetry"
          title="Diagnostics"
          description="Runtime details for bug reports. No data leaves the machine."
        />
        <div className="settings-card">
          {diagnostics ? (
            <KeyValueList
              rows={[
                { dt: "App version", dd: diagnostics.appVersion },
                { dt: "Electron", dd: diagnostics.electronVersion || "unknown" },
                { dt: "Node", dd: diagnostics.nodeVersion },
                { dt: "SQLite", dd: diagnostics.sqliteVersion },
                { dt: "Platform", dd: `${diagnostics.platform} · ${diagnostics.arch}` },
                {
                  dt: "Database",
                  dd: <span className="settings-diagnostics-path">{diagnostics.databasePath}</span>
                }
              ]}
            />
          ) : (
            <p className="settings-hint">Loading runtime details…</p>
          )}
          <div className="settings-diagnostics-actions">
            <button
              type="button"
              onClick={() => void copyDiagnostics()}
              disabled={!diagnostics}
              aria-label="Copy diagnostics"
            >
              <ClipboardCopy size={13} aria-hidden="true" />
              <span>Copy diagnostics</span>
            </button>
            <button
              type="button"
              onClick={() => void revealDatabase()}
              disabled={!diagnostics}
              aria-label="Reveal database file"
            >
              <FolderOpen size={13} aria-hidden="true" />
              <span>Reveal database</span>
            </button>
            <button type="button" onClick={() => void vacuumDatabase()} aria-label="Vacuum database">
              <span>Vacuum database</span>
            </button>
            <button
              type="button"
              onClick={() => saveLogsFile(diagnostics?.recentLogs ?? [], setDiagnosticsStatus)}
              disabled={!diagnostics || diagnostics.recentLogs.length === 0}
              aria-label="Save log file"
            >
              <span>Save log file</span>
            </button>
          </div>
          {diagnosticsStatus ? (
            <p className="settings-hint settings-diagnostics-status" role="status">
              <span className="settings-diagnostics-status-dot" aria-hidden="true" />
              {diagnosticsStatus}
            </p>
          ) : null}
        </div>

        {diagnostics?.databaseStats ? (
          <div className="settings-card" aria-labelledby="settings-diagnostics-database">
            <h3 id="settings-diagnostics-database" className="settings-card-title">
              Database
            </h3>
            <p className="settings-hint">
              Row counts across the live SQLite store.
            </p>
            <dl className="settings-keyvals settings-metric-grid">
              <div>
                <dt>Projects</dt>
                <dd>{diagnostics.databaseStats.rowCounts.projects.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Workspaces</dt>
                <dd>{diagnostics.databaseStats.rowCounts.workspaces.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Sessions</dt>
                <dd>{diagnostics.databaseStats.rowCounts.sessions.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Events</dt>
                <dd>{diagnostics.databaseStats.rowCounts.events.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Raw outputs</dt>
                <dd>{diagnostics.databaseStats.rowCounts.rawOutputs.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Approvals</dt>
                <dd>{diagnostics.databaseStats.rowCounts.approvals.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Checks</dt>
                <dd>{diagnostics.databaseStats.rowCounts.checks.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Checkpoints</dt>
                <dd>{diagnostics.databaseStats.rowCounts.checkpoints.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Learnings</dt>
                <dd>{diagnostics.databaseStats.rowCounts.learnings.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Usage events</dt>
                <dd>{diagnostics.databaseStats.rowCounts.usageEvents.toLocaleString()}</dd>
              </div>
              <div>
                <dt>WAL size</dt>
                <dd>{formatBytes(diagnostics.databaseStats.walBytes)}</dd>
              </div>
              <div>
                <dt>WAL autocheckpoint</dt>
                <dd>{diagnostics.databaseStats.walAutocheckpoint.toLocaleString()} pages</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {diagnostics?.recentLogs?.length ? (
          <div className="settings-card" aria-labelledby="settings-diagnostics-logs">
            <h3 id="settings-diagnostics-logs" className="settings-card-title">
              Recent logs
            </h3>
            <p className="settings-hint">
              Main-process ring buffer tail. Refreshes when this panel re-opens. Use{" "}
              <em>Copy diagnostics</em> to capture the full payload for a bug report.
            </p>
            <ul className="settings-logs-list" aria-label="Recent log entries">
              {diagnostics.recentLogs.map((entry, index) => (
                <li
                  key={`${entry.timestamp}-${index}`}
                  data-log-level={entry.level}
                  className="settings-logs-entry"
                >
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

        {diagnostics?.ipcStats?.length ? (
          <div className="settings-card" aria-labelledby="settings-diagnostics-ipc">
            <h3 id="settings-diagnostics-ipc" className="settings-card-title">
              IPC latency
            </h3>
            <p className="settings-hint">
              Per-channel p50 / p99 across the last 100 invocations. Refreshes when this panel
              re-opens or you click <em>Copy diagnostics</em>.
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

        {diagnostics?.startupPhases?.length ? (
          <div className="settings-card" aria-labelledby="settings-diagnostics-startup">
            <h3 id="settings-diagnostics-startup" className="settings-card-title">
              Startup phases
            </h3>
            <ColdStartSummary phases={diagnostics.startupPhases} />
            <p className="settings-hint">
              Cold-start timing for the current boot. Budget: 1500&nbsp;ms to <code>ready-to-show</code>.
              See <code>agents/docs/performance.md</code>.
            </p>
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
                  const overBudget = phase.phase === "window.ready-to-show" && phase.elapsedMs > COLD_START_BUDGET_MS;
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
      </section>

      <section className="settings-section" id="settings-about" aria-labelledby="settings-about-h">
        <SectionHeader
          index={2}
          id="settings-about-h"
          eyebrow="Colophon"
          title="About"
          description="The fine print."
        />
        <div className="settings-card">
          <KeyValueList
            rows={[
              { dt: "App", dd: "Argmax" },
              { dt: "Runtime", dd: "Electron · single-user local" },
              { dt: "Providers", dd: "Claude Code · Codex" }
            ]}
          />
        </div>
      </section>
    </>
  );
}
