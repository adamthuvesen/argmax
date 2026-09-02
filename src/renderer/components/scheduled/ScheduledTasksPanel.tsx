import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type JSX,
  type ReactNode,
  type SetStateAction
} from "react";
import { Pencil, Play, Plus, Trash2 } from "lucide-react";
import { SCRATCH_PROJECT_ID, type ProjectSummary, type ProviderId, type Routine } from "../../../shared/types.js";
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_MODEL_DEFAULTS,
  PROVIDER_MODELS
} from "../../../shared/providerModels.js";
import {
  buildSchedule,
  DEFAULT_SCHEDULE_CONTROLS,
  describeCadence,
  describeSchedule,
  formatRelative,
  pad2,
  parseSchedule,
  WEEKDAY_PICKER_OPTIONS,
  type ScheduleControls,
  type ScheduleKind
} from "../../lib/schedule.js";
import { SettingsListPicker } from "../settings/settingsPrimitives.js";

/** Matches `SCHEDULER_TICK` in routines/scheduler.rs. The panel waits out one
 *  full tick past a due time before re-reading, so the refresh lands after the
 *  launch it is waiting on rather than a moment before it. */
const SCHEDULER_TICK_MS = 30_000;
/** `setTimeout` overflows past ~24.8 days, and a yearly cron would reach it. */
const MAX_REFRESH_DELAY_MS = 24 * 60 * 60 * 1000;
const STATUS_DISMISS_MS = 5_000;

interface DraftState {
  routineId: string | null;
  name: string;
  projectId: string;
  provider: ProviderId;
  modelId: string;
  prompt: string;
  worktree: boolean;
  enabled: boolean;
  kind: ScheduleKind;
  controls: ScheduleControls;
}

function newDraft(projectId: string): DraftState {
  const provider: ProviderId = "claude";
  return {
    routineId: null,
    name: "",
    projectId,
    provider,
    modelId: PROVIDER_MODEL_DEFAULTS[provider].modelId,
    prompt: "",
    worktree: true,
    enabled: true,
    kind: "daily",
    controls: { ...DEFAULT_SCHEDULE_CONTROLS }
  };
}

function draftFromRoutine(routine: Routine): DraftState {
  const { kind, controls } = parseSchedule(routine);
  return {
    routineId: routine.id,
    name: routine.name,
    projectId: routine.projectId,
    provider: routine.provider,
    modelId: routine.modelId,
    prompt: routine.prompt,
    worktree: routine.worktree,
    enabled: routine.enabled,
    kind,
    controls
  };
}

