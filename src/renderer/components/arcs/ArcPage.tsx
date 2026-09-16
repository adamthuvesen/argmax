import { Check, Copy, FolderOpen, Play, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type {
  ArcDetail,
  ArcMemberSummary,
  ArcRecord,
  ArcState,
  DashboardSnapshot,
  ProjectSummary,
  ProviderId,
  Routine,
  SessionSummary
} from "../../../shared/types.js";
import { PROVIDER_DISPLAY_NAMES } from "../../../shared/providerModels.js";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";
import { readStoredLaunchModel } from "../../lib/launchModelPreference.js";
import { describeSchedule } from "../../lib/schedule.js";
import { factoryLaunchModel, type ModelPickerSelection } from "../../lib/models.js";
import { showSchedulePage } from "../../state/overlays.js";
import { showErrorToast } from "../../state/toast.js";

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

function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_DISPLAY_NAMES, value);
}

/** Same provider/model as the arc's previous coordinator when one is known,
 *  otherwise the user's ordinary launch default. */
function resolveCoordinatorModel(
  previous: ArcMemberSummary | null,
  previousSession: SessionSummary | null
): ModelPickerSelection {
  if (previousSession) {
    return {
      provider: previousSession.provider,
      label: previousSession.modelLabel,
      modelId: previousSession.modelId,
      ...(previousSession.reasoningEffort ? { reasoningEffort: previousSession.reasoningEffort } : {})
    };
  }
  if (previous && isProviderId(previous.provider) && previous.modelLabel && previous.modelId) {
    return { provider: previous.provider, label: previous.modelLabel, modelId: previous.modelId };
  }
  return readStoredLaunchModel() ?? factoryLaunchModel();
}

/** Browser preview and the demo snapshot carry no bridge, so the page renders
 *  from the dashboard summary and the sessions it already holds. */
