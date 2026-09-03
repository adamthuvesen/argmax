import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { IpcChannel } from "../../shared/ipcSchemas.js";
import type {
  ArgmaxApi,
  AttachmentSaveImageInput,
  BrowserActionOutcome,
  BrowserAgentOpenEvent,
  BrowserEvaluateResult,
  BrowserFillResult,
  BrowserFindResult,
  BrowserNewTabEvent,
  BrowserPageCommandEvent,
  BrowserPageSnapshot,
  BrowserPageExtraction,
  BrowserPageText,
  BrowserScreenshot,
  BrowserStateEvent,
  BrowserTabInfo,
  AttachmentSaveImageResult,
  ChangedFileSummary,
  CheckRun,
  DashboardDelta,
  DashboardListSnapshot,
  DashboardSnapshot,
  DebugSnapshot,
  DetectedIde,
  DiagnosticsReport,
  DiscoveredProvider,
  GhPrRecord,
  GitCommitInput,
  GitCommitResult,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitPushInput,
  GitPushResult,
  GitViewOrCreatePrInput,
  GitViewOrCreatePrResult,
  Learning,
  LaunchProviderSessionInput,
  MenuCommand,
  OpenInIdeInput,
  ProjectFolderPickResult,
  ProjectSummary,
  ProviderSessionInput,
  ProviderSessionResizeInput,
  ProvidersCancelQueuedMessageInput,
  ProvidersSendQueuedMessageNowInput,
  RegisterProjectInput,
  RemoteStatus,
  RemoveProjectInput,
  ResolveApprovalInput,
  ReviewComparison,
  Routine,
  RoutineUpsertInput,
  UsageSummary,
  UsageSummaryInput,
  RunCheckInput,
  SessionAgentEventsInput,
  SessionClearInput,
  SessionForkInput,
  MultitaskLaunched,
  SessionForkResult,
  FollowUpSuggestion,
  SessionCostSummary,
  SessionCostSummaryInput,
  SessionEventsSinceInput,
  SessionEventsSinceResult,
  SessionSummary,
  SkillSummary,
  SyncStatus,
  EventSubscription,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeInput,
  TerminalSpawnInput,
  TerminalWriteInput,
  UpdateProjectSettingsInput,
  WorkspaceContentSearchResult,
  WorkspaceDiff,
  WorkspaceFileEntry,
  WorkspaceFilePreview,
  WorkspaceFileStat,
  WorkspaceFileWriteResult,
  WorkspaceStatusInput,
  WorkspaceTarget,
  WorkspaceStatusSnapshot,
  WorkspaceSummary
} from "../../shared/types.js";
import { errorMessage } from "../../shared/error.js";
import { logger } from "../../shared/logger.js";
import { createWsTransport } from "./wsTransport.js";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

type SessionSearchResult = Array<{
  sessionId: string;
  eventId: string;
  snippet: string;
  rank: number;
}>;

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

/**
 * The two primitives every `window.argmax` method is built from. Tauri IPC is
 * one implementation; the remote WebSocket bridge in `wsTransport.ts` is the
 * other, so the same renderer API object serves both runtimes.
 */
export interface BridgeTransport {
  invoke<T>(channel: IpcChannel, input?: unknown): Promise<T>;
  subscribe<T>(channel: string, listener: (payload: T) => void): EventSubscription;
}

function invokeThroughTauri<T>(channel: IpcChannel, input: unknown = {}): Promise<T> {
  return tauriInvoke<T>(channel, { input });
}

