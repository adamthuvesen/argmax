import * as decode from "./bridgeDecoders.js";
import type { PushPayloads } from "../../shared/bindings.js";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { IpcChannel, IpcArguments, IpcOutput } from "../../shared/ipcSchemas.js";
import type {
  ActivitySummaryInput,
  ArgmaxApi,
  AttachmentSaveImageInput,
  BrowserAgentOpenEvent,
  BrowserNewTabEvent,
  BrowserPageCommandEvent,
  BrowserStateEvent,
  BrowserTabInfo,
  CloudLaunchInput,
  CloudPrepareInput,
  DashboardDelta,
  GitCommitInput,
  GitCreateBranchInput,
  GitPushInput,
  GitViewOrCreatePrInput,
  LaunchProviderSessionInput,
  OpenInIdeInput,
  ProviderSessionInput,
  ProviderSessionResizeInput,
  ProvidersCancelQueuedMessageInput,
  ProvidersSendQueuedMessageNowInput,
  QuestionsResolveInput,
  RegisterProjectInput,
  RemoveProjectInput,
  ResolveApprovalInput,
  ReviewComparison,
  RoutineUpsertInput,
  UsageRouterCostInput,
  UsageSummaryInput,
  RunCheckInput,
  SessionAgentEventsInput,
  SessionClearInput,
  SessionForkInput,
  SessionForkLineageInput,
  SessionForkMergeInput,
  SessionForkMergePreviewInput,
  SessionCostSummaryInput,
  SessionEventsSinceInput,
  EventSubscription,
  TerminalAgentOpenEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeInput,
  TerminalSpawnInput,
  TerminalWriteInput,
  UpdateProjectSettingsInput,
  WorkspaceStatusInput,
  WorkspaceTarget,
  WorkspacesMarkViewedInput
} from "../../shared/types.js";
import { isSecondaryWindow, windowLabelFromRuntime } from "./windowRole.js";
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";
import { createWsTransport } from "./wsTransport.js";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}


export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

/**
 * The two primitives every `window.argmax` method is built from. Tauri IPC is
 * one implementation; the remote WebSocket bridge in `wsTransport.ts` is the
 * other, so the same renderer API object serves both runtimes.
 */
export interface BridgeTransport {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArguments<C>): Promise<IpcOutput<C>>;
  subscribe<C extends keyof PushPayloads>(channel: C, listener: (payload: PushPayloads[C]) => void): EventSubscription;
}

function invokeThroughTauri<C extends IpcChannel>(channel: C, ...args: IpcArguments<C>): Promise<IpcOutput<C>> {
  return tauriInvoke<IpcOutput<C>>(channel, { input: args[0] ?? {} });
}

/**
 * Whether this window may show the native browser surface. The browser's
 * tabs are child webviews of the main window and its registry is one per
 * process (docs/browser.md), so a chat torn off into its own window must not
 * offer Browser: its `browser:set-bounds` would drag the main window's tab to
 * wherever this window's panel happens to be. Outside Tauri there is one
 * window, and the bridge's own presence decides.
 */
export function hostsBrowserSurface(): boolean {
  if (typeof window === "undefined" || !window.argmax?.browser) return false;
  return !isSecondaryWindow();
}

function subscribeThroughTauri<C extends keyof PushPayloads>(channel: C, listener: (payload: PushPayloads[C]) => void): EventSubscription {
  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  let unlistenQueued = false;

  const queueUnlisten = (nextUnlisten: UnlistenFn): void => {
    if (unlistenQueued) return;
    unlistenQueued = true;

    // Tauri queues its listener-install script into the webview before the
    // listen invoke resolves. Let that queued script run before unlistening,
    // otherwise a same-turn React cleanup can target an event id that is not
    // present in the webview yet.
    setTimeout(() => {
      void Promise.resolve()
        .then(nextUnlisten)
        .catch((error: unknown) => {
          logger.error("renderer.bridge", "failed to unsubscribe from channel", {
            channel,
            error: errorMessage(error)
          });
        });
    }, 0);
  };

  // Listen as this window, not as "any target": a listener registered with
  // the default `Any` target receives every `emit_to(label, …)` whatever the
  // label (tauri `event/listener.rs`, `emit_filter`), so a menu command sent
  // to the focused window would toggle the sidebar in every open window.
  // Broadcasts (`app.emit`) still reach a labelled listener.
  const label = windowLabelFromRuntime();
  const ready = tauriListen<PushPayloads[C]>(
    channel,
    (event) => {
      if (!disposed) listener(event.payload);
    },
    label ? { target: label } : undefined
  ).then((nextUnlisten) => {
    if (disposed) {
      queueUnlisten(nextUnlisten);
      return;
    }
    unlisten = nextUnlisten;
  });
  ready.catch((error: unknown) => {
    logger.error("renderer.bridge", "failed to subscribe to channel", {
      channel,
      error: errorMessage(error)
    });
  });

  const off = (): void => {
    if (disposed) return;
    disposed = true;
    if (unlisten) queueUnlisten(unlisten);
    unlisten = null;
  };
  const readyForConsumers = ready.then(() => undefined);
  readyForConsumers.catch(() => undefined);
  off.ready = readyForConsumers;
  return off;
}

