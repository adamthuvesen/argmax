import { Check, Copy, FolderOpen, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import type { ArcRecord, ArcState, DashboardSnapshot, ProjectSummary, Routine, SessionSummary } from "../../../shared/types.js";
import { PROVIDER_DISPLAY_NAMES } from "../../../shared/providerModels.js";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";
import { readStoredLaunchModel } from "../../lib/launchModelPreference.js";
import { describeSchedule } from "../../lib/schedule.js";
import { factoryLaunchModel, type ModelPickerSelection } from "../../lib/models.js";
import { showSchedulePage } from "../../state/overlays.js";
import { showErrorToast } from "../../state/toast.js";

// Product-specified display denominator for "launched recently" — not a
// backend-enforced cap on arc member launches (none is exposed on ArcRecord
// or ArcSummary yet). Flagged for the orchestrator to reconcile against the
// Rust coordinator-launch caps landing in a parallel worktree.
const ARC_RECENT_LAUNCH_WINDOW_HOURS = 24;
const ARC_RECENT_LAUNCH_DISPLAY_LIMIT = 40;

const ARC_STATE_LABEL: Record<ArcState, string> = {
  active: "Active",
  paused: "Paused",
  done: "Done"
};

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Same provider/model as the arc's previous coordinator when one is known,
 *  otherwise the user's ordinary launch default. */
function resolveCoordinatorModel(previous: SessionSummary | null): ModelPickerSelection {
  if (previous) {
    return {
      provider: previous.provider,
      label: previous.modelLabel,
      modelId: previous.modelId,
      ...(previous.reasoningEffort ? { reasoningEffort: previous.reasoningEffort } : {})
    };
  }
  return readStoredLaunchModel() ?? factoryLaunchModel();
}

interface ArcMemberRow {
  session: SessionSummary;
  workspaceLabel: string;
  projectName: string | null;
  prState: string | null;
}

export function ArcPage({
  arcId,
  snapshot,
  projects,
  onOpenSession
}: {
  arcId: string;
  snapshot: DashboardSnapshot;
  projects: ProjectSummary[];
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const [arc, setArc] = useState<ArcRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const [triggerRoutines, setTriggerRoutines] = useState<Routine[]>([]);
  const [triggersError, setTriggersError] = useState<string | null>(null);
  const [removingRoutineId, setRemovingRoutineId] = useState<string | null>(null);

  const [briefDraft, setBriefDraft] = useState("");
  const [briefSaving, setBriefSaving] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);

  const [copyFlash, copy] = useCopyToClipboard();

  const loadArc = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      // Browser preview and the demo snapshot carry no bridge at all — the
      // summary is all there is, so render from it rather than leaving the
      // page blank (the brief is the one field it doesn't carry).
      const summary = snapshot.arcs?.find((candidate) => candidate.id === arcId) ?? null;
      if (!summary) {
        setLoadError("This arc was not found.");
        return;
      }
      const fallback: ArcRecord = {
        id: summary.id,
        name: summary.name,
        brief: "",
        state: summary.state,
        homeProjectId: summary.homeProjectId,
        coordinatorSessionId: summary.coordinatorSessionId,
        dir: summary.dir,
        createdAt: summary.updatedAt,
        updatedAt: summary.updatedAt
      };
      setArc(fallback);
      setNameDraft(fallback.name);
      setBriefDraft(fallback.brief);
      setLoadError(null);
      return;
    }
    try {
      const { arc: record } = await window.argmax.arcs.get({ id: arcId });
      setArc(record);
      setNameDraft(record.name);
      setBriefDraft(record.brief);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, "Could not load this arc."));
    }
  }, [arcId, snapshot.arcs]);

  // Fresh load every time the sidebar points the page at a different arc —
  // the summary in the dashboard snapshot carries no brief text.
  useEffect(() => {
    setArc(null);
    setLoadError(null);
    setActionError(null);
    setEditingName(false);
    void loadArc();
  }, [loadArc]);

  const loadTriggers = useCallback(async (): Promise<void> => {
    if (!window.argmax) return;
    try {
      const routines = await window.argmax.routines.list();
      setTriggerRoutines(routines.filter((routine) => routine.arcId === arcId));
      setTriggersError(null);
    } catch (error) {
      setTriggersError(errorMessage(error, "Could not load triggers."));
    }
  }, [arcId]);

  useEffect(() => {
    void loadTriggers();
  }, [loadTriggers]);

  const handleRemoveTrigger = useCallback(
    async (routine: Routine): Promise<void> => {
      if (!window.argmax) return;
      const confirmed = await window.argmax.system.confirm(
        `Delete “${routine.name}”? Chats it already started stay in the sidebar.`
      );
      if (!confirmed) return;
      setRemovingRoutineId(routine.id);
      setTriggersError(null);
      try {
        await window.argmax.routines.delete(routine.id);
        await loadTriggers();
      } catch (error) {
        setTriggersError(errorMessage(error, "Could not remove the trigger."));
      } finally {
        setRemovingRoutineId(null);
      }
    },
    [loadTriggers]
  );

  const project = useMemo(
    () => (arc ? (projects.find((candidate) => candidate.id === arc.homeProjectId) ?? null) : null),
    [arc, projects]
  );

  const coordinatorSession = useMemo<SessionSummary | null>(
    () =>
      arc?.coordinatorSessionId
        ? (snapshot.sessions.find((session) => session.id === arc.coordinatorSessionId) ?? null)
        : null,
    [arc, snapshot.sessions]
  );

  const members = useMemo<ArcMemberRow[]>(() => {
    if (!arc) return [];
    return snapshot.sessions
      .filter((session) => session.arcId === arc.id && session.id !== arc.coordinatorSessionId)
      .map((session) => {
        const workspace = snapshot.workspaces.find((candidate) => candidate.id === session.workspaceId) ?? null;
        return {
          session,
          workspaceLabel: workspace?.taskLabel.trim() || workspace?.branch || session.prompt.slice(0, 60) || "Untitled",
          projectName: workspace ? (projects.find((candidate) => candidate.id === workspace.projectId)?.name ?? null) : null,
          prState: workspace?.prState ?? null
        };
      })
      .sort((a, b) => b.session.startedAt.localeCompare(a.session.startedAt));
  }, [arc, snapshot.sessions, snapshot.workspaces, projects]);

  const recentLaunchCount = useMemo(() => {
    const cutoff = Date.now() - ARC_RECENT_LAUNCH_WINDOW_HOURS * 60 * 60 * 1000;
    return members.filter(({ session }) => new Date(session.startedAt).getTime() >= cutoff).length;
  }, [members]);

  const isDone = arc?.state === "done";

  const handleSetState = useCallback(
    async (state: ArcState): Promise<void> => {
      if (!arc || !window.argmax) return;
      setBusy(true);
      setActionError(null);
      try {
        setArc(await window.argmax.arcs.setState({ id: arc.id, state }));
      } catch (error) {
        setActionError(errorMessage(error, "Could not update the arc."));
      } finally {
        setBusy(false);
      }
    },
    [arc]
  );

  const handleSaveName = useCallback(async (): Promise<void> => {
    if (!arc || !window.argmax) return;
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === arc.name) {
      setNameDraft(arc.name);
      setEditingName(false);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const updated = await window.argmax.arcs.update({ id: arc.id, name: trimmed, brief: null });
      setArc(updated);
      setEditingName(false);
    } catch (error) {
      setActionError(errorMessage(error, "Could not rename the arc."));
    } finally {
      setBusy(false);
    }
  }, [arc, nameDraft]);

  const briefDirty = arc !== null && briefDraft !== arc.brief;

  const handleSaveBrief = useCallback(async (): Promise<void> => {
    if (!arc || !window.argmax) return;
    setBriefSaving(true);
    setBriefError(null);
    try {
      setArc(await window.argmax.arcs.update({ id: arc.id, name: null, brief: briefDraft }));
    } catch (error) {
      setBriefError(errorMessage(error, "Could not save the brief."));
    } finally {
      setBriefSaving(false);
    }
  }, [arc, briefDraft]);

  const handleLaunchCoordinator = useCallback(
    async (isNew: boolean): Promise<void> => {
      if (!arc || !window.argmax) return;
      if (isNew) {
        const confirmed = await window.argmax.system.confirm(
          "Start a new coordinator chat? The current one stays in the sidebar as history. The new chat starts fresh from BRIEF.md and NOTES.md."
        );
        if (!confirmed) return;
      }
      setBusy(true);
      setActionError(null);
      const model = resolveCoordinatorModel(coordinatorSession);
      try {
        setArc(
          await window.argmax.arcs.launchCoordinator({
            arcId: arc.id,
            provider: model.provider,
            modelLabel: model.label,
            modelId: model.modelId,
            reasoningEffort: model.reasoningEffort ?? null
          })
        );
      } catch (error) {
        showErrorToast(errorMessage(error, "Could not launch the coordinator."));
      } finally {
        setBusy(false);
      }
    },
    [arc, coordinatorSession]
  );

  if (loadError && !arc) {
    return (
      <ArcPageShell title="Arc">
        <p className="arc-load-error" role="alert">
          {loadError}
        </p>
      </ArcPageShell>
    );
  }

  if (!arc) {
    return <ArcPageShell title="Arc">{null}</ArcPageShell>;
  }

  return (
    <ArcPageShell title={arc.name}>
      <div className="arc-card arc-header-card">
        <div className="arc-header-row">
          {editingName ? (
            <input
              className="arc-name-input"
              value={nameDraft}
              aria-label="Arc name"
              autoFocus
              disabled={busy}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={() => void handleSaveName()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleSaveName();
                } else if (event.key === "Escape") {
                  setNameDraft(arc.name);
                  setEditingName(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="arc-name-edit"
              aria-label={`Rename ${arc.name}`}
              onClick={() => setEditingName(true)}
            >
              {arc.name}
            </button>
          )}
          <span className="arc-state-pill" data-arc-state={arc.state}>
            {ARC_STATE_LABEL[arc.state]}
          </span>
        </div>
        <p className="arc-header-meta">
          {project ? project.name : "Unknown project"} · created {formatTimestamp(arc.createdAt)}
        </p>
        <div className="arc-header-actions">
          {isDone ? (
            <button type="button" className="settings-button" disabled={busy} onClick={() => void handleSetState("active")}>
              Reopen
            </button>
          ) : (
            <>
              {arc.state === "active" ? (
                <button type="button" className="settings-button" disabled={busy} onClick={() => void handleSetState("paused")}>
                  Pause
                </button>
              ) : (
                <button type="button" className="settings-button" disabled={busy} onClick={() => void handleSetState("active")}>
                  Resume
                </button>
              )}
              <button type="button" className="settings-button" disabled={busy} onClick={() => void handleSetState("done")}>
                Mark done
              </button>
            </>
          )}
        </div>
        {actionError ? (
          <p className="arc-inline-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>

      <div className="arc-card">
        <h2 className="arc-card-title">Brief</h2>
        <textarea
          className="sched-input sched-textarea arc-brief-textarea"
          value={briefDraft}
          disabled={isDone}
          placeholder="What this arc is for, and what done looks like."
          onChange={(event) => setBriefDraft(event.target.value)}
        />
        <p className="arc-card-hint">Saved to BRIEF.md in the arc's folder.</p>
        {briefError ? (
          <p className="arc-inline-error" role="alert">
            {briefError}
          </p>
        ) : null}
        {!isDone ? (
          <div className="arc-card-actions">
            {briefDirty ? <span className="arc-unsaved">Unsaved changes</span> : null}
            <button
              type="button"
              className="settings-button"
              disabled={!briefDirty || briefSaving}
              onClick={() => void handleSaveBrief()}
            >
              {briefSaving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="arc-card">
        <h2 className="arc-card-title">Folder</h2>
        <div className="arc-folder-row">
          <code className="arc-folder-path">{arc.dir}</code>
          <button
            type="button"
            className="small-icon"
            aria-label="Copy folder path"
            title="Copy folder path"
            onClick={() => void copy(arc.dir)}
          >
            {copyFlash === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          </button>
          {window.argmax?.system ? (
            <>
              <button
                type="button"
                className="small-icon"
                aria-label="Reveal arc folder in Finder"
                title="Reveal in Finder"
                onClick={() => void window.argmax?.system.openPath({ path: arc.dir }).catch(() => undefined)}
              >
                <FolderOpen size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="settings-button"
                aria-label="Open NOTES.md"
                title="Open NOTES.md"
                onClick={() =>
                  void window.argmax?.system.openPath({ path: `${arc.dir}/NOTES.md` }).catch(() => undefined)
                }
              >
                Open NOTES.md
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="arc-card">
        <h2 className="arc-card-title">Coordinator</h2>
        {coordinatorSession ? (
          <>
            <p className="arc-coordinator-summary">
              {PROVIDER_DISPLAY_NAMES[coordinatorSession.provider]} · {coordinatorSession.modelLabel} ·{" "}
              {capitalize(coordinatorSession.state)}
            </p>
            <div className="arc-card-actions">
              <button type="button" className="settings-button" onClick={() => onOpenSession(coordinatorSession.id)}>
                Open chat
              </button>
              {!isDone ? (
                <button
                  type="button"
                  className="settings-button"
                  disabled={busy}
                  onClick={() => void handleLaunchCoordinator(true)}
                >
                  New coordinator
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <p className="arc-card-hint">This arc has no coordinator chat yet.</p>
            {!isDone ? (
              <div className="arc-card-actions">
                <button
                  type="button"
                  className="settings-button"
                  disabled={busy}
                  onClick={() => void handleLaunchCoordinator(false)}
                >
                  <Play size={13} aria-hidden="true" /> Start coordinator
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="arc-card">
        <h2 className="arc-card-title">Members</h2>
        <p className="arc-card-hint">
          Launched in the last {ARC_RECENT_LAUNCH_WINDOW_HOURS}h: {recentLaunchCount} of{" "}
          {ARC_RECENT_LAUNCH_DISPLAY_LIMIT}
        </p>
        {members.length === 0 ? (
          <p className="arc-card-hint">No member chats yet.</p>
        ) : (
          <ul className="arc-member-list" role="list">
            {members.map(({ session, workspaceLabel, projectName, prState }) => (
              <li key={session.id}>
                <button type="button" className="arc-member-row" onClick={() => onOpenSession(session.id)}>
                  <span className="arc-member-label">{workspaceLabel}</span>
                  <span className="arc-member-meta">
                    {projectName ? `${projectName} · ` : ""}
                    {capitalize(session.state)}
                    {prState ? ` · PR ${prState}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="arc-card">
        <h2 className="arc-card-title">Triggers</h2>
        {arc.state === "paused" ? (
          <p className="arc-inline-error" role="status">
            Paused — triggers are silenced
          </p>
        ) : null}
        <p className="arc-card-hint">
          Pull requests from member chats: failing checks, passing checks, and merges are sent to the
          coordinator.
        </p>
        {triggersError ? (
          <p className="arc-inline-error" role="alert">
            {triggersError}
          </p>
        ) : null}
        {triggerRoutines.length === 0 ? (
          <p className="arc-card-hint">
            No scheduled tasks target this arc. Add one from Scheduled Tasks with target
            &ldquo;Arc coordinator&rdquo;.
          </p>
        ) : (
          <ul className="arc-member-list" role="list">
            {triggerRoutines.map((routine) => (
              <li key={routine.id} className="arc-trigger-row">
                <div className="arc-trigger-body">
                  <span className="arc-member-label">{routine.prompt.split("\n")[0] || routine.name}</span>
                  <span className="arc-member-meta">
                    {describeSchedule(routine)} · {routine.enabled ? "Enabled" : "Paused"}
                  </span>
                </div>
                <button
                  type="button"
                  className="small-icon"
                  aria-label={`Remove ${routine.name}`}
                  title={`Remove ${routine.name}`}
                  disabled={removingRoutineId === routine.id}
                  onClick={() => void handleRemoveTrigger(routine)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="arc-card-actions">
          <button type="button" className="settings-button" onClick={showSchedulePage}>
            Open Scheduled Tasks
          </button>
        </div>
      </div>
    </ArcPageShell>
  );
}

function ArcPageShell({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="settings-page">
      <div className="settings-topbar" data-window-drag />
      <div className="settings-main">
        <h1 className="settings-page-title">{title}</h1>
        {children}
      </div>
    </div>
  );
}