function demoDetail(snapshot: DashboardSnapshot, arcId: string): ArcDetail | null {
  const summary = snapshot.arcs?.find((candidate) => candidate.id === arcId);
  if (!summary) return null;
  const members = snapshot.sessions
    .filter((session) => session.arcId === arcId)
    .map((session): ArcMemberSummary => {
      const workspace = snapshot.workspaces.find((candidate) => candidate.id === session.workspaceId);
      return {
        sessionId: session.id,
        taskLabel: workspace?.taskLabel ?? "",
        projectId: workspace?.projectId ?? "",
        projectName: snapshot.projects.find((project) => project.id === workspace?.projectId)?.name ?? "",
        workspaceId: session.workspaceId,
        state: session.state,
        provider: session.provider,
        modelLabel: session.modelLabel,
        modelId: session.modelId,
        startedAt: session.startedAt,
        isCoordinator: session.id === summary.coordinatorSessionId,
        prNumber: workspace?.prNumber ?? null,
        prState: workspace?.prState ?? null
      };
    });
  return {
    arc: {
      id: summary.id,
      name: summary.name,
      brief: "",
      state: summary.state,
      homeProjectId: summary.homeProjectId,
      coordinatorSessionId: summary.coordinatorSessionId,
      dir: summary.dir,
      createdAt: summary.updatedAt,
      updatedAt: summary.updatedAt
    },
    members,
    membersTruncated: false,
    launchesLast24h: 0,
    limits: { maxActiveMembers: 8, maxLaunchesPerDay: 40 }
  };
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
  const [detail, setDetail] = useState<ArcDetail | null>(null);
  const arc = detail?.arc ?? null;
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

  // The last record the drafts were seeded from. A reload only replaces a draft
  // the person has not touched, so a dashboard refresh never eats typing.
  const seededArc = useRef<ArcRecord | null>(null);
  const applyRecord = useCallback((record: ArcRecord): void => {
    const previous = seededArc.current;
    seededArc.current = record;
    setBriefDraft((draft) => (previous && previous.id === record.id && draft !== previous.brief ? draft : record.brief));
    setNameDraft((draft) => (previous && previous.id === record.id && draft !== previous.name ? draft : record.name));
  }, []);

  const applyArc = useCallback(
    (record: ArcRecord): void => {
      setDetail((current) => (current ? { ...current, arc: record } : current));
      applyRecord(record);
    },
    [applyRecord]
  );

  const summary = snapshot.arcs?.find((candidate) => candidate.id === arcId) ?? null;
  // What a refetch has to follow: the arc row and its membership. Session
  // state is read live from the snapshot, so it does not need a refetch.
  const summaryKey = summary
    ? `${summary.updatedAt}|${summary.memberCount}|${summary.coordinatorSessionId ?? ""}|${summary.state}`
    : "";

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const loadDetail = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      const fallback = demoDetail(snapshotRef.current, arcId);
      if (!fallback) {
        setLoadError("This arc was not found.");
        return;
      }
      setDetail(fallback);
      applyRecord(fallback.arc);
      setLoadError(null);
      return;
    }
    try {
      const next = await window.argmax.arcs.get({ id: arcId });
      setDetail(next);
      applyRecord(next.arc);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, "Could not load this arc."));
    }
  }, [arcId, applyRecord]);

  // Clear only when the page points at a different arc. A refetch for the same
  // arc keeps the page rendered and the drafts intact.
  useEffect(() => {
    seededArc.current = null;
    setDetail(null);
    setLoadError(null);
    setActionError(null);
    setEditingName(false);
  }, [arcId]);

  // summaryKey is not read by the load: it is what decides when to refetch.
  useEffect(() => {
    void loadDetail();
  }, [loadDetail, summaryKey]);

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

  const sessionsById = useMemo(
    () => new Map(snapshot.sessions.map((session) => [session.id, session])),
    [snapshot.sessions]
  );

  const coordinator = useMemo<ArcMemberSummary | null>(
    () =>
      arc?.coordinatorSessionId
        ? (detail?.members.find((member) => member.sessionId === arc.coordinatorSessionId) ?? null)
        : null,
    [arc, detail]
  );
  const coordinatorSession = coordinator ? (sessionsById.get(coordinator.sessionId) ?? null) : null;

  const members = useMemo(
    () => (detail?.members ?? []).filter((member) => member.sessionId !== arc?.coordinatorSessionId),
    [detail, arc]
  );

  const isDone = arc?.state === "done";

  const handleSetState = useCallback(
    async (state: ArcState): Promise<void> => {
      if (!arc || !window.argmax) return;
      setBusy(true);
      setActionError(null);
      try {
        applyArc(await window.argmax.arcs.setState({ id: arc.id, state }));
      } catch (error) {
        setActionError(errorMessage(error, "Could not update the arc."));
      } finally {
        setBusy(false);
      }
    },
    [arc, applyArc]
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
      applyArc(updated);
      setEditingName(false);
    } catch (error) {
      setActionError(errorMessage(error, "Could not rename the arc."));
    } finally {
      setBusy(false);
    }
  }, [arc, nameDraft, applyArc]);

  const briefDirty = arc !== null && briefDraft !== arc.brief;

  const handleSaveBrief = useCallback(async (): Promise<void> => {
    if (!arc || !window.argmax) return;
    setBriefSaving(true);
    setBriefError(null);
    try {
      applyArc(await window.argmax.arcs.update({ id: arc.id, name: null, brief: briefDraft }));
    } catch (error) {
      setBriefError(errorMessage(error, "Could not save the brief."));
    } finally {
      setBriefSaving(false);
    }
  }, [arc, briefDraft, applyArc]);

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
      const model = resolveCoordinatorModel(coordinator, coordinatorSession);
      try {
        applyArc(
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
    [arc, coordinator, coordinatorSession, applyArc]
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
        {coordinator ? (
          <>
            <p className="arc-coordinator-summary">
              {isProviderId(coordinator.provider) ? PROVIDER_DISPLAY_NAMES[coordinator.provider] : coordinator.provider}
              {coordinator.modelLabel ? ` · ${coordinator.modelLabel}` : ""} ·{" "}
              {capitalize(coordinatorSession?.state ?? coordinator.state)}
            </p>
            <div className="arc-card-actions">
              <MemberOpenButton
                label="Open chat"
                className="settings-button"
                canOpen={coordinatorSession !== null}
                onOpen={() => onOpenSession(coordinator.sessionId)}
              />
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
        ) : arc.coordinatorSessionId ? (
          <p className="arc-card-hint">Loading the coordinator…</p>
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
        {detail ? (
          <p className="arc-card-hint">
            Launched in the last 24h: {detail.launchesLast24h} of {detail.limits.maxLaunchesPerDay}
          </p>
        ) : null}
        {members.length === 0 ? (
          <p className="arc-card-hint">No member chats yet.</p>
        ) : (
          <ul className="arc-member-list" role="list">
            {members.map((member) => {
              const session = sessionsById.get(member.sessionId) ?? null;
              return (
                <li key={member.sessionId}>
                  <MemberOpenButton
                    className="arc-member-row"
                    canOpen={session !== null}
                    onOpen={() => onOpenSession(member.sessionId)}
                    label={
                      <>
                        <span className="arc-member-label">{member.taskLabel.trim() || "Untitled"}</span>
                        <span className="arc-member-meta">
                          {member.projectName ? `${member.projectName} · ` : ""}
                          {capitalize(session?.state ?? member.state)}
                          {member.prState ? ` · PR ${member.prState}` : ""}
                        </span>
                      </>
                    }
                  />
                </li>
              );
            })}
          </ul>
        )}
        {detail?.membersTruncated ? (
          <p className="arc-card-hint">Showing the {members.length} most recent member chats.</p>
        ) : null}
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

/** A chat that has aged out of the sidebar's recent list cannot be opened from
 *  here, so it says so instead of silently doing nothing. */
function MemberOpenButton({
  label,
  className,
  canOpen,
  onOpen
}: {
  label: ReactNode;
  className: string;
  canOpen: boolean;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={className}
      disabled={!canOpen}
      title={canOpen ? undefined : "This chat is no longer in the recent chat list"}
      onClick={onOpen}
    >
      {label}
    </button>
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