function subscribeThroughTauri<T>(channel: string, listener: (payload: T) => void): EventSubscription {
  let unlisten: UnlistenFn | null = null;
  let disposed = false;

  const ready = tauriListen<T>(channel, (event) => listener(event.payload)).then((nextUnlisten) => {
    if (disposed) {
      nextUnlisten();
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
    disposed = true;
    unlisten?.();
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

export function createArgmaxApi(transport: BridgeTransport): ArgmaxApi {
  const invokeCommand = <T>(channel: IpcChannel, input: unknown = {}): Promise<T> =>
    transport.invoke<T>(channel, input);
  const subscribe = <T>(channel: string, listener: (payload: T) => void): EventSubscription =>
    transport.subscribe<T>(channel, listener);

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
      (deltaSubscription = subscribe<DashboardDelta>("dashboard:delta", (delta) => {
        trackDeltaArrival();
        // Copied: a consumer may unsubscribe from inside its own handler.
        for (const each of [...deltaListeners]) each(delta);
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
    dashboard: {
      list: () => invokeCommand<DashboardListSnapshot>("dashboard:list"),
      onDelta
    },
    projects: {
      list: () => invokeCommand<ProjectSummary[]>("projects:list"),
      pickFolder: () => invokeCommand<ProjectFolderPickResult>("projects:pick-folder"),
      register: (input: RegisterProjectInput) => invokeCommand<ProjectSummary>("projects:register", input),
      remove: (input: RemoveProjectInput) => invokeCommand<void>("projects:remove", input),
      updateSettings: (input: UpdateProjectSettingsInput) =>
        invokeCommand<ProjectSummary>("projects:update-settings", input),
      listBranches: (projectId: string) =>
        invokeCommand<string[]>("projects:list-branches", { projectId }),
      refreshBranch: (projectId: string) =>
        invokeCommand<ProjectSummary>("projects:refresh-branch", { projectId }),
      switchBranch: (projectId: string, branch: string) =>
        invokeCommand<ProjectSummary>("projects:switch-branch", { projectId, branch })
    },
    workspaces: {
      createIsolated: (input) => invokeCommand<WorkspaceSummary>("workspaces:create-isolated", input),
      createCurrent: (input) => invokeCommand<WorkspaceSummary>("workspaces:create-current", input),
      createScratch: (input) => invokeCommand<WorkspaceSummary>("workspaces:create-scratch", input),
      refreshStatus: (workspaceId) =>
        invokeCommand<WorkspaceSummary>("workspaces:refresh-status", { workspaceId }),
      status: (input: WorkspaceStatusInput = { workspaceIds: null }) =>
        invokeCommand<WorkspaceStatusSnapshot>("workspace:status", input),
      keep: (workspaceId) => invokeCommand<WorkspaceSummary>("workspaces:keep", { workspaceId }),
      archive: (input) => invokeCommand<WorkspaceSummary>("workspaces:archive", input),
      openInIde: (input: OpenInIdeInput) => invokeCommand<{ ok: true }>("workspaces:open-in-ide", input),
      autoTitle: (input) => invokeCommand<{ ok: true }>("workspaces:autotitle", input),
      setPinned: (input) => invokeCommand<WorkspaceSummary>("workspaces:set-pinned", input),
      setPriorityDismissed: (input) =>
        invokeCommand<WorkspaceSummary>("workspaces:set-priority-dismissed", input),
      setPriorityAdded: (input) =>
        invokeCommand<WorkspaceSummary>("workspaces:set-priority-added", input),
      setLabel: (input) => invokeCommand<WorkspaceSummary>("workspaces:set-label", input),
      setIcon: (input) => invokeCommand<WorkspaceSummary>("workspaces:set-icon", input)
    },
    providers: {
      discover: (refresh = false) =>
        invokeCommand<DiscoveredProvider[]>("providers:discover", { refresh }),
      launch: (input: LaunchProviderSessionInput) => invokeCommand<SessionSummary>("providers:launch", input),
      sendInput: (input: ProviderSessionInput) =>
        invokeCommand<{ ok: true; queued: boolean }>("providers:send-input", input),
      resize: (input: ProviderSessionResizeInput) => invokeCommand<{ ok: true }>("providers:resize", input),
      terminate: (sessionId: string) => invokeCommand<{ ok: true }>("providers:terminate", { sessionId }),
      cancelQueuedMessage: (input: ProvidersCancelQueuedMessageInput) =>
        invokeCommand<{ ok: true }>("providers:cancel-queued-message", input),
      sendQueuedMessageNow: (input: ProvidersSendQueuedMessageNowInput) =>
        invokeCommand<{ ok: true; queued: boolean }>("providers:send-queued-message-now", input)
    },
    attachments: {
      saveImage: (input: AttachmentSaveImageInput) =>
        invokeCommand<AttachmentSaveImageResult>("attachments:save-image", input)
    },
    approvals: {
      pending: () => invokeCommand<DashboardSnapshot["approvals"]>("approvals:pending"),
      resolve: (input: ResolveApprovalInput) =>
        invokeCommand<DashboardSnapshot["approvals"][number]>("approvals:resolve", input)
    },
    session: {
      eventsSince: (input: SessionEventsSinceInput) =>
        invokeCommand<SessionEventsSinceResult>("session:events-since", input),
      agentEvents: (input: SessionAgentEventsInput) =>
        invokeCommand<SessionEventsSinceResult>("session:agent-events", input),
      fork: (input: SessionForkInput) => invokeCommand<SessionForkResult>("session:fork", input),
      multitask: (input) =>
        invokeCommand<MultitaskLaunched>("session:multitask", {
          ...input,
          worktree: input.worktree ?? false,
          taskLabel: input.taskLabel ?? null
        }),
      clear: (input: SessionClearInput) => invokeCommand<SessionSummary>("session:clear", input),
      suggestFollowUp: (input) =>
        invokeCommand<FollowUpSuggestion>("session:suggest-follow-up", input),
      costSummary: (input: SessionCostSummaryInput) =>
        invokeCommand<SessionCostSummary>("session:cost-summary", input),
      search: (input) => invokeCommand<SessionSearchResult>("session:search", input)
    },
    review: {
      listChangedFiles: (target: WorkspaceTarget, comparison?: ReviewComparison) =>
        invokeCommand<ChangedFileSummary[]>("review:list-changed-files", { ...target, comparison }),
      loadDiff: (
        target: WorkspaceTarget,
        filePath?: string,
        comparison?: ReviewComparison,
        contextLines?: number
      ) =>
        invokeCommand<WorkspaceDiff>("review:load-diff", {
          ...target,
          filePath,
          comparison,
          contextLines
        })
    },
    workspace: {
      listFiles: (target: WorkspaceTarget) =>
        invokeCommand<WorkspaceFileEntry[]>("workspace:list-files", target),
      readFile: (target: WorkspaceTarget, filePath: string) =>
        invokeCommand<WorkspaceFilePreview>("workspace:read-file", { ...target, filePath }),
      writeFile: (target: WorkspaceTarget, filePath: string, content: string, expectedMtimeMs: number | null) =>
        invokeCommand<WorkspaceFileWriteResult>("workspace:write-file", {
          ...target,
          filePath,
          content,
          expectedMtimeMs
        }),
      statFile: (target: WorkspaceTarget, filePath: string) =>
        invokeCommand<WorkspaceFileStat>("workspace:stat-file", { ...target, filePath }),
      grepContent: (input) => invokeCommand<WorkspaceContentSearchResult>("workspace:grep-content", input)
    },
    checks: {
      run: (input: RunCheckInput) => invokeCommand<CheckRun>("checks:run", input)
    },
    health: {
      ping: () => invokeCommand<{ ok: true; timestamp: string }>("health:ping")
    },
    skills: {
      list: (input) => invokeCommand<SkillSummary[]>("skills:list", input)
    },
    system: {
      openPath: (input) => invokeCommand<{ ok: true }>("system:open-path", input),
      listDetectedIdes: () => invokeCommand<DetectedIde[]>("system:list-detected-ides"),
      diagnostics: () => invokeCommand<DiagnosticsReport>("system:diagnostics"),
      debugSnapshot: (input) =>
        invokeCommand<DebugSnapshot>("system:debug-snapshot", { afterLogSeq: input?.afterLogSeq ?? null }),
      vacuumDatabase: () => invokeCommand<{ ok: true }>("system:vacuum-database"),
      setTheme: (mode) => invokeCommand<{ ok: true }>("system:set-theme", { mode }),
      setDefaultAgent: (input) =>
        invokeCommand<{ ok: true }>("system:set-default-agent", {
          ...input,
          reasoningEffort: input.reasoningEffort ?? null
        }),
      setNotificationsEnabled: (enabled) =>
        invokeCommand<{ ok: true }>("system:set-notifications-enabled", { enabled }),
      testNotification: () => invokeCommand<{ ok: true }>("system:test-notification")
    },
    remote: {
      getStatus: () => invokeCommand<RemoteStatus>("remote:get-status"),
      setConfig: (input) => invokeCommand<RemoteStatus>("remote:set-config", input),
      testNotification: () => invokeCommand<{ ok: true }>("remote:test-notification")
    },
    sync: {
      getStatus: () => invokeCommand<SyncStatus>("sync:get-status"),
      setConfig: (input) => invokeCommand<SyncStatus>("sync:set-config", input),
      runNow: () => invokeCommand<SyncStatus>("sync:run-now")
    },
    routines: {
      list: () => invokeCommand<Routine[]>("routines:list"),
      upsert: (input: RoutineUpsertInput) => invokeCommand<Routine>("routines:upsert", input),
      delete: (id: string) => invokeCommand<null>("routines:delete", { id }),
      setEnabled: (id: string, enabled: boolean) =>
        invokeCommand<Routine>("routines:set-enabled", { id, enabled }),
      runNow: (id: string) => invokeCommand<Routine>("routines:run-now", { id })
    },
    usage: {
      summary: (input: UsageSummaryInput) => invokeCommand<UsageSummary>("usage:summary", input)
    },
    menu: {
      onCommand: (listener) => subscribe<MenuCommand>("menu:command", listener)
    },
    learnings: {
      list: (input) => invokeCommand<Learning[]>("learnings:list", input),
      update: (input) => invokeCommand<Learning>("learnings:update", input),
      delete: (id: string) => invokeCommand<{ ok: true }>("learnings:delete", { id })
    },
    prs: {
      listForSession: (input) => invokeCommand<GhPrRecord[]>("prs:list-for-session", input),
      refresh: (input) => invokeCommand<GhPrRecord[]>("prs:refresh", input)
    },
    git: {
      commit: (input: GitCommitInput) => invokeCommand<GitCommitResult>("git:commit", input),
      push: (input: GitPushInput) => invokeCommand<GitPushResult>("git:push", input),
      createBranch: (input: GitCreateBranchInput) =>
        invokeCommand<GitCreateBranchResult>("git:create-branch", input),
      viewOrCreatePr: (input: GitViewOrCreatePrInput) =>
        invokeCommand<GitViewOrCreatePrResult>("git:view-or-create-pr", input)
    },
    terminal: {
      spawn: (input: TerminalSpawnInput) => invokeCommand<{ terminalId: string }>("terminal:spawn", input),
      write: (input: TerminalWriteInput) => invokeCommand<{ ok: true }>("terminal:write", input),
      resize: (input: TerminalResizeInput) => invokeCommand<{ ok: true }>("terminal:resize", input),
      terminate: (terminalId: string) => invokeCommand<{ ok: true }>("terminal:terminate", { terminalId }),
      onData: (listener: (event: TerminalDataEvent) => void) =>
        subscribe<TerminalDataEvent>("terminal:data", listener),
      onExit: (listener: (event: TerminalExitEvent) => void) =>
        subscribe<TerminalExitEvent>("terminal:exit", listener)
    },
    browser: {
      open: (input) => invokeCommand<{ ok: true }>("browser:open", input),
      navigate: (url: string, tabId: string) =>
        invokeCommand<{ ok: true }>("browser:navigate", { url, tabId }),
      back: (tabId: string) => invokeCommand<{ ok: true }>("browser:back", { tabId }),
      forward: (tabId: string) => invokeCommand<{ ok: true }>("browser:forward", { tabId }),
      reload: (tabId: string) => invokeCommand<{ ok: true }>("browser:reload", { tabId }),
      stop: (tabId: string) => invokeCommand<{ ok: true }>("browser:stop", { tabId }),
      setBounds: (input) => invokeCommand<{ ok: true }>("browser:set-bounds", input),
      close: (tabId: string) => invokeCommand<{ ok: true }>("browser:close", { tabId }),
      fillCredentials: (tabId: string) =>
        invokeCommand<BrowserFillResult>("browser:fill-credentials", { tabId }),
      screenshot: (input) => invokeCommand<BrowserScreenshot>("browser:screenshot", input),
      evaluate: (input) => invokeCommand<BrowserEvaluateResult>("browser:evaluate", input),
      listTabs: (input) => invokeCommand<{ tabs: BrowserTabInfo[] }>("browser:list-tabs", input),
      openForSession: (input) => invokeCommand<{ tabId: string }>("browser:open-for-session", input),
      snapshot: (input) => invokeCommand<BrowserPageSnapshot>("browser:snapshot", input),
      find: (input) => invokeCommand<BrowserFindResult>("browser:find", input),
      getText: (input) => invokeCommand<BrowserPageText>("browser:get-text", input),
      extract: (input) => invokeCommand<BrowserPageExtraction>("browser:extract", input),
      act: (input) => invokeCommand<BrowserActionOutcome>("browser:act", input),
      onState: (listener: (event: BrowserStateEvent) => void) =>
        subscribe<BrowserStateEvent>("browser:state", listener),
      onNewTab: (listener: (event: BrowserNewTabEvent) => void) =>
        subscribe<BrowserNewTabEvent>("browser:new-tab", listener),
      onPageCommand: (listener: (event: BrowserPageCommandEvent) => void) =>
        subscribe<BrowserPageCommandEvent>("browser:page-command", listener),
      onTabs: (listener: (event: { tabs: BrowserTabInfo[] }) => void) =>
        subscribe<{ tabs: BrowserTabInfo[] }>("browser:tabs", listener),
      onAgentOpen: (listener: (event: BrowserAgentOpenEvent) => void) =>
        subscribe<BrowserAgentOpenEvent>("browser:agent-open", listener)
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
 * (`REMOTE_UNSUPPORTED_CHANNELS` in the Rust dispatcher) — opening a path in
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
