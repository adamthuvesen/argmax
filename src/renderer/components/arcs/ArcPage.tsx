import { Check, Clock, Copy, FolderOpen, Pencil, Trash2 } from "lucide-react";
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
import { describeSchedule } from "../../lib/schedule.js";
import { isTypingTarget } from "../../lib/typingTarget.js";
import { formatTimeAgo } from "../../lib/arcTimeline.js";
import { factoryLaunchModel, type ModelPickerSelection } from "../../lib/models.js";
import { showSchedulePage } from "../../state/overlays.js";
import { showErrorToast, showToast } from "../../state/toast.js";
import { withToast } from "../../lib/withToast.js";
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
  onOpenSession,
  onClose
}: {
  arcId: string;
  snapshot: DashboardSnapshot;
  projects: ProjectSummary[];
  onOpenSession: (sessionId: string) => void;
  onClose: () => void;
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
  const [triggersRemote, setTriggersRemote] = useState(false);
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
      const message = errorMessage(error, "Could not load triggers.");
      // The phone bridge does not carry scheduled tasks; that is not a failure.
      if (message.includes("only available in the desktop app")) {
        setTriggersRemote(true);
      } else {
        setTriggersError(message);
      }
    }
  }, [arcId]);

  useEffect(() => {
    void loadTriggers();
  }, [loadTriggers]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
          <div className="arc-hero-actions">
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
        </div>
        <p className="arc-hero-meta">
          <span className="arc-hero-state" data-arc-state={arc.state}>
            {ARC_STATE_LABEL[arc.state]}
          </span>
          <span aria-hidden="true"> · </span>
          {project ? project.name : "Unknown project"}
          <span aria-hidden="true"> · </span>started {formatDay(arc.createdAt)}
          <span aria-hidden="true"> · </span>last activity {formatTimeAgo(lastActivity)}
        </p>
        {actionError ? (
          <p className="arc-inline-error" role="alert">
            {actionError}
          </p>
        ) : null}

        {briefOpen ? (
          <div className="arc-brief arc-brief-editing">
            <textarea
              className="sched-input sched-textarea arc-brief-textarea"
              aria-label="Brief"
              value={briefDraft}
              autoFocus
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
              <div className="arc-brief-buttons">
                <button
                  type="button"
                  className="settings-button"
                  disabled={briefSaving}
                  onClick={() => {
                    setBriefDraft(arc.brief);
                    setBriefOpen(false);
                  }}
                >
                  Cancel
                </button>
                {!isDone ? (
                  <button
                    type="button"
                    className="settings-button arc-brief-save"
                    disabled={!briefDirty || briefSaving}
                    onClick={() => void handleSaveBrief().then(() => setBriefOpen(false))}
                  >
                    {briefSaving ? "Saving…" : "Save"}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="arc-brief">
            {arc.brief.trim() ? (
              <p className="arc-brief-prose">{briefExcerpt(arc.brief)}</p>
            ) : (
              <p className="arc-brief-prose arc-brief-empty">No brief yet. Members read it first, so say what done looks like.</p>
            )}
            <button type="button" className="arc-quiet-button" onClick={() => setBriefOpen(true)}>
              <Pencil size={12} aria-hidden="true" />
              {arc.brief.trim() ? "Edit brief" : "Add a brief"}
            </button>
          </div>
        )}
      </header>

      <section className="arc-chats" aria-label="Chats">
        <header className="arc-chats-header">
          <h2 className="arc-section-title">Chats</h2>
          <p className="arc-chats-summary">{chatsSummary(activeMembers.length, pullRequests)}</p>
        </header>
        <div className="arc-chat-row">
          <span className="arc-state-dot" data-session-state={coordinatorState ?? undefined} aria-hidden="true" />
          {coordinator ? (
            <MemberOpenButton
              className="arc-chat-open"
              canOpen={coordinatorSession !== null}
              onOpen={() => onOpenSession(coordinator.sessionId)}
              label={
                <>
                  {isProviderId(coordinator.provider) ? PROVIDER_DISPLAY_NAMES[coordinator.provider] : coordinator.provider}
                  {coordinator.modelLabel ? <span className="arc-chat-model">{coordinator.modelLabel}</span> : null}
                </>
              }
            />
          ) : (
            <span className="arc-chat-missing">{arc.coordinatorSessionId ? "Loading…" : "No coordinator"}</span>
          )}
          <span className="arc-chat-meta">
            Coordinator
            {coordinatorState ? ` · ${describeSessionState(coordinatorState)}` : ""}
          </span>
          {!isDone && coordinator ? (
            <button
              type="button"
              className="arc-quiet-button arc-chat-action"
              disabled={busy}
              onClick={() => void handleLaunchCoordinator(true)}
            >
              New coordinator
            </button>
          ) : null}
          {!isDone && !arc.coordinatorSessionId ? (
            <button
              type="button"
              className="arc-quiet-button arc-chat-action"
              disabled={busy}
              onClick={() => void handleLaunchCoordinator(false)}
            >
              Start coordinator
            </button>
          ) : null}
        </div>
        {activeMembers.length > 0 ? (
          <ul className="arc-chat-list" aria-label="Members working now">
            {activeMembers.map((member) => (
              <li key={member.sessionId} className="arc-chat-row">
                <span className="arc-state-dot" data-session-state={liveState(member)} aria-hidden="true" />
                <MemberOpenButton
                  className="arc-chat-open"
                  canOpen={sessionsById.has(member.sessionId)}
                  onOpen={() => onOpenSession(member.sessionId)}
                  label={member.taskLabel.trim() || "Untitled"}
                />
                <span className="arc-chat-meta">
                  {member.projectName} · {describeSessionState(liveState(member))}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

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
                {shortPath(arc.dir)}
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
                    onClick={() =>
                      void withToast(
                        async () => window.argmax?.system.openPath({ path: arc.dir }),
                        showToast,
                        "Could not open the arc folder."
                      )
                    }
                  >
                    <FolderOpen size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    onClick={() =>
                      void withToast(
                        async () => window.argmax?.system.openPath({ path: `${arc.dir}/NOTES.md` }),
                        showToast,
                        "Could not open NOTES.md."
                      )
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
              <span>Limits</span>
              <span className="arc-card-hint">
                Up to {detail?.limits.maxActiveMembers ?? 8} members working at once.{" "}
                {detail?.launchesLast24h ?? 0} of {detail?.limits.maxLaunchesPerDay ?? 40} launches used today.
              </span>
            </div>
          </div>

          <div className="arc-setup-divider" />

          <div className="arc-setup-row">
            <div className="arc-setup-label">
              <span>Triggers</span>
              <span className="arc-card-hint">
                {arc.state === "paused"
                  ? "Paused: nothing wakes the coordinator until you resume."
                  : "Checks and merges on member pull requests wake the coordinator."}
              </span>
            </div>
            {triggersError ? (
              <p className="arc-inline-error" role="alert">
                {triggersError}
              </p>
            ) : null}
            {triggersRemote ? (
              <p className="arc-card-hint">Scheduled tasks for this arc are listed in the desktop app.</p>
            ) : triggerRoutines.length === 0 ? (
              <p className="arc-card-hint">No scheduled tasks yet.</p>
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
                Add a scheduled task
              </button>
            </div>
          </div>
        </div>
      </section>
    </ArcPageShell>
  );
}

const SETTLED_STATES: ReadonlySet<SessionState> = new Set(["complete", "failed", "cancelled"]);

/** The brief's first paragraph of body text: what the arc is for, in the
 *  author's words. Headings are skipped — a brief usually opens with the
 *  arc's name as an H1, and the page already carries that. */
function briefExcerpt(text: string): string {
  const lines = text.split("\n").map((line) => (/^#+\s/.test(line) ? "" : line.trim()));
  const start = lines.findIndex(Boolean);
  if (start === -1) return firstHeading(text);
  const end = lines.findIndex((line, index) => index > start && !line);
  return lines.slice(start, end === -1 ? undefined : end).join(" ");
}

/** A brief that is only headings still has something to say. */
function firstHeading(text: string): string {
  return text.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
}

/** The tail of a path a person can recognise: nobody reads a UUID folder in
 *  full, and the whole path is one click away on the copy button. */
function shortPath(dir: string): string {
  const parts = dir.split("/").filter(Boolean);
  return parts.length <= 3 ? dir : `…/${parts.slice(-2).join("/")}`;
}

function describeSessionState(state: SessionState | null): string {
  switch (state) {
    case "running":
    case "created":
      return "working";
    case "waiting":
    case "blocked":
      return "waiting for you";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "complete":
      return "idle";
    default:
      return "";
  }
}

/** The section's one-line reading. Pull requests are only counted once there
 *  are some: an arc with none has nothing to headline. */
function chatsSummary(working: number, pullRequests: { open: number; merged: number }): string {
  const parts = [working === 0 ? "None working" : `${working} working`];
  if (pullRequests.open + pullRequests.merged > 0) {
    parts.push(`${pullRequests.open} ${pullRequests.open === 1 ? "PR" : "PRs"} open`, `${pullRequests.merged} merged`);
  }
  return parts.join(" · ");
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
      title={canOpen ? "Open chat" : "This chat is no longer in the recent chat list"}
      onClick={onOpen}
    >
      {label}
    </button>
  );
}

function ArcPageShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <section className="settings-page arc-page" aria-label="Arc">
      <div className="settings-topbar" data-window-drag />
      <div className="settings-main arc-page-body">{children}</div>
    </section>
  );
}
