import { Check, Clock, Copy, FolderOpen, Pause, Play, Trash2 } from "lucide-react";
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
  SessionState,
  SessionSummary
} from "../../../shared/types.js";
import { PROVIDER_DISPLAY_NAMES } from "../../../shared/providerModels.js";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";
import { readStoredLaunchModel } from "../../lib/launchModelPreference.js";
import { describeSchedule, formatRelative } from "../../lib/schedule.js";
import { factoryLaunchModel, type ModelPickerSelection } from "../../lib/models.js";
import { showSchedulePage } from "../../state/overlays.js";
import { showErrorToast } from "../../state/toast.js";
import { ArcTimeline } from "./ArcTimeline.js";

const ARC_STATE_LABEL: Record<ArcState, string> = {
  active: "Active",
  paused: "Paused",
  done: "Done"
};

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
  const [briefOpen, setBriefOpen] = useState(false);
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

  /** A member's live state: the snapshot's when the chat is in it, since the
   *  detail is only refetched when the arc itself changes. */
  const liveState = useCallback(
    (member: ArcMemberSummary): SessionState => sessionsById.get(member.sessionId)?.state ?? member.state,
    [sessionsById]
  );

  const activeMembers = useMemo(
    () => members.filter((member) => !SETTLED_STATES.has(liveState(member))),
    [members, liveState]
  );

  const pullRequests = useMemo(() => {
    let open = 0;
    let merged = 0;
    for (const member of detail?.members ?? []) {
      if (member.prState === "OPEN") open += 1;
      else if (member.prState === "MERGED") merged += 1;
    }
    return { open, merged };
  }, [detail]);

  // The timeline refetches when a row lands (lastEventAt) or when a member
  // settles or starts — the moments that write rows before the dashboard's
  // arc summary would say so.
  const timelineRefreshKey = [
    summary?.lastEventAt ?? "",
    summaryKey,
    (detail?.members ?? []).map((member) => `${member.sessionId}:${liveState(member)}`).join(",")
  ].join("|");

  const canOpenSession = useCallback((sessionId: string) => sessionsById.has(sessionId), [sessionsById]);

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
      <ArcPageShell>
        <h1 className="settings-page-title">Arc</h1>
        <p className="arc-load-error" role="alert">
          {loadError}
        </p>
      </ArcPageShell>
    );
  }

  if (!arc) {
    return <ArcPageShell>{null}</ArcPageShell>;
  }

  const coordinatorState = coordinator ? (coordinatorSession?.state ?? coordinator.state) : null;
  const lastActivity = summary?.lastEventAt ?? arc.updatedAt;

  return (
    <ArcPageShell>
      <header className="arc-hero">
        <div className="arc-hero-top">
          {editingName ? (
            <input
              className="arc-name-input settings-page-title"
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
            <h1 className="settings-page-title arc-title">
              <button
                type="button"
                className="arc-name-edit"
                title="Rename"
                aria-label={`Rename ${arc.name}`}
                onClick={() => setEditingName(true)}
              >
                {arc.name}
              </button>
            </h1>
          )}
          <span className="arc-state-pill" data-arc-state={arc.state}>
            {ARC_STATE_LABEL[arc.state]}
          </span>
          <div className="arc-hero-actions">
            {isDone ? (
              <button type="button" className="settings-button" disabled={busy} onClick={() => void handleSetState("active")}>
                Reopen
              </button>
            ) : (
              <>
                {arc.state === "active" ? (
                  <button type="button" className="settings-button" disabled={busy} onClick={() => void handleSetState("paused")}>
                    <Pause size={12} aria-hidden="true" /> Pause
                  </button>
                ) : (
                  <button type="button" className="settings-button" disabled={busy} onClick={() => void handleSetState("active")}>
                    <Play size={12} aria-hidden="true" /> Resume
                  </button>
                )}
                <button type="button" className="settings-button" disabled={busy} onClick={() => void handleSetState("done")}>
                  Mark done
                </button>
              </>
            )}
          </div>
        </div>
        <p className="arc-hero-meta">
          {project ? project.name : "Unknown project"}
          <span aria-hidden="true"> · </span>started {formatDay(arc.createdAt)}
          <span aria-hidden="true"> · </span>last activity {formatRelative(lastActivity)}
        </p>
        {actionError ? (
          <p className="arc-inline-error" role="alert">
            {actionError}
          </p>
        ) : null}
      </header>

      <dl className="arc-stats">
        <div className="arc-stat">
          <dt>Coordinator</dt>
          <dd>
            {coordinator ? (
              <span className="arc-stat-coordinator">
                <span className="arc-state-dot" data-session-state={coordinatorState ?? undefined} aria-hidden="true" />
                <span className="arc-stat-value">
                  {isProviderId(coordinator.provider) ? PROVIDER_DISPLAY_NAMES[coordinator.provider] : coordinator.provider}
                </span>
                {coordinator.modelLabel ? <span className="arc-stat-sub">{coordinator.modelLabel}</span> : null}
              </span>
            ) : (
              <span className="arc-stat-value arc-stat-missing">
                {arc.coordinatorSessionId ? "Loading…" : "None"}
              </span>
            )}
          </dd>
          <div className="arc-stat-actions">
            {coordinator ? (
              <MemberOpenButton
                label="Open chat"
                className="arc-stat-link"
                canOpen={coordinatorSession !== null}
                onOpen={() => onOpenSession(coordinator.sessionId)}
              />
            ) : null}
            {!isDone && coordinator ? (
              <button
                type="button"
                className="arc-stat-link"
                disabled={busy}
                onClick={() => void handleLaunchCoordinator(true)}
              >
                New coordinator
              </button>
            ) : null}
            {!isDone && !arc.coordinatorSessionId ? (
              <button
                type="button"
                className="arc-stat-link"
                disabled={busy}
                onClick={() => void handleLaunchCoordinator(false)}
              >
                Start coordinator
              </button>
            ) : null}
          </div>
        </div>
        <div className="arc-stat">
          <dt>Working now</dt>
          <dd>
            <span className="arc-stat-value">{activeMembers.length}</span>
            <span className="arc-stat-sub">of {detail?.limits.maxActiveMembers ?? 8}</span>
          </dd>
        </div>
        <div className="arc-stat">
          <dt>Launched today</dt>
          <dd>
            <span className="arc-stat-value">{detail?.launchesLast24h ?? 0}</span>
            <span className="arc-stat-sub">of {detail?.limits.maxLaunchesPerDay ?? 40}</span>
          </dd>
        </div>
        <div className="arc-stat">
          <dt>Pull requests</dt>
          <dd>
            <span className="arc-stat-value">{pullRequests.open}</span>
            <span className="arc-stat-sub">open</span>
            <span className="arc-stat-value arc-stat-merged">{pullRequests.merged}</span>
            <span className="arc-stat-sub">merged</span>
          </dd>
        </div>
      </dl>

      {activeMembers.length > 0 ? (
        <ul className="arc-active-members" aria-label="Members working now">
          {activeMembers.map((member) => (
            <li key={member.sessionId}>
              <MemberOpenButton
                className="arc-member-chip"
                canOpen={sessionsById.has(member.sessionId)}
                onOpen={() => onOpenSession(member.sessionId)}
                label={
                  <>
                    <span className="arc-state-dot" data-session-state={liveState(member)} aria-hidden="true" />
                    <span className="arc-member-chip-label">{member.taskLabel.trim() || "Untitled"}</span>
                    <span className="arc-member-chip-project">{member.projectName}</span>
                  </>
                }
              />
            </li>
          ))}
        </ul>
      ) : null}

      <details className="arc-brief" open={briefOpen} onToggle={(event) => setBriefOpen(event.currentTarget.open)}>
        <summary>
          <span className="arc-section-title">Brief</span>
          {!briefOpen ? <span className="arc-brief-preview">{firstLine(arc.brief)}</span> : null}
          {briefDirty ? <span className="arc-unsaved">Unsaved</span> : null}
        </summary>
        <div className="arc-brief-body">
          <textarea
            className="sched-input sched-textarea arc-brief-textarea"
            aria-label="Brief"
            value={briefDraft}
            disabled={isDone}
            placeholder="What this arc is for, and what done looks like."
            onChange={(event) => setBriefDraft(event.target.value)}
          />
          {briefError ? (
            <p className="arc-inline-error" role="alert">
              {briefError}
            </p>
          ) : null}
          <div className="arc-card-actions">
            <p className="arc-card-hint">Saved to BRIEF.md, which every member reads first.</p>
            {!isDone ? (
              <button
                type="button"
                className="settings-button"
                disabled={!briefDirty || briefSaving}
                onClick={() => void handleSaveBrief()}
              >
                {briefSaving ? "Saving…" : "Save"}
              </button>
            ) : null}
          </div>
        </div>
      </details>

      <ArcTimeline
        arcId={arc.id}
        refreshKey={timelineRefreshKey}
        canOpenSession={canOpenSession}
        onOpenSession={onOpenSession}
      />

      <section className="arc-setup" aria-label="Setup">
        <h2 className="arc-section-title">Setup</h2>
        <div className="arc-card">
          <div className="arc-setup-row">
            <div className="arc-setup-label">
              <span>Folder</span>
              <span className="arc-card-hint">BRIEF.md and NOTES.md live here. Only the coordinator writes to it.</span>
            </div>
            <div className="arc-folder-row">
              <code className="arc-folder-path" title={arc.dir}>
                {arc.dir}
              </code>
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

          <div className="arc-setup-divider" />

          <div className="arc-setup-row">
            <div className="arc-setup-label">
              <span>Triggers</span>
              <span className="arc-card-hint">
                {arc.state === "paused"
                  ? "Paused: nothing below wakes the coordinator until you resume."
                  : "Failing checks, passing checks, and merges on member pull requests always reach the coordinator."}
              </span>
            </div>
            {triggersError ? (
              <p className="arc-inline-error" role="alert">
                {triggersError}
              </p>
            ) : null}
            {triggerRoutines.length === 0 ? (
              <p className="arc-card-hint">
                No scheduled tasks target this arc. Add one from Scheduled Tasks with the target &ldquo;Arc coordinator&rdquo;.
              </p>
            ) : (
              <ul className="arc-member-list" role="list">
                {triggerRoutines.map((routine) => (
                  <li key={routine.id} className="arc-trigger-row">
                    <Clock size={13} aria-hidden="true" className="arc-trigger-glyph" />
                    <div className="arc-trigger-body">
                      <span className="arc-member-label">{routine.prompt.split("\n")[0] || routine.name}</span>
                      <span className="arc-member-meta">
                        {describeSchedule(routine)} · {routine.enabled ? "On" : "Paused"}
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
            <div>
              <button type="button" className="settings-button" onClick={showSchedulePage}>
                Open Scheduled Tasks
              </button>
            </div>
          </div>
        </div>
      </section>
    </ArcPageShell>
  );
}

const SETTLED_STATES: ReadonlySet<SessionState> = new Set(["complete", "failed", "cancelled"]);

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
}

function formatDay(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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

function ArcPageShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="settings-page arc-page">
      <div className="settings-topbar" data-window-drag />
      <div className="settings-main">{children}</div>
    </div>
  );
}
