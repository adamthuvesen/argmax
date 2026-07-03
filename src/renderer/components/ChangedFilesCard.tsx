import { ChevronRight, Play } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import type { CheckRun } from "../../shared/types.js";

export function ChangedFilesCard({
  workspaceId,
  checkCommands = [],
  checks = [],
  onRunCheck
}: {
  workspaceId?: string;
  checkCommands?: string[];
  checks?: CheckRun[];
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
}): JSX.Element | null {
  const showChecks = checkCommands.length > 0;

  if (!showChecks) {
    return null;
  }

  return (
    <section className="changed-files-card" aria-label="Workspace checks">
      <ChecksList
        workspaceId={workspaceId ?? null}
        checkCommands={checkCommands}
        checks={checks}
        onRunCheck={onRunCheck}
      />
    </section>
  );
}

function ChecksList({
  workspaceId,
  checkCommands,
  checks,
  onRunCheck
}: {
  workspaceId: string | null;
  checkCommands: string[];
  checks: CheckRun[];
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
}): JSX.Element {
  // Reduce the workspace-scoped check feed into a "last run per command" map so
  // each registered check renders the most recent outcome regardless of how
  // many historical runs are in the dashboard buffer.
  const lastRunByCommand = useMemo(() => {
    const map = new Map<string, CheckRun>();
    for (const run of checks) {
      if (workspaceId && run.workspaceId !== workspaceId) continue;
      const existing = map.get(run.command);
      if (!existing) {
        map.set(run.command, run);
        continue;
      }
      const candidate = Date.parse(run.startedAt);
      const previous = Date.parse(existing.startedAt);
      if (Number.isFinite(candidate) && (!Number.isFinite(previous) || candidate > previous)) {
        map.set(run.command, run);
      }
    }
    return map;
  }, [checks, workspaceId]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);

  const toggleExpand = (command: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(command)) next.delete(command);
      else next.add(command);
      return next;
    });
  };

  const handleRun = async (command: string): Promise<void> => {
    if (!workspaceId || !onRunCheck) return;
    setPendingCommand(command);
    try {
      await onRunCheck(workspaceId, command);
    } finally {
      setPendingCommand((current) => (current === command ? null : current));
    }
  };

  return (
    <div className="checks-list" aria-label="Workspace checks">
      <div className="checks-list-title">Checks</div>
      {checkCommands.map((command) => {
        const lastRun = lastRunByCommand.get(command) ?? null;
        const isRunning = pendingCommand === command || lastRun?.status === "running";
        const isExpanded = expanded.has(command);
        const summary = lastRun?.summary ?? null;
        return (
          <div
            className="checks-row"
            key={command}
            data-status={lastRun?.status ?? "idle"}
            aria-label={`Check ${command}`}
          >
            <div className="checks-row-head">
              <button
                type="button"
                className="checks-row-run"
                aria-label={`Run check ${command}`}
                title={`Run ${command}`}
                disabled={!workspaceId || !onRunCheck || isRunning}
                onClick={() => {
                  void handleRun(command);
                }}
              >
                <Play size={12} />
              </button>
              <code className="checks-row-command">{command}</code>
              <span className="checks-row-status">{statusLabelFor(lastRun, isRunning)}</span>
              <span className="checks-row-duration">{formatDuration(lastRun)}</span>
              <button
                type="button"
                className="checks-row-expand"
                aria-expanded={isExpanded}
                aria-label={`Toggle log for ${command}`}
                onClick={() => toggleExpand(command)}
                disabled={!summary}
              >
                <ChevronRight size={12} className={`checks-row-chevron${isExpanded ? " expanded" : ""}`} />
              </button>
            </div>
            {isExpanded && summary ? (
              <pre className="checks-row-log" aria-label={`Log for ${command}`}>
                {summary}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function statusLabelFor(run: CheckRun | null, isRunning: boolean): string {
  if (isRunning) return "running";
  if (!run) return "—";
  return run.status;
}

function formatDuration(run: CheckRun | null): string {
  if (!run) return "";
  const start = Date.parse(run.startedAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const ms = end - start;
  if (ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds - minutes * 60);
  return `${minutes}m${remaining.toString().padStart(2, "0")}s`;
}