const SCHEDULE_KIND_OPTIONS: ReadonlyArray<{ value: ScheduleKind; label: string }> = [
  { value: "once", label: "Once" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom" }
];

/** A fresh worktree off the current branch, or the repository checkout itself.
 *  Named by where the run lands rather than by the boolean it sets. */
const WORKTREE_OPTIONS = [
  { value: "worktree", label: "Isolated worktree" },
  { value: "checkout", label: "Current checkout" }
];

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Resting state of a row, which drives both the marker colour and the
 *  right-hand column: a task is either counting down, stopped, or broken. */
function routineState(routine: Routine): "failed" | "paused" | "scheduled" {
  if (routine.lastError) return "failed";
  return routine.enabled ? "scheduled" : "paused";
}

export function ScheduledTasksPanel({ projects }: { projects: ProjectSummary[] }): JSX.Element {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      setLoadError("Open the Tauri app window to manage scheduled tasks.");
      return;
    }
    try {
      setRoutines(await window.argmax.routines.list());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error, "Could not load scheduled tasks."));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The scheduler fires in Rust, so "next run" goes stale on its own. Rather
  // than poll, re-read once the soonest due time has passed; every reload
  // re-arms this from the rows it just read.
  useEffect(() => {
    const dueTimes = (routines ?? [])
      .filter((routine) => routine.enabled && routine.nextRunAt !== null)
      .map((routine) => new Date(routine.nextRunAt as string).getTime())
      .filter((time) => Number.isFinite(time));
    if (dueTimes.length === 0) return;
    const delay = Math.min(
      MAX_REFRESH_DELAY_MS,
      Math.max(SCHEDULER_TICK_MS, Math.min(...dueTimes) - Date.now() + SCHEDULER_TICK_MS)
    );
    const timer = window.setTimeout(() => void reload(), delay);
    return () => window.clearTimeout(timer);
  }, [routines, reload]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(null), STATUS_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  // `App` hands over the real repositories already; the filter is a guard so
  // the scratch side-chats project can never become a task's target.
  const repositories = useMemo(
    () => projects.filter((project) => project.id !== SCRATCH_PROJECT_ID),
    [projects]
  );

  const modelOptions = useMemo(
    () => PROVIDER_MODELS[draft?.provider ?? "claude"].map((model) => ({ value: model.modelId, label: model.label })),
    [draft?.provider]
  );

  const projectName = useCallback(
    (projectId: string): string =>
      repositories.find((project) => project.id === projectId)?.name ?? projectId,
    [repositories]
  );

  /** Every action starts from a clean slate, so a stale success line never
   *  sits beside a fresh failure. */
  const beginAction = useCallback(() => {
    setStatus(null);
    setActionError(null);
  }, []);

  const startNew = useCallback(() => {
    setSaveError(null);
    setDraft(newDraft(repositories[0]?.id ?? ""));
  }, [repositories]);

  const startEdit = useCallback((routine: Routine) => {
    setSaveError(null);
    setDraft(draftFromRoutine(routine));
  }, []);

  const closeEditor = useCallback(() => setDraft(null), []);

  const saveDraft = useCallback(async () => {
    if (!draft || !window.argmax) return;
    if (!draft.name.trim()) {
      setSaveError("Give the task a name.");
      return;
    }
    if (!draft.projectId) {
      setSaveError("Choose a repository.");
      return;
    }
    if (!draft.prompt.trim()) {
      setSaveError("Write the prompt the agent will run.");
      return;
    }
    const schedule = buildSchedule(draft.kind, draft.controls);
    if (!schedule.cronExpr && !schedule.runOnceAt) {
      setSaveError("Choose when the task should run.");
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      await window.argmax.routines.upsert({
        id: draft.routineId ?? crypto.randomUUID(),
        name: draft.name.trim(),
        projectId: draft.projectId,
        prompt: draft.prompt,
        provider: draft.provider,
        modelLabel:
          PROVIDER_MODELS[draft.provider].find((model) => model.modelId === draft.modelId)?.label ??
          PROVIDER_MODEL_DEFAULTS[draft.provider].label,
        modelId: draft.modelId,
        worktree: draft.worktree,
        cronExpr: schedule.cronExpr,
        runOnceAt: schedule.runOnceAt,
        enabled: draft.enabled
      });
      setActionError(null);
      setStatus(draft.routineId ? "Task updated." : "Task created.");
      setDraft(null);
      await reload();
    } catch (error) {
      setSaveError(errorMessage(error, "Could not save the task."));
    } finally {
      setBusy(false);
    }
  }, [draft, reload]);

  const toggleEnabled = useCallback(
    async (routine: Routine) => {
      if (!window.argmax) return;
      beginAction();
      try {
        await window.argmax.routines.setEnabled(routine.id, !routine.enabled);
        await reload();
      } catch (error) {
        setActionError(errorMessage(error, "Could not update the task."));
      }
    },
    [beginAction, reload]
  );

  const runNow = useCallback(
    async (routine: Routine) => {
      if (!window.argmax) return;
      beginAction();
      setBusy(true);
      try {
        await window.argmax.routines.runNow(routine.id);
        setStatus(`Started “${routine.name}”. The chat is in the sidebar.`);
        await reload();
      } catch (error) {
        setActionError(errorMessage(error, "Could not run the task."));
      } finally {
        setBusy(false);
      }
    },
    [beginAction, reload]
  );

  const removeRoutine = useCallback(
    async (routine: Routine) => {
      if (!window.argmax) return;
      if (!window.confirm(`Delete “${routine.name}”? Chats it already started stay in the sidebar.`)) return;
      beginAction();
      try {
        await window.argmax.routines.delete(routine.id);
        setStatus("Task deleted.");
        await reload();
      } catch (error) {
        setActionError(errorMessage(error, "Could not delete the task."));
      }
    },
    [beginAction, reload]
  );

  if (draft) {
    return (
      <SchedulePage>
        <ScheduledTaskEditor
          draft={draft}
          setDraft={setDraft}
          projects={repositories}
          modelOptions={modelOptions}
          saveError={saveError}
          busy={busy}
          onSave={() => void saveDraft()}
          onCancel={closeEditor}
        />
      </SchedulePage>
    );
  }

  const pausedCount = routines?.filter((routine) => !routine.enabled).length ?? 0;
  const total = routines?.length ?? 0;

  return (
    <SchedulePage>
      <div className="sched-column">
          {routines !== null && total > 0 ? (
            <div className="sched-toolbar">
              <p className="sched-count">
                {total} {total === 1 ? "task" : "tasks"}
                {pausedCount > 0 ? <span className="sched-count-sep"> · {pausedCount} paused</span> : null}
              </p>
              <button type="button" className="sched-button sched-button-primary" onClick={startNew}>
                <Plus size={13} aria-hidden="true" />
                New task
              </button>
            </div>
          ) : null}

          {status ? (
            <p className="sched-status" role="status">
              {status}
            </p>
          ) : null}
          {actionError ? (
            <p className="sched-alert" role="alert">
              {actionError}
            </p>
          ) : null}

          {loadError ? (
            <p className="sched-alert" role="alert">
              {loadError}
            </p>
          ) : routines === null ? (
            <p className="sched-loading">Loading…</p>
          ) : repositories.length === 0 ? (
            <EmptyState
              headline="No repositories yet"
              body="Scheduled tasks run against a repository. Add one, then come back to put a prompt on a schedule."
            />
          ) : total === 0 ? (
            <EmptyState
              headline="Nothing scheduled"
              body="Put a prompt on a clock and Argmax runs it as a normal agent chat — a morning triage, an hourly check, a one-off at a set time."
              action={
                <button type="button" className="sched-button sched-button-primary" onClick={startNew}>
                  <Plus size={13} aria-hidden="true" />
                  New task
                </button>
              }
            />
          ) : (
            <ul className="sched-list" aria-label="Scheduled tasks">
              {routines.map((routine) => {
                const state = routineState(routine);
                return (
                  <li key={routine.id} className="sched-row" data-state={state}>
                    <span className="sched-marker" aria-hidden="true" />

                    <div className="sched-row-body">
                      <span className="sched-row-name">{routine.name}</span>
                      <span className="sched-row-meta">
                        {projectName(routine.projectId)}
                        <span className="sched-dot" aria-hidden="true" />
                        {PROVIDER_DISPLAY_NAMES[routine.provider]} {routine.modelLabel}
                      </span>
                    </div>

                    <div className="sched-row-when">
                      <span className="sched-row-cadence">{describeSchedule(routine)}</span>
                      <span className="sched-row-next">
                        {state === "failed" ? (
                          <span className="sched-row-failed" title={routine.lastError ?? undefined}>
                            Last run failed
                          </span>
                        ) : state === "paused" ? (
                          "Paused"
                        ) : routine.nextRunAt ? (
                          <span title={formatTimestamp(routine.nextRunAt)}>
                            {formatRelative(routine.nextRunAt)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </span>
                    </div>

                    <div className="sched-row-actions">
                      <button
                        type="button"
                        className="sched-icon-button"
                        title={`Run ${routine.name} now`}
                        aria-label={`Run ${routine.name} now`}
                        disabled={busy}
                        onClick={() => void runNow(routine)}
                      >
                        <Play size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="sched-icon-button"
                        title={`Edit ${routine.name}`}
                        aria-label={`Edit ${routine.name}`}
                        onClick={() => startEdit(routine)}
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="sched-icon-button sched-icon-button-danger"
                        title={`Delete ${routine.name}`}
                        aria-label={`Delete ${routine.name}`}
                        disabled={busy}
                        onClick={() => void removeRoutine(routine)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                      <label className="settings-toggle sched-row-toggle">
                        <input
                          type="checkbox"
                          aria-label={routine.enabled ? `Pause ${routine.name}` : `Resume ${routine.name}`}
                          checked={routine.enabled}
                          onChange={() => void toggleEnabled(routine)}
                        />
                        <span className="settings-toggle-track" aria-hidden="true">
                          <span className="settings-toggle-thumb" />
                        </span>
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
    </SchedulePage>
  );
}

function SchedulePage({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="settings-page">
      <div className="settings-topbar" data-window-drag />
      <div className="settings-main">
        <h1 className="settings-page-title">Schedule</h1>
        {children}
      </div>
    </div>
  );
}

function EmptyState({
  headline,
  body,
  action
}: {
  headline: string;
  body: string;
  action?: JSX.Element;
}): JSX.Element {
  return (
    <div className="sched-empty">
      <p className="sched-empty-headline">{headline}</p>
      <p className="sched-empty-body">{body}</p>
      {action ? <div className="sched-empty-action">{action}</div> : null}
    </div>
  );
}

function ScheduledTaskEditor({
  draft,
  setDraft,
  projects,
  modelOptions,
  saveError,
  busy,
  onSave,
  onCancel
}: {
  draft: DraftState;
  setDraft: Dispatch<SetStateAction<DraftState | null>>;
  projects: ProjectSummary[];
  modelOptions: ReadonlyArray<{ value: string; label: string }>;
  saveError: string | null;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  // The minute field keeps its own draft string so backspacing to empty does
  // not snap the control back to "0" mid-edit; blur commits the clamped value.
  const [minuteDraft, setMinuteDraft] = useState<string | null>(null);

  const patch = (changes: Partial<DraftState>): void => {
    setDraft((current) => (current ? { ...current, ...changes } : current));
  };

  const patchControls = (changes: Partial<ScheduleControls>): void => {
    patch({ controls: { ...draft.controls, ...changes } });
  };

  const commitMinute = (raw: string): void => {
    const parsed = Number.parseInt(raw, 10);
    patchControls({ minute: Number.isNaN(parsed) ? 0 : Math.min(59, Math.max(0, parsed)) });
    setMinuteDraft(null);
  };

  const timeValue = `${pad2(draft.controls.hour)}:${pad2(draft.controls.minute)}`;
  const cadence = describeCadence(draft.kind, draft.controls);
  const repositoryName = projects.find((project) => project.id === draft.projectId)?.name;

  return (
    <form
      className="sched-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
          <section className="sched-group">
            <div className="sched-field">
              <label className="sched-label" htmlFor="scheduled-name">
                Name
              </label>
              <input
                id="scheduled-name"
                className="sched-input"
                value={draft.name}
                placeholder="Morning board triage"
                autoComplete="off"
                onChange={(event) => patch({ name: event.target.value })}
              />
            </div>

            <div className="sched-field">
              <label className="sched-label" htmlFor="scheduled-prompt">
                Prompt
              </label>
              <textarea
                id="scheduled-prompt"
                className="sched-input sched-textarea"
                rows={4}
                value={draft.prompt}
                placeholder="Triage the priority column, summarize blockers, and open follow-up chats for anything urgent."
                onChange={(event) => patch({ prompt: event.target.value })}
              />
            </div>
          </section>

          <section className="sched-group">
            <p className="sched-eyebrow">When</p>

            <div className="sched-field sched-field-inline">
              <span className="sched-label">Repeats</span>
              <div className="sched-picker">
                <SettingsListPicker
                  ariaLabel="Repeats"
                  value={draft.kind}
                  onChange={(kind) => patch({ kind })}
                  options={SCHEDULE_KIND_OPTIONS}
                />
              </div>
            </div>

            {draft.kind === "once" ? (
              <div className="sched-field sched-field-inline">
                <label className="sched-label" htmlFor="scheduled-once">
                  Run at
                </label>
                <input
                  id="scheduled-once"
                  type="datetime-local"
                  className="sched-input sched-input-compact"
                  value={draft.controls.onceAt}
                  onChange={(event) => patchControls({ onceAt: event.target.value })}
                />
              </div>
            ) : null}
            {draft.kind === "hourly" ? (
              <div className="sched-field sched-field-inline">
                <label className="sched-label" htmlFor="scheduled-hourly-minute">
                  Minute
                </label>
                <input
                  id="scheduled-hourly-minute"
                  type="number"
                  min={0}
                  max={59}
                  className="sched-input sched-input-number"
                  value={minuteDraft ?? String(draft.controls.minute)}
                  onChange={(event) => setMinuteDraft(event.target.value)}
                  onBlur={(event) => commitMinute(event.target.value)}
                  // Enter here would submit the form before blur commits the
                  // draft, saving the previous minute. Commit instead.
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    commitMinute(event.currentTarget.value);
                  }}
                />
              </div>
            ) : null}
            {draft.kind === "daily" || draft.kind === "weekly" ? (
              <div className="sched-field sched-field-inline">
                <label className="sched-label" htmlFor="scheduled-time">
                  Time
                </label>
                <input
                  id="scheduled-time"
                  type="time"
                  className="sched-input sched-input-compact"
                  value={timeValue}
                  onChange={(event) => {
                    const [hour, minute] = event.target.value.split(":").map(Number);
                    patchControls({
                      hour: Number.isInteger(hour) ? hour : draft.controls.hour,
                      minute: Number.isInteger(minute) ? minute : draft.controls.minute
                    });
                  }}
                />
              </div>
            ) : null}
            {draft.kind === "weekly" ? (
              <div className="sched-field sched-field-inline">
                <span className="sched-label">Day</span>
                <div className="sched-picker">
                  <SettingsListPicker
                    ariaLabel="Day"
                    value={String(draft.controls.weekday)}
                    onChange={(weekday) => patchControls({ weekday: Number(weekday) })}
                    options={WEEKDAY_PICKER_OPTIONS}
                  />
                </div>
              </div>
            ) : null}
            {draft.kind === "custom" ? (
              <div className="sched-field">
                <label className="sched-label" htmlFor="scheduled-cron">
                  Cron expression
                </label>
                <input
                  id="scheduled-cron"
                  className="sched-input sched-input-mono"
                  value={draft.controls.custom}
                  placeholder="0 30 8 * * 1-5"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => patchControls({ custom: event.target.value })}
                />
                <p className="sched-help">
                  Six fields — second minute hour day month weekday. <code>0 30 8 * * 1-5</code> is
                  weekdays at 08:30.
                </p>
              </div>
            ) : null}

            {/* The schedule read back as a sentence: six cron fields never have
                to be decoded by eye, and the sentence is what the row will say. */}
            <p className="sched-readback">
              {cadence ? (
                <>
                  Runs <strong>{cadence}</strong>
                  {repositoryName ? <> in {repositoryName}</> : null}.
                </>
              ) : (
                <span className="sched-readback-empty">
                  {draft.kind === "custom"
                    ? "Runs on your cron expression."
                    : "Pick a time to finish the schedule."}
                </span>
              )}
            </p>
          </section>

          <section className="sched-group">
            <p className="sched-eyebrow">Where</p>

            <div className="sched-field sched-field-inline">
              <span className="sched-label">Repository</span>
              <div className="sched-picker">
                <SettingsListPicker
                  ariaLabel="Repository"
                  value={draft.projectId}
                  onChange={(projectId) => patch({ projectId })}
                  options={projects.map((project) => ({ value: project.id, label: project.name }))}
                />
              </div>
            </div>
            <div className="sched-field sched-field-inline">
              <span className="sched-label">Agent</span>
              <div className="sched-picker">
                <SettingsListPicker
                  ariaLabel="Agent"
                  value={draft.provider}
                  onChange={(provider) => {
                    const known = PROVIDER_MODELS[provider].some(
                      (model) => model.modelId === draft.modelId
                    );
                    patch({
                      provider,
                      modelId: known ? draft.modelId : PROVIDER_MODEL_DEFAULTS[provider].modelId
                    });
                  }}
                  options={(Object.keys(PROVIDER_MODELS) as ProviderId[]).map((provider) => ({
                    value: provider,
                    label: PROVIDER_DISPLAY_NAMES[provider]
                  }))}
                />
              </div>
            </div>
            <div className="sched-field sched-field-inline">
              <span className="sched-label">Model</span>
              <div className="sched-picker">
                <SettingsListPicker
                  ariaLabel="Model"
                  value={draft.modelId}
                  onChange={(modelId) => patch({ modelId })}
                  options={modelOptions}
                />
              </div>
            </div>

            <div className="sched-field sched-field-inline">
              <span className="sched-label">Run in</span>
              <div className="sched-picker">
                <SettingsListPicker
                  ariaLabel="Run in"
                  value={draft.worktree ? "worktree" : "checkout"}
                  onChange={(target) => patch({ worktree: target === "worktree" })}
                  options={WORKTREE_OPTIONS}
                  placement="above"
                />
              </div>
            </div>
          </section>

          {saveError ? (
            <p className="sched-alert" role="alert">
              {saveError}
            </p>
          ) : null}

          <footer className="sched-actions">
            <p className="sched-actions-note">Scheduled runs are unattended and auto-approve.</p>
            <div className="sched-actions-buttons">
              <button type="button" className="sched-button" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="sched-button sched-button-primary" disabled={busy}>
                {draft.routineId ? "Save changes" : "Create task"}
              </button>
            </div>
          </footer>
    </form>
  );
}