const tauriTransport: BridgeTransport = {
  invoke: invokeThroughTauri,
  subscribe: subscribeThroughTauri
};

// Diagnostic for the "stream freezes, then everything bursts at once"
// symptom. A burst has two possible stalls with identical end states:
// deltas ARRIVING late in a clump (backend delivery parked — see the
// matching Rust-side warn in lib.rs), or arriving on time but APPLYING
// late (this JS thread was blocked). Logging arrival gaps here separates
// the two: a silence-then-clump in these warnings means delivery; smooth
// arrivals during a visibly frozen UI mean a renderer stall.
const BURST_SILENCE_MS = 3000;
const BURST_WINDOW_MS = 1000;
const BURST_MIN_DELTAS = 8;
let lastDeltaAt: number | undefined;
let burstSilenceMs = 0;
let burstStartedAt: number | undefined;
let burstCount = 0;
function trackDeltaArrival(): void {
  const now = performance.now();
  const gap = lastDeltaAt === undefined ? 0 : now - lastDeltaAt;
  lastDeltaAt = now;
  if (gap > BURST_SILENCE_MS) {
    burstSilenceMs = gap;
    burstStartedAt = now;
    burstCount = 1;
    return;
  }
  if (burstStartedAt === undefined) return;
  if (now - burstStartedAt > BURST_WINDOW_MS) {
    burstStartedAt = undefined;
    return;
  }
  burstCount += 1;
  if (burstCount === BURST_MIN_DELTAS) {
    console.warn(
      `[argmax] dashboard:delta burst: ${BURST_MIN_DELTAS}+ deltas within ` +
        `${Math.round(now - burstStartedAt)}ms after ${Math.round(burstSilenceMs)}ms of silence — ` +
        "delivery stalled upstream of the renderer"
    );
  }
}

function createArgmaxApi(transport: BridgeTransport): ArgmaxApi {
  const invokeCommand = transport.invoke.bind(transport);
  const subscribe = transport.subscribe.bind(transport);

  // One transport subscription fans out to every consumer, so the burst
  // diagnostic counts deltas rather than deliveries. Counting inside the
  // per-listener wrapper made the threshold depend on how many panes happened
  // to be mounted: with the dashboard hook and the file preview both listening
  // it tripped after four real deltas and reported an upstream delivery stall
  // that had not happened.
  const deltaListeners = new Set<(delta: DashboardDelta) => void>();
  let deltaSubscription: EventSubscription | null = null;
  const onDelta = (listener: (delta: DashboardDelta) => void): EventSubscription => {
    deltaListeners.add(listener);
    const shared =
      deltaSubscription ??
      (deltaSubscription = subscribe("dashboard:delta", (delta) => {
        trackDeltaArrival();
        // Copied: a consumer may unsubscribe from inside its own handler.
        const decoded = decode.delta(delta);
        for (const each of [...deltaListeners]) each(decoded);
      }));
    const off = (): void => {
      if (!deltaListeners.delete(listener)) return;
      if (deltaListeners.size === 0 && deltaSubscription) {
        deltaSubscription();
        deltaSubscription = null;
      }
    };
    if (shared.ready) off.ready = shared.ready;
    return off;
  };

  return {
    markWorkspacesViewed: (input: WorkspacesMarkViewedInput) =>
      invokeCommand("workspaces:mark-viewed", input).then(rows => rows.map(decode.workspace)),
    dashboard: {
      list: () => invokeCommand("dashboard:list").then(decode.dashboard),
      onDelta
    },
    projects: {
      list: () => invokeCommand("projects:list"),
      pickFolder: () => invokeCommand("projects:pick-folder").then(decode.pickedFolder),
      register: (input: RegisterProjectInput) => invokeCommand("projects:register", input),
      remove: (input: RemoveProjectInput) => invokeCommand("projects:remove", input).then(() => undefined),
      updateSettings: (input: UpdateProjectSettingsInput) =>
        invokeCommand("projects:update-settings", input),
      listBranches: (projectId: string) =>
        invokeCommand("projects:list-branches", { projectId }),
      listCheckouts: (projectId: string) =>
        invokeCommand("projects:list-checkouts", { projectId }),
      refreshBranch: (projectId: string) =>
        invokeCommand("projects:refresh-branch", { projectId }),
      switchBranch: (projectId: string, branch: string) =>
        invokeCommand("projects:switch-branch", { projectId, branch }),
      setBranchTemplate: (input) => invokeCommand("projects:set-branch-template", input),
      checkPrompt: (input) => invokeCommand("projects:check-prompt", input),
      resolveCheck: (input) => invokeCommand("projects:resolve-check", input).then(() => undefined)
    },
    workspaces: {
      createIsolated: (input) => invokeCommand("workspaces:create-isolated", input).then(decode.workspace),
      createCurrent: (input) => invokeCommand("workspaces:create-current", input).then(decode.workspace),
      createAlongside: (input) => invokeCommand("workspaces:create-alongside", input).then(decode.workspace),
      createScratch: (input) => invokeCommand("workspaces:create-scratch", input).then(decode.workspace),
      refreshStatus: (workspaceId) =>
        invokeCommand("workspaces:refresh-status", { workspaceId }).then(decode.workspace),
      status: (input: WorkspaceStatusInput = { workspaceIds: null }) =>
        invokeCommand("workspace:status", input).then(decode.workspaceStatus),
      keep: (workspaceId) => invokeCommand("workspaces:keep", { workspaceId }).then(decode.workspace),
      archive: (input) => invokeCommand("workspaces:archive", input).then(row => ({ ...row, workspace: decode.workspace(row.workspace) })),
      openInIde: (input: OpenInIdeInput) => invokeCommand("workspaces:open-in-ide", input),
      autoTitle: (input) => invokeCommand("workspaces:autotitle", input),
      setPinned: (input) => invokeCommand("workspaces:set-pinned", input).then(decode.workspace),
      setPriorityDismissed: (input) =>
        invokeCommand("workspaces:set-priority-dismissed", input).then(decode.workspace),
      setPriorityAdded: (input) =>
        invokeCommand("workspaces:set-priority-added", input).then(decode.workspace),
      setSnoozedUntil: (input) =>
        invokeCommand("workspaces:set-snoozed-until", input).then(decode.workspace),
      setLabel: (input) => invokeCommand("workspaces:set-label", input).then(decode.workspace),
      setIcon: (input) => invokeCommand("workspaces:set-icon", input).then(decode.workspace)
    },
    providers: {
      discover: (refresh = false) =>
        invokeCommand("providers:discover", { refresh }),
      launch: (input: LaunchProviderSessionInput) => invokeCommand("providers:launch", input).then(decode.session),
      sendInput: (input: ProviderSessionInput) =>
        invokeCommand("providers:send-input", input),
      steerInput: (input: ProviderSessionInput) =>
        invokeCommand("providers:steer-input", input),
      resize: (input: ProviderSessionResizeInput) => invokeCommand("providers:resize", input),
      terminate: (sessionId: string) => invokeCommand("providers:terminate", { sessionId }),
      cancelQueuedMessage: (input: ProvidersCancelQueuedMessageInput) =>
        invokeCommand("providers:cancel-queued-message", input),
      sendQueuedMessageNow: (input: ProvidersSendQueuedMessageNowInput) =>
        invokeCommand("providers:send-queued-message-now", input)
    },
    cloud: {
      prepare: (input: CloudPrepareInput) =>
        invokeCommand("cloud:prepare", input),
      launch: (input: CloudLaunchInput) =>
        invokeCommand("cloud:launch", input)
    },
    attachments: {
      saveImage: (input: AttachmentSaveImageInput) =>
        invokeCommand("attachments:save-image", input)
    },
    approvals: {
      pending: () => invokeCommand("approvals:pending").then(rows => rows.map(decode.approval)),
      resolve: (input: ResolveApprovalInput) =>
        invokeCommand("approvals:resolve", input).then(decode.approval)
    },
    questions: {
      resolve: (input: QuestionsResolveInput) =>
        invokeCommand("questions:resolve", input)
    },
    session: {
      eventsSince: (input: SessionEventsSinceInput) =>
        invokeCommand("session:events-since", input).then(decode.transcript),
      agentEvents: (input: SessionAgentEventsInput) =>
        invokeCommand("session:agent-events", input).then(decode.transcript),
      fork: (input: SessionForkInput) =>
        invokeCommand("session:fork", {
          ...input,
          boundaryEventId: input.boundaryEventId ?? null,
          workspace: input.workspace ?? null
        }).then((forked) => ({
          ...forked,
          workspace: decode.workspace(forked.workspace),
          session: decode.session(forked.session)
        })),
      forkLineage: (input: SessionForkLineageInput) =>
        invokeCommand("session:fork-lineage", input),
      forkMergePreview: (input: SessionForkMergePreviewInput) =>
        invokeCommand("session:fork-merge-preview", input),
      forkMerge: (input: SessionForkMergeInput) => invokeCommand("session:fork-merge", input),
      multitask: (input) =>
        invokeCommand("session:multitask", {
          ...input,
          pendingMessageId: input.pendingMessageId ?? null,
          worktree: input.worktree ?? false,
          taskLabel: input.taskLabel ?? null
        }),
      clear: (input: SessionClearInput) => invokeCommand("session:clear", input).then(decode.session),
      suggestFollowUp: (input) =>
        invokeCommand("session:suggest-follow-up", input),
      costSummary: (input: SessionCostSummaryInput) =>
        invokeCommand("session:cost-summary", input),
      search: (input) => invokeCommand("session:search", input)
    },
    goals: {
      set: (input) => invokeCommand("goal:set", input),
      get: (input) => invokeCommand("goal:get", input),
      list: (input) => invokeCommand("goal:list", input),
      clear: (input) => invokeCommand("goal:clear", input),
    },
    arcs: {
      create: (input) => invokeCommand("arc:create", input),
      list: (input) => invokeCommand("arc:list", input),
      get: (input) => invokeCommand("arc:get", input),
      update: (input) => invokeCommand("arc:update", input),
      setState: (input) => invokeCommand("arc:set-state", input),
      launchCoordinator: (input) => invokeCommand("arc:launch-coordinator", input),
      timeline: (input) => invokeCommand("arc:timeline", input),
      draftFromSession: (input) => invokeCommand("arc:draft-from-session", input),
      promote: (input) => invokeCommand("arc:promote", input)
    },
    review: {
      stageFile: (input) => invokeCommand("review:stage-file", input).then(() => undefined),
      unstageFile: (input) => invokeCommand("review:unstage-file", input).then(() => undefined),
      revertFile: (input) => invokeCommand("review:revert-file", input).then(() => undefined),
      revertHunk: (input) => invokeCommand("review:revert-hunk", input).then(() => undefined),
      stageHunk: (input) => invokeCommand("review:stage-hunk", input).then(() => undefined),
      unstageHunk: (input) => invokeCommand("review:unstage-hunk", input).then(() => undefined),
      commitStaged: (input) => invokeCommand("review:commit-staged", input),
      listChangedFiles: (target: WorkspaceTarget, comparison?: ReviewComparison) =>
        invokeCommand("review:list-changed-files", { ...target, comparison }),
      loadDiff: (
        target: WorkspaceTarget,
        filePath?: string,
        comparison?: ReviewComparison,
        contextLines?: number
      ) =>
        invokeCommand("review:load-diff", {
          ...target,
          filePath,
          comparison,
          contextLines
        })
    },
    workspace: {
      listFiles: (target: WorkspaceTarget) =>
        invokeCommand("workspace:list-files", target),
      readFile: (target: WorkspaceTarget, filePath: string) =>
        invokeCommand("workspace:read-file", { ...target, filePath }),
      writeFile: (target: WorkspaceTarget, filePath: string, content: string, expectedMtimeMs: number | null) =>
        invokeCommand("workspace:write-file", {
          ...target,
          filePath,
          content,
          expectedMtimeMs
        }),
      statFile: (target: WorkspaceTarget, filePath: string) =>
        invokeCommand("workspace:stat-file", { ...target, filePath }),
      readExternalFile: (path: string) =>
        invokeCommand("workspace:read-external-file", { path }),
      statExternalFile: (path: string) =>
        invokeCommand("workspace:stat-external-file", { path }),
      grepContent: (input) => invokeCommand("workspace:grep-content", input)
    },
    checks: {
      run: (input: RunCheckInput) => invokeCommand("checks:run", input).then(decode.check)
    },
    checkpoints: {
      list: (input) => invokeCommand("checkpoints:list", input),
      previewRewind: (input) => invokeCommand("checkpoints:preview-rewind", input),
      rewindFiles: (input) => invokeCommand("checkpoints:rewind-files", input)
    },
    health: {
      ping: () => invokeCommand("health:ping")
    },
    skills: {
      list: (input) => invokeCommand("skills:list", input)
    },
    connections: {
      list: (input) => invokeCommand("connections:list", input)
    },
    settings: {
      agentTools: () => invokeCommand("settings:agent-tools"),
      routing: () => invokeCommand("settings:routing"),
      setRoutingKey: (input) => invokeCommand("settings:set-routing-key", input),
      clearRoutingKey: () => invokeCommand("settings:clear-routing-key"),
      setProjectCheck: (input) => invokeCommand("settings:set-project-check", input),
      branchTemplate: () => invokeCommand("settings:branch-template"),
      setBranchTemplate: (input) => invokeCommand("settings:set-branch-template", input),
      setBrowserTools: (input) =>
        invokeCommand("settings:set-browser-tools", input),
      previewChatCleanup: () => invokeCommand("settings:preview-chat-cleanup"),
      deleteOldChats: (input) => invokeCommand("settings:delete-old-chats", input)
    },
    system: {
      confirm: (message) => isTauriRuntime()
        ? confirmDialog(message, { title: "Argmax", kind: "warning" })
        : Promise.resolve(window.confirm(message)),
      openPath: (input) => invokeCommand("system:open-path", input),
      openFileIn: (input) => invokeCommand("system:open-file-in", input),
      listDetectedIdes: () => invokeCommand("system:list-detected-ides"),
      diagnostics: () => invokeCommand("system:diagnostics"),
      debugSnapshot: (input) =>
        invokeCommand("system:debug-snapshot", { afterLogSeq: input?.afterLogSeq ?? null }),
      performanceStart: () => invokeCommand("system:performance-start"),
      performanceStop: () => invokeCommand("system:performance-stop"),
      performanceStatus: () => invokeCommand("system:performance-status"),
      performanceCapture: () => invokeCommand("system:performance-capture"),
      reportRendererStall: (durationMs) =>
        invokeCommand("system:renderer-stall", { durationMs }),
      onZoom: (listener) => subscribe("ui:zoom", listener),
      vacuumDatabase: () => invokeCommand("system:vacuum-database"),
      setTheme: (mode) => invokeCommand("system:set-theme", { mode }),
      setDefaultAgent: (input) =>
        invokeCommand("system:set-default-agent", {
          ...input,
          reasoningEffort: input.reasoningEffort ?? null
        }),
      setNotificationsEnabled: (enabled) =>
        invokeCommand("system:set-notifications-enabled", { enabled }),
      setKeepAwake: (enabled) => invokeCommand("system:set-keep-awake", { enabled }),
      testNotification: () => invokeCommand("system:test-notification")
    },
    remote: {
      getStatus: () => invokeCommand("remote:get-status"),
      setConfig: (input) => invokeCommand("remote:set-config", input),
      testNotification: () => invokeCommand("remote:test-notification"),
      setApnsConfig: (input) => invokeCommand("remote:set-apns-config", input),
      registerPushDevice: (input) =>
        invokeCommand("remote:register-push-device", input),
      unregisterPushDevice: (input) =>
        invokeCommand("remote:unregister-push-device", input),
      pushTest: () => invokeCommand("remote:push-test"),
      pushCapability: () => invokeCommand("remote:push-capability")
    },
    sync: {
      getStatus: () => invokeCommand("sync:get-status").then(decode.syncStatus),
      setConfig: (input) => invokeCommand("sync:set-config", input).then(decode.syncStatus),
      runNow: () => invokeCommand("sync:run-now").then(decode.syncStatus)
    },
    routines: {
      list: () => invokeCommand("routines:list").then(rows => rows.map(decode.routine)),
      upsert: (input: RoutineUpsertInput) => invokeCommand("routines:upsert", input).then(decode.routine),
      delete: (id: string) => invokeCommand("routines:delete", { id }),
      setEnabled: (id: string, enabled: boolean) =>
        invokeCommand("routines:set-enabled", { id, enabled }).then(decode.routine),
      runNow: (id: string) => invokeCommand("routines:run-now", { id }).then(decode.routine),
      resetSession: (id: string) => invokeCommand("routines:reset-session", { id }).then(decode.routine)
    },
    usage: {
      summary: (input: UsageSummaryInput) => invokeCommand("usage:summary", input),
      remaining: () => invokeCommand("usage:remaining"),
      routerCost: (input: UsageRouterCostInput) =>
        invokeCommand("usage:router-cost", input)
    },
    activity: {
      summary: (input: ActivitySummaryInput) => invokeCommand("activity:summary", input)
    },
    menu: {
      onCommand: (listener) => subscribe("menu:command", listener)
    },
    windowSnapshot: {
      status: () => invokeCommand("window-snapshot:status"),
      configure: (input) => invokeCommand("window-snapshot:configure", input),
      requestPermission: () => invokeCommand("window-snapshot:request-permission"),
      onAttach: (listener) => subscribe("composer:attach-window-snapshot", listener),
      onFailed: (listener) => subscribe("window-snapshot:failed", listener)
    },
    windows: {
      onFocusSession: (listener) => subscribe("window:focus-session", listener),
      openSession: (input) => invokeCommand("window:open-session", input),
      setSession: (input) => invokeCommand("window:set-session", input)
    },
    linkedRepos: {
      list: (input) => invokeCommand("linked-repos:list", input),
      add: (input) => invokeCommand("linked-repos:add", input),
      pickFolder: (input) => invokeCommand("linked-repos:pick-folder", input),
      summarize: (input) => invokeCommand("linked-repos:summarize", input),
      setEnabled: (input) => invokeCommand("linked-repos:set-enabled", input),
      remove: (input) => invokeCommand("linked-repos:remove", input).then(() => undefined)
    },
    sources: {
      list: (input) => invokeCommand("sources:list", input),
      add: (input) => invokeCommand("sources:add", input),
      update: (input) => invokeCommand("sources:update", input),
      delete: (input) => invokeCommand("sources:delete", input).then(() => undefined)
    },
    learnings: {
      list: (input) => invokeCommand("learnings:list", input).then(rows => rows.map(decode.learning)),
      update: (input) => invokeCommand("learnings:update", input).then(decode.learning),
      delete: (id: string) => invokeCommand("learnings:delete", { id })
    },
    prs: {
      listForSession: (input) => invokeCommand("prs:list-for-session", input).then(rows => rows.map(decode.pullRequest)),
      refresh: (input) => invokeCommand("prs:refresh", input).then(rows => rows.map(decode.pullRequest)),
      setPrimary: (input) => invokeCommand("prs:set-primary", input),
      dismiss: (input) => invokeCommand("prs:dismiss", input),
      cleanup: (input) => invokeCommand("prs:cleanup", input)
    },
    git: {
      commit: (input: GitCommitInput) => invokeCommand("git:commit", input),
      push: (input: GitPushInput) => invokeCommand("git:push", input),
      createBranch: (input: GitCreateBranchInput) =>
        invokeCommand("git:create-branch", input),
      viewOrCreatePr: (input: GitViewOrCreatePrInput) =>
        invokeCommand("git:view-or-create-pr", input)
    },
    terminal: {
      spawn: (input: TerminalSpawnInput) => invokeCommand("terminal:spawn", input),
      write: (input: TerminalWriteInput) => invokeCommand("terminal:write", input),
      resize: (input: TerminalResizeInput) => invokeCommand("terminal:resize", input),
      terminate: (terminalId: string) => invokeCommand("terminal:terminate", { terminalId }),
      onData: (listener: (event: TerminalDataEvent) => void) =>
        subscribe("terminal:data", listener),
      onExit: (listener: (event: TerminalExitEvent) => void) =>
        subscribe("terminal:exit", listener),
      onAgentOpen: (listener: (event: TerminalAgentOpenEvent) => void) =>
        subscribe("terminal:agent-open", listener)
    },
    browser: {
      chromeProfiles: () => invokeCommand("browser:chrome-profiles"),
      importChromeHistory: (profileId: string) =>
        invokeCommand("browser:import-chrome-history", { profileId }),
      contentBlocking: () => invokeCommand("browser:content-blocking"),
      setSiteBlocking: (input) =>
        invokeCommand("browser:set-site-blocking", input),
      open: (input) => invokeCommand("browser:open", input),
      navigate: (url: string, tabId: string) =>
        invokeCommand("browser:navigate", { url, tabId }),
      back: (tabId: string) => invokeCommand("browser:back", { tabId }),
      forward: (tabId: string) => invokeCommand("browser:forward", { tabId }),
      reload: (tabId: string) => invokeCommand("browser:reload", { tabId }),
      stop: (tabId: string) => invokeCommand("browser:stop", { tabId }),
      setTheme: (mode) => invokeCommand("browser:set-theme", { mode }),
      setBounds: (input) => invokeCommand("browser:set-bounds", input),
      focus: (tabId: string) => invokeCommand("browser:focus", { tabId }),
      close: (tabId: string) => invokeCommand("browser:close", { tabId }),
      fillCredentials: (tabId: string) =>
        invokeCommand("browser:fill-credentials", { tabId }),
      screenshot: (input) => invokeCommand("browser:screenshot", input),
      evaluate: (input) => invokeCommand("browser:evaluate", input),
      listTabs: (input) => invokeCommand("browser:list-tabs", input),
      openForSession: (input) => invokeCommand("browser:open-for-session", input),
      snapshot: (input) => invokeCommand("browser:snapshot", input),
      find: (input) => invokeCommand("browser:find", input),
      getText: (input) => invokeCommand("browser:get-text", input),
      extract: (input) => invokeCommand("browser:extract", input).then(decode.pageExtraction),
      act: (input) => invokeCommand("browser:act", input),
      onState: (listener: (event: BrowserStateEvent) => void) =>
        subscribe("browser:state", listener),
      onNewTab: (listener: (event: BrowserNewTabEvent) => void) =>
        subscribe("browser:new-tab", listener),
      onPageCommand: (listener: (event: BrowserPageCommandEvent) => void) =>
        subscribe("browser:page-command", listener),
      onTabs: (listener: (event: { tabs: BrowserTabInfo[] }) => void) =>
        subscribe("browser:tabs", listener),
      onAgentOpen: (listener: (event: BrowserAgentOpenEvent) => void) =>
        subscribe("browser:agent-open", listener)
    }
  };
}

/**
 * Opt-in flag for the remote (browser) bridge. `?remote` in the URL turns it on
 * and is remembered so later loads of the same origin skip the query string.
 */
const REMOTE_BRIDGE_KEY = "argmax.remote";

function remoteBridgeRequested(): boolean {
  // `?demo` forces the bridge-less browser preview even where the mobile
  // entry's inline script has armed the remote flag — the only way to iterate
  // on the mobile UI against the demo snapshot.
  if (new URLSearchParams(window.location.search).has("demo")) {
    return false;
  }
  if (new URLSearchParams(window.location.search).has("remote")) {
    return true;
  }
  return window.localStorage.getItem(REMOTE_BRIDGE_KEY) === "1";
}

let remoteBridgeInstalled = false;

/**
 * True when `window.argmax` speaks to the host over the WebSocket bridge
 * rather than Tauri. A handful of channels are desktop-only
 * (the `desktop` policy in the Rust command catalogue) — opening a path in
 * the host's Finder, saving a pasted image — so the affordances that call them
 * check here instead of firing a request that can only fail.
 */
export function isRemoteBridge(): boolean {
  return remoteBridgeInstalled;
}

export function installTauriBridge(): void {
  if (typeof window === "undefined" || window.argmax) {
    return;
  }
  if (isTauriRuntime()) {
    window.argmax = createArgmaxApi(tauriTransport);
    return;
  }
  if (!remoteBridgeRequested()) {
    // Browser preview and the demo snapshot depend on staying bridge-less.
    return;
  }
  try {
    window.localStorage.setItem(REMOTE_BRIDGE_KEY, "1");
  } catch {
    /* private mode: the flag can't persist, so the next load needs `?remote`
       again. Losing it must not throw out of module evaluation and leave the
       page with no bridge at all. */
  }
  window.argmax = createArgmaxApi(createWsTransport());
  remoteBridgeInstalled = true;
}

installTauriBridge();
