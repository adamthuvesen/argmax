import {
  AlertTriangle,
  Archive,
  Bug,
  Check,
  ChevronRight,
  Command,
  ExternalLink,
  FileText,
  Folder,
  GitBranch,
  Globe,
  Loader2,
  Mic,
  PanelRightClose,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { DragEvent as ReactDragEvent, FormEvent, JSX, KeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type {
  ApprovalRequest,
  ChangedFileSummary,
  DashboardDelta,
  DashboardSnapshot,
  ProviderId,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  SkillSummary,
  TimelineEvent,
  WorkspaceDiff,
  WorkspaceSummary
} from "../shared/types.js";
import { PROVIDER_MODEL_DEFAULTS, PROVIDER_MODELS } from "../shared/providerModels.js";
import type { ProviderModelSelection } from "../shared/providerModels.js";
import { tryParseJsonObject } from "../shared/safeJson.js";
import { stripTerminalControls } from "../shared/terminalControls.js";
import { demoSnapshot } from "./demoSnapshot.js";
import { formatElapsed } from "./formatElapsed.js";

const emptySnapshot: DashboardSnapshot = {
  projects: [],
  workspaces: [],
  sessions: [],
  events: [],
  rawOutputs: [],
  approvals: [],
  checks: [],
  checkpoints: []
};

type ToastMessage = { kind: "error" | "info"; message: string };
type SessionCursor = { eventCursor?: number; rawOutputCursor?: number };
type AsyncState = "idle" | "loading" | "ready" | "error";

interface ReviewState {
  files: ChangedFileSummary[];
  filesState: AsyncState;
  filesError: string | null;
  selectedFilePath: string | null;
  diff: WorkspaceDiff | null;
  diffState: AsyncState;
  diffError: string | null;
  isPanelOpen: boolean;
  isSummaryCollapsed: boolean;
  openFile: (filePath: string) => void;
  closePanel: () => void;
  toggleSummary: () => void;
}

type ParsedDiffLine = {
  kind: "addition" | "deletion" | "context";
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
};

type ParsedDiffBlock =
  | { kind: "hunk"; id: string; header: string; lines: ParsedDiffLine[] }
  | { kind: "omitted"; id: string; count: number };

type ModelPickerSelection = ProviderModelSelection & { provider: ProviderId };

const allModelOptions: ModelPickerSelection[] = (Object.entries(PROVIDER_MODELS) as Array<[ProviderId, typeof PROVIDER_MODELS[ProviderId]]>)
  .flatMap(([provider, models]) =>
    models.map((model) => ({
      provider,
      label: model.label,
      modelId: model.modelId,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
    }))
  );


type ToolCall = {
  id: string;
  toolUseId: string;
  name: string;
  inputPreview: string;
  inputFull: Record<string, unknown>;
  output: string | null;
  status: "running" | "done" | "error";
  createdAt: string;
  completedAt: string | null;
  error: string | null;
};

type ParallelPosition = "start" | "middle" | "end";

type ToolCallGroup = {
  id: string;
  tools: ToolCall[];
  parallelPositions: Map<string, ParallelPosition>;
  parallelGroupId: Map<string, string>;
};

type ConversationItem =
  | { kind: "message"; event: TimelineEvent }
  | { kind: "tool"; tool: ToolCall }
  | { kind: "tool-group"; group: ToolCallGroup };

const PARALLEL_WINDOW_MS = 75;

function buildToolCallGroup(tools: ToolCall[]): ToolCallGroup {
  const parallelPositions = new Map<string, ParallelPosition>();
  const parallelGroupId = new Map<string, string>();
  let cluster: ToolCall[] = [];
  const finalize = (): void => {
    if (cluster.length >= 2) {
      const first = cluster[0];
      const last = cluster[cluster.length - 1];
      if (!first || !last) {
        cluster = [];
        return;
      }
      const groupId = `pg-${first.id}`;
      parallelPositions.set(first.id, "start");
      parallelPositions.set(last.id, "end");
      parallelGroupId.set(first.id, groupId);
      parallelGroupId.set(last.id, groupId);
      for (let i = 1; i < cluster.length - 1; i++) {
        const mid = cluster[i];
        if (!mid) continue;
        parallelPositions.set(mid.id, "middle");
        parallelGroupId.set(mid.id, groupId);
      }
    }
    cluster = [];
  };
  for (const tool of tools) {
    const last = cluster[cluster.length - 1];
    if (!last) {
      cluster.push(tool);
      continue;
    }
    const gap = Date.parse(tool.createdAt) - Date.parse(last.createdAt);
    if (Number.isFinite(gap) && gap <= PARALLEL_WINDOW_MS) {
      cluster.push(tool);
    } else {
      finalize();
      cluster = [tool];
    }
  }
  finalize();
  const firstTool = tools[0];
  return {
    id: firstTool ? `tcg-${firstTool.id}` : "tcg-empty",
    tools,
    parallelPositions,
    parallelGroupId
  };
}

function summarizeToolGroup(tools: ToolCall[]): { headline: string; preview: string; worstStatus: ToolCall["status"] } {
  const names = tools.map((t) => t.name.toLowerCase());
  const every = (pred: (n: string) => boolean): boolean => names.every(pred);
  let headline = `${tools.length} tool calls`;
  if (every((n) => /read|view|cat|^ls$|list_dir/.test(n))) headline = `Explored ${tools.length} files`;
  else if (every((n) => /bash|shell|exec|terminal/.test(n))) headline = `Ran ${tools.length} commands`;
  else if (every((n) => /grep|search|find|glob/.test(n))) headline = `Searched ${tools.length} times`;
  else if (every((n) => /web|fetch|http|url|browser/.test(n))) headline = `Fetched ${tools.length} URLs`;
  else if (every((n) => /write|edit|patch|create/.test(n))) headline = `Edited ${tools.length} files`;

  const previewParts: string[] = [];
  for (const tool of tools) {
    const raw = tool.inputPreview;
    if (!raw) continue;
    const trimmed = raw.includes("/") ? raw.split("/").pop() ?? raw : raw;
    previewParts.push(trimmed.slice(0, 28));
    if (previewParts.length === 3) break;
  }
  const preview = previewParts.join(", ") + (tools.length > previewParts.length ? ", …" : "");
  const worstStatus: ToolCall["status"] = tools.some((t) => t.status === "error")
    ? "error"
    : tools.some((t) => t.status === "running")
      ? "running"
      : "done";
  return { headline, preview, worstStatus };
}

function extractToolUseId(payload: Record<string, unknown>): string | null {
  if (typeof payload.id === "string" && payload.id) return payload.id;
  if (typeof payload.call_id === "string" && payload.call_id) return payload.call_id;
  return null;
}

function extractToolName(payload: Record<string, unknown>): string {
  if (typeof payload.name === "string" && payload.name) return payload.name;
  if (typeof payload.type === "string" && payload.type !== "command.started") return payload.type;
  return "tool";
}

function extractToolInput(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)) {
    return payload.input as Record<string, unknown>;
  }
  if (typeof payload.arguments === "string") {
    try { return JSON.parse(payload.arguments) as Record<string, unknown>; } catch { /* ignore */ }
  }
  return {};
}

function extractToolInputPreview(name: string, input: Record<string, unknown>): string {
  const lower = name.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec")) {
    const cmd = input.command ?? input.cmd;
    if (typeof cmd === "string") return cmd.split("\n")[0]?.slice(0, 72) ?? "";
  }
  const path = input.file_path ?? input.path ?? input.relative_path;
  if (typeof path === "string") return path;
  const query = input.query ?? input.pattern ?? input.search_term;
  if (typeof query === "string") return String(query).slice(0, 72);
  const url = input.url;
  if (typeof url === "string") return url.slice(0, 72);
  const first = Object.values(input)[0];
  if (typeof first === "string") return first.slice(0, 72);
  if (typeof first === "number" || typeof first === "boolean") return String(first).slice(0, 72);
  return "";
}

function extractToolOutput(payload: Record<string, unknown>): string | null {
  if (typeof payload.content === "string") return payload.content;
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .map((c: unknown) => (c && typeof c === "object" && "text" in c ? String((c as Record<string, unknown>).text) : ""))
      .filter(Boolean)
      .join("\n");
    return text || null;
  }
  if (typeof payload.output === "string") return payload.output;
  return null;
}

function detectToolError(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true) return true;
  if (payload.isError === true) return true;
  if (typeof payload.error === "string" && payload.error.length > 0) return true;
  if (payload.error && typeof payload.error === "object") return true;
  const status = payload.status;
  if (typeof status === "string" && /fail|error/i.test(status)) return true;
  return false;
}

function extractToolError(payload: Record<string, unknown>): string | null {
  if (typeof payload.error === "string" && payload.error.length > 0) return payload.error;
  if (payload.error && typeof payload.error === "object") {
    const errObj = payload.error as Record<string, unknown>;
    if (typeof errObj.message === "string") return errObj.message;
  }
  if (payload.is_error === true || payload.isError === true) {
    const output = extractToolOutput(payload);
    if (output) return output;
  }
  return null;
}

function extractOpenablePath(name: string, input: Record<string, unknown>): string | null {
  const lower = name.toLowerCase();
  if (!/read|view|cat|write|edit|patch|create|open/.test(lower)) return null;
  for (const key of ["file_path", "filepath", "path", "relative_path", "absolute_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function isBashLikeTool(name: string): boolean {
  const lower = name.toLowerCase();
  return /bash|shell|exec|terminal|cmd/.test(lower);
}

function useAutoGrowTextArea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeightPx: number
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, maxHeightPx);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeightPx ? "auto" : "hidden";
  }, [ref, value, maxHeightPx]);
}

const PROMPT_MAX_HEIGHT_PX = 140;

function thinkingModelSlug(model: ProviderModelSelection): string {
  const id = model.modelId.toLowerCase().split(":")[0] ?? model.modelId;
  return id.replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function getToolIcon(name: string): JSX.Element {
  const lower = name.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("terminal") || lower.includes("exec")) {
    return <Terminal size={13} />;
  }
  if (lower.includes("write") || lower.includes("edit") || lower.includes("create") || lower.includes("patch")) {
    return <Pencil size={13} />;
  }
  if (lower.includes("read") || lower.includes("view") || lower.includes("open") || lower.includes("cat") || lower.includes("list")) {
    return <FileText size={13} />;
  }
  if (lower.includes("search") || lower.includes("grep") || lower.includes("find") || lower.includes("glob")) {
    return <Search size={13} />;
  }
  if (lower.includes("web") || lower.includes("browser") || lower.includes("navigate") || lower.includes("fetch") || lower.includes("url") || lower.includes("http")) {
    return <Globe size={13} />;
  }
  return <Wrench size={13} />;
}

const collapsedProjectsStorageKey = "maestro.sidebar.collapsedProjects";
const projectOrderStorageKey = "maestro.sidebar.projectOrder";
const SIDEBAR_WIDTH_KEY = "maestro.sidebar.width";
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;
const SIDEBAR_DEFAULT = 272;

export function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [launchModel, setLaunchModel] = useState<ModelPickerSelection>(() => ({
    provider: "codex",
    ...modelDefaultForProvider("codex")
  }));
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [bridgeMissing] = useState<boolean>(() => typeof window !== "undefined" && !window.maestro);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(SIDEBAR_WIDTH_KEY) : null;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : SIDEBAR_DEFAULT;
  });
  const [isResizing, setIsResizing] = useState(false);

  const dashboardLoadToken = useRef(0);
  const dashboardDeltaRevision = useRef(0);
  const sessionCursorsRef = useRef(new Map<string, SessionCursor>());
  const resolveApprovalToken = useRef(0);
  const pendingSelectionRef = useRef<{ sessionId: string; workspaceId: string } | null>(null);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const handleResizeMouseDown = useCallback((event: ReactMouseEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    setIsResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e: MouseEvent): void => {
      const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, startWidth + (e.clientX - startX)));
      setSidebarWidth(next);
    };
    const onMouseUp = (): void => {
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  const loadSessionEvents = useCallback(async (sessionId: string): Promise<void> => {
    if (!window.maestro) {
      return;
    }

    const cursor = sessionCursorsRef.current.get(sessionId);
    const data = await window.maestro.session.eventsSince({
      sessionId,
      ...(cursor?.eventCursor !== undefined ? { eventCursor: cursor.eventCursor } : {}),
      ...(cursor?.rawOutputCursor !== undefined ? { rawOutputCursor: cursor.rawOutputCursor } : {})
    });
    sessionCursorsRef.current.set(sessionId, {
      eventCursor: data.eventCursor,
      rawOutputCursor: data.rawOutputCursor
    });
    setSnapshot((current) => ({
      ...current,
      events: pruneSupersededDeltas(mergeByCreatedAt(current.events, data.events, 500, "desc")),
      rawOutputs: mergeByCreatedAt(current.rawOutputs, data.rawOutputs, 100, "desc")
    }));
  }, []);

  const loadDashboard = useCallback(async (): Promise<void> => {
    const token = ++dashboardLoadToken.current;
    const deltaRevision = dashboardDeltaRevision.current;
    try {
      const data = await loadDashboardSnapshot();
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setSnapshot((current) => (deltaRevision === dashboardDeltaRevision.current ? data : mergeDashboardDelta(data, current)));
      setLoadState("ready");
      setLoadError(null);
    } catch (error) {
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setLoadState("error");
      setLoadError(error instanceof Error ? error.message : "Dashboard load failed");
    }
  }, []);

  const refreshDashboardStatus = useCallback(async (): Promise<void> => {
    const token = ++dashboardLoadToken.current;
    try {
      if (!window.maestro) {
        await loadDashboard();
        return;
      }

      const [status, approvals] = await Promise.all([
        window.maestro.workspaces.status(),
        window.maestro.approvals.pending()
      ]);
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setSnapshot((current) => ({
        ...current,
        ...status,
        approvals
      }));
      setLoadState("ready");
      setLoadError(null);
    } catch (error) {
      if (token !== dashboardLoadToken.current) {
        return;
      }
      setLoadState("error");
      setLoadError(error instanceof Error ? error.message : "Dashboard refresh failed");
    }
  }, [loadDashboard]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!window.maestro) {
      return;
    }
    return window.maestro.dashboard.onDelta((delta) => {
      dashboardDeltaRevision.current += 1;
      setSnapshot((current) => mergeDashboardDelta(current, delta));
      setLoadState("ready");
      setLoadError(null);
    });
  }, []);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void refreshDashboardStatus();
      if (selectedSessionId) {
        void loadSessionEvents(selectedSessionId);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [refreshDashboardStatus, selectedSessionId, loadSessionEvents]);

  // Drop session-cursor entries for sessions that have left the snapshot
  // (archived workspace, restart) so the Map doesn't grow without bound.
  useEffect(() => {
    const sessionIds = new Set(snapshot.sessions.map((session) => session.id));
    const cursors = sessionCursorsRef.current;
    for (const id of cursors.keys()) {
      if (!sessionIds.has(id)) {
        cursors.delete(id);
      }
    }
  }, [snapshot.sessions]);

  // Reconcile selectedSessionId against the snapshot without clobbering a
  // just-launched session while its dashboard refresh is still in flight.
  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }

    const selectedSession = snapshot.sessions.find((session) => session.id === selectedSessionId);
    if (selectedSession) {
      if (pendingSelectionRef.current?.sessionId === selectedSessionId) {
        pendingSelectionRef.current = null;
      }
      if (selectedWorkspaceId !== selectedSession.workspaceId) {
        setSelectedWorkspaceId(selectedSession.workspaceId);
      }
      return;
    }

    if (pendingSelectionRef.current?.sessionId === selectedSessionId) {
      if (selectedWorkspaceId !== pendingSelectionRef.current.workspaceId) {
        setSelectedWorkspaceId(pendingSelectionRef.current.workspaceId);
      }
      return;
    }

    setSelectedSessionId(null);
    setSelectedWorkspaceId(null);
  }, [snapshot.sessions, selectedSessionId, selectedWorkspaceId]);

  const selectedSession = useMemo(
    () =>
      (selectedSessionId ? snapshot.sessions.find((session) => session.id === selectedSessionId) : null) ??
      (selectedWorkspaceId ? snapshot.sessions.find((session) => session.workspaceId === selectedWorkspaceId) : null) ??
      null,
    [snapshot.sessions, selectedSessionId, selectedWorkspaceId]
  );
  const selectedWorkspace = useMemo(
    () =>
      (selectedSession ? snapshot.workspaces.find((workspace) => workspace.id === selectedSession.workspaceId) : null) ??
      (selectedWorkspaceId ? snapshot.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) : null) ??
      null,
    [snapshot.workspaces, selectedWorkspaceId, selectedSession]
  );
  const selectedProject = useMemo(
    () =>
      (selectedProjectId ? snapshot.projects.find((project) => project.id === selectedProjectId) : null) ??
      snapshot.projects[0] ??
      null,
    [snapshot.projects, selectedProjectId]
  );

  useEffect(() => {
    if (selectedWorkspace) {
      const workspaceProjectId = selectedWorkspace.projectId;
      if (selectedProjectId !== workspaceProjectId) {
        setSelectedProjectId(workspaceProjectId);
      }
      return;
    }

    if (selectedProjectId && snapshot.projects.some((project) => project.id === selectedProjectId)) {
      return;
    }

    setSelectedProjectId(snapshot.projects[0]?.id ?? null);
  }, [snapshot.projects, selectedProjectId, selectedWorkspace]);

  useEffect(() => {
    if (!selectedSession?.id) {
      return;
    }
    void loadSessionEvents(selectedSession.id);
  }, [selectedSession?.id, loadSessionEvents]);

  const openWorkspaceChat = useCallback(
    (workspaceId: string): void => {
      const workspace = snapshot.workspaces.find((item) => item.id === workspaceId) ?? null;
      const session = snapshot.sessions.find((item) => item.workspaceId === workspaceId) ?? null;
      setSelectedProjectId(workspace?.projectId ?? null);
      setSelectedWorkspaceId(workspaceId);
      setSelectedSessionId(session?.id ?? null);
    },
    [snapshot.sessions, snapshot.workspaces]
  );

  const openProjectLauncher = useCallback((projectId: string): void => {
    setSelectedProjectId(projectId);
    setSelectedSessionId(null);
    setSelectedWorkspaceId(null);
  }, []);

  const handleArchiveWorkspace = useCallback(async (workspaceId: string): Promise<void> => {
    if (!window.maestro) {
      setToast({ kind: "error", message: "Open the Electron app window to archive workspaces." });
      return;
    }
    const result = await window.maestro.workspaces.archive(workspaceId);
    setSnapshot((current) => mergeDashboardDelta(current, { workspaces: [result] }));
    if (selectedWorkspaceId === workspaceId) {
      setSelectedWorkspaceId(null);
      setSelectedSessionId(null);
    }
  }, [selectedWorkspaceId]);

  const addProject = useCallback(async (): Promise<void> => {
    if (!window.maestro) {
      setToast({ kind: "error", message: "Open the Electron app window to add a project." });
      return;
    }

    try {
      const result = await window.maestro.projects.pickFolder();
      if (result.cancelled) {
        return;
      }

      setSelectedProjectId(result.project.id);
      setSelectedSessionId(null);
      setSelectedWorkspaceId(null);
      setSnapshot((current) => mergeDashboardDelta(current, { projects: [result.project] }));
      setToast({ kind: "info", message: `Added ${result.project.name}.` });
    } catch (error) {
      setToast({
        kind: "error",
        message: error instanceof Error ? error.message : "Maestro requires a local git repository."
      });
    }
  }, []);

  const resolveApproval = useCallback(
    async (approvalId: string, status: "approved" | "rejected"): Promise<void> => {
      const token = ++resolveApprovalToken.current;
      const previousSnapshot = snapshot;

      // Optimistic update.
      setSnapshot((current) => ({
        ...current,
        approvals: current.approvals.map((approval) =>
          approval.id === approvalId && approval.status === "pending"
            ? { ...approval, status, resolvedAt: new Date().toISOString() }
            : approval
        )
      }));

      if (!window.maestro) {
        return;
      }

      try {
        await window.maestro.approvals.resolve({ approvalId, status });
        if (token !== resolveApprovalToken.current) {
          return;
        }
        await refreshDashboardStatus();
      } catch (error) {
        if (token !== resolveApprovalToken.current) {
          return;
        }
        setSnapshot(previousSnapshot);
        setToast({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not resolve approval."
        });
      }
    },
    [snapshot, refreshDashboardStatus]
  );

  const sendSessionInput = useCallback(
    async (sessionId: string, input: string, model: ProviderModelSelection): Promise<void> => {
      if (!window.maestro) {
        throw new Error("Open the Electron app window to send input to a live session.");
      }

      await window.maestro.providers.sendInput({
        sessionId,
        input: `${input}\r`,
        modelLabel: model.label,
        modelId: model.modelId,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
      });
      await Promise.all([refreshDashboardStatus(), loadSessionEvents(sessionId)]);
    },
    [refreshDashboardStatus, loadSessionEvents]
  );

  const launchTask = useCallback(
    async (prompt: string, model: ModelPickerSelection): Promise<void> => {
      if (!window.maestro) {
        throw new Error("Open the Electron app window to launch local agents.");
      }

      if (!selectedProject) {
        throw new Error("Register a project before launching an agent.");
      }

      const workspace = await window.maestro.workspaces.createCurrent({
        projectId: selectedProject.id,
        taskLabel: titleFromPrompt(prompt)
      });

      const launchedSession = await window.maestro.providers.launch({
        workspaceId: workspace.id,
        provider: model.provider,
        prompt,
        modelLabel: model.label,
        modelId: model.modelId,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        cols: 120,
        rows: 32
      });

      pendingSelectionRef.current = {
        sessionId: launchedSession.id,
        workspaceId: workspace.id
      };
      setSelectedWorkspaceId(workspace.id);
      setSelectedSessionId(launchedSession.id);
      await Promise.all([refreshDashboardStatus(), loadSessionEvents(launchedSession.id)]);
    },
    [selectedProject, refreshDashboardStatus, loadSessionEvents]
  );

  return (
    <main
      className="app-shell"
      tabIndex={-1}
      style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}
      data-resizing={isResizing ? "true" : undefined}
    >
      {bridgeMissing && !isBrowserPreview() ? (
        <div className="bridge-banner" role="alert">
          Preload bridge unavailable; running on demo data.
        </div>
      ) : null}
      {toast ? (
        <div className={`toast toast-${toast.kind}`} role="status">
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      <Sidebar
        loadState={loadState}
        onOpenLauncher={() => {
          setSelectedSessionId(null);
          setSelectedWorkspaceId(null);
          setIsSettingsOpen(false);
        }}
        onAddProject={() => void addProject()}
        onArchiveWorkspace={(id) => void handleArchiveWorkspace(id)}
        onOpenProject={(projectId) => {
          setIsSettingsOpen(false);
          openProjectLauncher(projectId);
        }}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenWorkspaceChat={(workspaceId) => {
          setIsSettingsOpen(false);
          openWorkspaceChat(workspaceId);
        }}
        onResizeMouseDown={handleResizeMouseDown}
        isSettingsActive={isSettingsOpen}
        selectedProjectId={selectedProject?.id ?? null}
        selectedWorkspaceId={selectedWorkspace?.id ?? null}
        snapshot={snapshot}
      />

      <section className="workspace">
        <div className={
          isSettingsOpen
            ? "work-scroll settings-scroll"
            : selectedSession
              ? "work-scroll session-scroll"
              : "work-scroll launcher-scroll"
        }>
          {loadState === "error" ? (
            <EmptyState message={loadError} onRetry={() => void loadDashboard()} />
          ) : isSettingsOpen ? (
            <SettingsPanel
              defaultModel={launchModel}
              onDefaultModelChange={setLaunchModel}
              onClose={() => setIsSettingsOpen(false)}
            />
          ) : selectedSession ? (
            <SessionPane
              approvals={snapshot.approvals}
              events={snapshot.events}
              onResolveApproval={resolveApproval}
              onSendSessionInput={sendSessionInput}
              project={selectedProject}
              rawOutputs={snapshot.rawOutputs}
              session={selectedSession}
              workspace={selectedWorkspace}
            />
          ) : (
            <LaunchSurface
              onAddProject={() => void addProject()}
              onLaunchTask={launchTask}
              model={launchModel}
              onModelChange={setLaunchModel}
              project={selectedProject}
            />
          )}
        </div>
      </section>
    </main>
  );
}

function Sidebar({
  loadState,
  onAddProject,
  onArchiveWorkspace,
  onOpenLauncher,
  onOpenProject,
  onOpenSettings,
  onOpenWorkspaceChat,
  onResizeMouseDown,
  isSettingsActive,
  selectedProjectId,
  selectedWorkspaceId,
  snapshot
}: {
  loadState: "loading" | "ready" | "error";
  onAddProject: () => void;
  onArchiveWorkspace: (workspaceId: string) => void;
  onOpenLauncher: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenSettings: () => void;
  onOpenWorkspaceChat: (workspaceId: string) => void;
  onResizeMouseDown: (event: ReactMouseEvent) => void;
  isSettingsActive: boolean;
  selectedProjectId: string | null;
  selectedWorkspaceId: string | null;
  snapshot: DashboardSnapshot;
}): JSX.Element {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => loadCollapsedProjectIds());
  const [projectOrder, setProjectOrder] = useState<string[]>(() => loadProjectOrder());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const orderedProjects = useMemo(
    () => applyProjectOrder(snapshot.projects, projectOrder),
    [snapshot.projects, projectOrder]
  );

  const toggleProjectVisibility = useCallback((projectId: string): void => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      saveCollapsedProjectIds(next);
      return next;
    });
  }, []);

  const handleDragStart = useCallback((e: ReactDragEvent<HTMLDivElement>, projectId: string): void => {
    setDraggingId(projectId);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>, projectId: string): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(projectId);
  }, []);

  const handleDrop = useCallback((e: ReactDragEvent<HTMLDivElement>, targetId: string, currentOrdered: ProjectSummary[]): void => {
    e.preventDefault();
    setDraggingId((currentDraggingId) => {
      if (currentDraggingId && currentDraggingId !== targetId) {
        const ids = currentOrdered.map((p) => p.id);
        const from = ids.indexOf(currentDraggingId);
        const to = ids.indexOf(targetId);
        if (from !== -1 && to !== -1) {
          const next = [...ids];
          next.splice(from, 1);
          next.splice(to, 0, currentDraggingId);
          saveProjectOrder(next);
          setProjectOrder(next);
        }
      }
      return null;
    });
    setDragOverId(null);
  }, []);

  const handleDragLeave = useCallback((e: ReactDragEvent<HTMLDivElement>, projectId: string): void => {
    // Only clear when the cursor leaves the row itself, not when it enters a
    // child element (which also fires dragleave on the parent).
    const related = e.relatedTarget;
    if (related instanceof Node && e.currentTarget.contains(related)) return;
    setDragOverId((current) => (current === projectId ? null : current));
  }, []);

  const handleDragEnd = useCallback((): void => {
    setDraggingId(null);
    setDragOverId(null);
  }, []);

  return (
    <aside className="sidebar" data-loading={loadState === "loading" ? "true" : undefined}>
      <div className="window-controls" />
      <nav className="rail-nav" aria-label="Primary">
        <button
          className="rail-nav-item"
          type="button"
          title="New session"
          aria-label="New session"
          onClick={onOpenLauncher}
        >
          <Plus size={16} />
          <span>New session</span>
        </button>
      </nav>

      <div className="project-list">
        <div className="rail-heading">
          <p className="rail-label">Projects</p>
          <button className="small-icon" type="button" title="Add Project" aria-label="Add Project" onClick={onAddProject}>
            <Plus size={16} />
          </button>
        </div>
        {orderedProjects.map((project) => {
          const projectWorkspaces = snapshot.workspaces
            .filter((workspace) => workspace.projectId === project.id && workspace.state !== "archived")
            .slice(0, 7);
          const isCollapsed = collapsedProjectIds.has(project.id);
          const isDragging = draggingId === project.id;
          const isDragOver = dragOverId === project.id && !isDragging;
          return (
            <div
              className={`project-group${isDragging ? " dragging" : ""}${isDragOver ? " drag-over" : ""}`}
              data-collapsed={isCollapsed ? "true" : undefined}
              draggable
              key={project.id}
              onDragStart={(e) => handleDragStart(e, project.id)}
              onDragOver={(e) => handleDragOver(e, project.id)}
              onDragLeave={(e) => handleDragLeave(e, project.id)}
              onDrop={(e) => handleDrop(e, project.id, orderedProjects)}
              onDragEnd={handleDragEnd}
            >
              <div className="project-row">
                <button
                  aria-pressed={selectedProjectId === project.id && !selectedWorkspaceId}
                  className={
                    selectedProjectId === project.id && !selectedWorkspaceId ? "project-name active" : "project-name"
                  }
                  type="button"
                  onClick={() => {
                    onOpenProject(project.id);
                    onOpenLauncher();
                  }}
                >
                  <Folder size={16} />
                  <span>{project.name}</span>
                </button>
                <button
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? "Show" : "Hide"} ${project.name} sessions`}
                  className="project-visibility"
                  title={`${isCollapsed ? "Show" : "Hide"} Sessions`}
                  type="button"
                  onClick={() => toggleProjectVisibility(project.id)}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
              {isCollapsed
                ? null
                : projectWorkspaces.map((workspace) => (
                    <div key={workspace.id} className="session-row">
                      <button
                        aria-pressed={selectedWorkspaceId === workspace.id}
                        className={selectedWorkspaceId === workspace.id ? "session-link active" : "session-link"}
                        data-status={workspace.state}
                        type="button"
                        title={`${workspace.taskLabel} — ${workspace.state}`}
                        onClick={() => onOpenWorkspaceChat(workspace.id)}
                      >
                        <span className="status-dot" aria-hidden="true" />
                        <span>{workspace.taskLabel}</span>
                      </button>
                      {(workspace.state === "complete" ||
                        workspace.state === "failed" ||
                        workspace.state === "cancelled" ||
                        workspace.state === "kept") && (
                        <button
                          className="session-archive-btn"
                          title="Archive session"
                          aria-label="Archive session"
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onArchiveWorkspace(workspace.id); }}
                        >
                          <Archive size={12} />
                        </button>
                      )}
                    </div>
                  ))}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <div className="identity-chip" data-state={loadState}>
          <span className="identity-avatar" aria-hidden="true">M</span>
          <span className="identity-meta">
            <span className="identity-name">Maestro</span>
            <span className="identity-sub">
              {loadState === "ready" ? "Local · Online" : loadState === "loading" ? "Local · Loading" : "Local · Issue"}
            </span>
          </span>
        </div>
        <button
          className="small-icon"
          type="button"
          title="Settings"
          aria-label="Settings"
          aria-pressed={isSettingsActive}
          onClick={onOpenSettings}
        >
          <Settings size={16} />
        </button>
      </div>
      <div className="sidebar-resizer" aria-hidden="true" onMouseDown={onResizeMouseDown} />
    </aside>
  );
}

function loadCollapsedProjectIds(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }

  try {
    const rawValue = window.localStorage.getItem(collapsedProjectsStorageKey);
    const projectIds: unknown = rawValue ? JSON.parse(rawValue) : [];
    return Array.isArray(projectIds) && projectIds.every((projectId) => typeof projectId === "string")
      ? new Set(projectIds)
      : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedProjectIds(projectIds: Set<string>): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify([...projectIds]));
}

function loadProjectOrder(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(projectOrderStorageKey);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : [];
  } catch {
    return [];
  }
}

function saveProjectOrder(ids: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(projectOrderStorageKey, JSON.stringify(ids));
}

function applyProjectOrder(projects: ProjectSummary[], order: string[]): ProjectSummary[] {
  if (order.length === 0) return projects;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...projects].sort((a, b) => {
    const ra = rank.get(a.id) ?? Infinity;
    const rb = rank.get(b.id) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return (b.latestActivityAt ?? "") > (a.latestActivityAt ?? "") ? 1 : -1;
  });
}

function SessionPane({
  approvals,
  events,
  onResolveApproval,
  onSendSessionInput,
  project,
  rawOutputs,
  session,
  workspace
}: {
  approvals: ApprovalRequest[];
  events: TimelineEvent[];
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onSendSessionInput: (sessionId: string, input: string, model: ProviderModelSelection) => Promise<void>;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const sessionId = session?.id ?? null;
  const reviewState = useReviewState(workspace);
  const [isLogOpen, setIsLogOpen] = useState(false);
  const toggleLog = useCallback(() => setIsLogOpen((v) => !v), []);
  const visibleApprovals = useMemo(
    () => (sessionId ? approvals.filter((approval) => approval.sessionId === sessionId) : approvals),
    [approvals, sessionId]
  );
  const visibleEvents = useMemo(
    () => (sessionId ? events.filter((event) => event.sessionId === sessionId) : events),
    [events, sessionId]
  );
  const visibleRawOutputs = useMemo(
    () => (sessionId ? rawOutputs.filter((output) => output.sessionId === sessionId) : rawOutputs),
    [rawOutputs, sessionId]
  );
  const handleResolveApproval = async (approvalId: string, status: "approved" | "rejected"): Promise<void> => {
    try {
      await onResolveApproval(approvalId, status);
    } catch {
      // Errors are surfaced through the parent toast system.
    }
  };

  const gridClass = ["session-grid", reviewState.isPanelOpen && "review-open", isLogOpen && "log-open"]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={gridClass}>
      <div className="session-main-column">
        <SessionConversation
          events={visibleEvents}
          isLogOpen={isLogOpen}
          onSendSessionInput={onSendSessionInput}
          onToggleLog={toggleLog}
          project={project}
          rawOutputs={rawOutputs}
          review={reviewState}
          session={session}
          workspace={workspace}
        />

        {visibleApprovals.length > 0 ? (
          <section className="approval-surface">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Approvals</p>
                <h2>Risk gate</h2>
              </div>
              <ShieldAlert size={20} />
            </div>
            {visibleApprovals.map((approval) => (
              <div className="approval-row" data-risk={approval.riskLevel} key={approval.id}>
                <div className="approval-risk">
                  <strong>{approval.riskLevel}</strong>
                  <span>{approval.status}</span>
                </div>
                <div className="approval-command">
                  <code>{approval.command}</code>
                  <span>
                    {approval.provider} / {approval.cwd}
                  </span>
                </div>
                <div className="approval-actions">
                  <button
                    disabled={approval.status !== "pending"}
                    type="button"
                    onClick={() => {
                      void handleResolveApproval(approval.id, "rejected");
                    }}
                  >
                    Reject
                  </button>
                  <button
                    disabled={approval.status !== "pending"}
                    type="button"
                    onClick={() => {
                      void handleResolveApproval(approval.id, "approved");
                    }}
                  >
                    Approve
                  </button>
                </div>
              </div>
            ))}
          </section>
        ) : null}
      </div>
      {reviewState.isPanelOpen ? <ReviewPanel review={reviewState} /> : null}
      {isLogOpen ? (
        <DebugLogPanel events={visibleEvents} rawOutputs={visibleRawOutputs} onClose={() => setIsLogOpen(false)} />
      ) : null}
    </div>
  );
}

function SessionConversation({
  events,
  isLogOpen,
  onSendSessionInput,
  onToggleLog,
  project,
  rawOutputs,
  review,
  session,
  workspace
}: {
  events: TimelineEvent[];
  isLogOpen: boolean;
  onSendSessionInput: (sessionId: string, input: string, model: ProviderModelSelection) => Promise<void>;
  onToggleLog: () => void;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  review: ReviewState;
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ProviderModelSelection>(() => modelSelectionFromSession(session));
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputFormRef = useRef<HTMLFormElement | null>(null);
  const shouldRefocusInput = useRef(false);
  // `events` is sorted descending upstream (mergeDashboardDelta), so a reverse
  // gives ascending order for free without a per-tick string comparator pass.
  const conversationEvents = useMemo(
    () => {
      const ascending = events
        .filter(
          (event) =>
            event.payload.raw !== true &&
            ["user.message", "message.delta", "message.completed", "error"].includes(event.type) &&
            event.message !== "turn.completed"
        )
        .reverse();
      // Providers stream message.delta fragments and then a final message.completed
      // with the accumulated text. Once a turn has a completed event, the deltas
      // are stale duplicates — keep them only while streaming (before completion).
      return ascending.filter((event, index) => {
        if (event.type !== "message.delta") return true;
        for (let next = index + 1; next < ascending.length; next++) {
          const nextEvent = ascending[next];
          if (!nextEvent) break;
          if (nextEvent.type === "user.message") return true;
          if (nextEvent.type === "message.completed") return false;
        }
        return true;
      });
    },
    [events]
  );
  const hasAssistantEvents = conversationEvents.some((event) => event.type !== "user.message");
  const terminalTranscript = useMemo(
    () => (hasAssistantEvents ? "" : buildTerminalTranscript(rawOutputs, session?.id ?? null)),
    [rawOutputs, session?.id, hasAssistantEvents]
  );
  const latestUserMessageAt = conversationEvents
    .filter((event) => event.type === "user.message")
    .at(-1)?.createdAt ?? null;
  const hasAssistantForLatestTurn = latestUserMessageAt
    ? conversationEvents.some((event) => event.type !== "user.message" && event.createdAt > latestUserMessageAt)
    : hasAssistantEvents;

  const toolCalls = useMemo((): ToolCall[] => {
    const starts = new Map<string, { event: TimelineEvent; toolUseId: string }>();
    const completions = new Map<string, TimelineEvent>();
    for (const event of events) {
      if (event.type === "command.started") {
        const toolUseId = extractToolUseId(event.payload) ?? event.id;
        starts.set(toolUseId, { event, toolUseId });
      } else if (event.type === "command.completed") {
        const toolUseId =
          typeof event.payload.tool_use_id === "string" ? event.payload.tool_use_id :
          typeof event.payload.id === "string" ? event.payload.id : null;
        if (toolUseId) completions.set(toolUseId, event);
      }
    }
    return [...starts.values()]
      .map(({ event, toolUseId }) => {
        const name = extractToolName(event.payload);
        const completion = completions.get(toolUseId);
        const startInput = extractToolInput(event.payload);
        const completionInput = completion ? extractToolInput(completion.payload) : {};
        const input = Object.keys(startInput).length > 0 ? startInput : completionInput;
        const isError = completion ? detectToolError(completion.payload) : false;
        const status: ToolCall["status"] = !completion ? "running" : isError ? "error" : "done";
        return {
          id: event.id,
          toolUseId,
          name,
          inputPreview: extractToolInputPreview(name, input),
          inputFull: input,
          output: completion ? extractToolOutput(completion.payload) : null,
          status,
          createdAt: event.createdAt,
          completedAt: completion ? completion.createdAt : null,
          error: completion && isError ? extractToolError(completion.payload) : null
        };
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [events]);

  const conversationItems = useMemo((): ConversationItem[] => {
    const items: ConversationItem[] = [
      ...conversationEvents.map((event) => ({ kind: "message" as const, event })),
      ...toolCalls.map((tool) => ({ kind: "tool" as const, tool }))
    ];
    const itemTime = (item: ConversationItem): string =>
      item.kind === "message"
        ? item.event.createdAt
        : item.kind === "tool"
          ? item.tool.createdAt
          : item.group.tools[0]?.createdAt ?? "";
    const sorted = items.sort((a, b) => itemTime(a).localeCompare(itemTime(b)));
    const folded: ConversationItem[] = [];
    let i = 0;
    while (i < sorted.length) {
      const item = sorted[i];
      if (!item) {
        i++;
        continue;
      }
      if (item.kind !== "tool") {
        folded.push(item);
        i++;
        continue;
      }
      const run: ToolCall[] = [item.tool];
      let j = i + 1;
      while (j < sorted.length) {
        const next = sorted[j];
        if (!next || next.kind !== "tool") break;
        run.push(next.tool);
        j++;
      }
      if (run.length === 1) {
        folded.push(item);
      } else {
        folded.push({ kind: "tool-group", group: buildToolCallGroup(run) });
      }
      i = j;
    }
    return folded;
  }, [conversationEvents, toolCalls]);

  const anyToolRunning = toolCalls.some((tool) => tool.status === "running");
  const now = useNow(anyToolRunning, 250);
  const isFreshTool = useFreshSet(toolCalls, (tool) => tool.id, session?.id ?? "");

  const canSend = Boolean(
    session &&
      ["complete", "waiting"].includes(session.state)
  );
  const isThinking = session?.state === "running" && !hasAssistantForLatestTurn;

  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef<boolean>(true);

  const handleConversationScroll = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasNearBottomRef.current = distanceFromBottom < 80;
  }, []);

  // Snap to the latest content when the session changes — the previous
  // session's scroll position would otherwise leave the new conversation
  // mid-scroll.
  useEffect(() => {
    const el = conversationListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    wasNearBottomRef.current = true;
  }, [session?.id]);

  // Smart follow: if the user is already at (or near) the bottom, keep them
  // pinned as new messages / tool rows arrive. If they've scrolled up to read,
  // don't yank them back down. `now` is intentionally excluded — re-scrolling
  // every 250ms while a tool is running would be jittery.
  useEffect(() => {
    const el = conversationListRef.current;
    if (!el || !wasNearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [conversationItems, isThinking]);
  const repositoryName = project?.name ?? repoNameFromPath(workspace?.path) ?? "Repository";
  const sessionDetails = [
    session ? providerLabel(session.provider) : null,
    selectedModel.label,
    workspace?.branch ?? null
  ].filter((detail): detail is string => Boolean(detail));

  useEffect(() => {
    setSelectedModel(modelSelectionFromSession(session));
  }, [session]);

  useEffect(() => {
    if (!shouldRefocusInput.current || isSending || !canSend) {
      return;
    }

    shouldRefocusInput.current = false;
    inputRef.current?.focus();
  }, [canSend, isSending]);

  const slashAutocomplete = useSlashAutocomplete({
    input,
    setInput,
    provider: session?.provider ?? null,
    workspaceId: workspace?.id ?? null
  });

  useAutoGrowTextArea(inputRef, input, PROMPT_MAX_HEIGHT_PX);

  const onSessionInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    slashAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      inputFormRef.current?.requestSubmit();
    }
  };

  const submitInput = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedInput = input.trim();
    if (!session || !trimmedInput || isSending) {
      return;
    }

    setIsSending(true);
    setStatus(null);
    shouldRefocusInput.current = true;
    try {
      await onSendSessionInput(session.id, trimmedInput, selectedModel);
      setInput("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send input.");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <section className="conversation-surface" aria-label="Session conversation">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Repository</p>
          <h2>{repositoryName}</h2>
          <div className="conversation-meta" aria-label="Session details">
            {sessionDetails.map((detail) => (
              <span key={detail}>{detail}</span>
            ))}
          </div>
        </div>
        <button
          className="small-icon"
          type="button"
          title="Toggle debug log"
          aria-label="Toggle debug log"
          aria-pressed={isLogOpen}
          onClick={onToggleLog}
        >
          <Bug size={16} />
        </button>
      </div>
      <div className="conversation-list" ref={conversationListRef} onScroll={handleConversationScroll}>
        {conversationItems.length > 0 ? (
          conversationItems.map((item) =>
            item.kind === "tool" ? (
              <ToolCallBubble
                key={item.tool.id}
                tool={item.tool}
                now={now}
                fresh={isFreshTool(item.tool)}
                workspaceCwd={workspace?.path ?? null}
              />
            ) : item.kind === "tool-group" ? (
              <ToolCallGroupBubble
                key={item.group.id}
                group={item.group}
                now={now}
                isFreshTool={isFreshTool}
                workspaceCwd={workspace?.path ?? null}
              />
            ) : item.event.type === "user.message" ? (
              <article className="chat-bubble user" key={item.event.id}>
                <p>{item.event.message}</p>
              </article>
            ) : (
              <article className="chat-bubble assistant" key={item.event.id}>
                <div className="markdown">
                  <ReactMarkdown>{item.event.message}</ReactMarkdown>
                </div>
              </article>
            )
          )
        ) : terminalTranscript ? (
          <article className="chat-bubble assistant terminal-transcript">
            <pre>{terminalTranscript}</pre>
          </article>
        ) : isThinking ? null : (
          <p className="conversation-empty">Agent replies will appear here.</p>
        )}
        {terminalTranscript && !hasAssistantEvents && conversationItems.length > 0 ? (
          <article className="chat-bubble assistant terminal-transcript">
            <pre>{terminalTranscript}</pre>
          </article>
        ) : null}
        {isThinking ? (
          <article className="chat-bubble assistant thinking-indicator" aria-live="polite" aria-label="Thinking">
            <div className="command-stream" data-testid="command-stream" aria-hidden="true">
              <span className="command-stream-glyph" />
              <span className="command-stream-line">
                <span className="command-stream-prompt">$</span>
                <span className="command-stream-text">maestro run --model {thinkingModelSlug(selectedModel)}</span>
                <span className="command-stream-caret" />
              </span>
              <span className="command-stream-ticks">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span className="command-stream-trace" />
            </div>
          </article>
        ) : null}
      </div>
      <ChangedFilesCard review={review} />
      <form className="session-input" ref={inputFormRef} onSubmit={(event) => void submitInput(event)}>
        <div className="session-input-field">
          <textarea
            aria-label="Session prompt"
            aria-autocomplete="list"
            aria-expanded={slashAutocomplete.popoverOpen}
            aria-controls={slashAutocomplete.popoverOpen ? "skill-popover" : undefined}
            disabled={!canSend || isSending}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onSessionInputKeyDown}
            placeholder=""
            ref={inputRef}
            value={input}
            rows={1}
          />
          <SkillPopover state={slashAutocomplete} inputRef={inputRef} />
        </div>
        <div className="session-input-toolbar">
          <button className="composer-tool" type="button" title="Add context" disabled={!canSend || isSending}>
            <Plus size={16} />
          </button>
          {session ? (
            <ModelSelector
              provider={session.provider}
              value={selectedModel}
              onChange={setSelectedModel}
              ariaLabel="Session model"
            />
          ) : null}
          <span className="session-toolbar-spacer" />
          <button className="composer-tool" type="button" title="Voice input" disabled={!canSend || isSending}>
            <Mic size={16} />
          </button>
          <button className="session-send-button" disabled={!canSend || isSending || !input.trim()} type="submit" title="Send follow-up">
            <ChevronRight size={18} />
          </button>
        </div>
      </form>
      {status ? (
        <p className="composer-status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}

function DebugLogPanel({
  events,
  onClose,
  rawOutputs
}: {
  events: TimelineEvent[];
  onClose: () => void;
  rawOutputs: RawProviderOutput[];
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<"events" | "output">("events");
  return (
    <aside className="log-panel" aria-label="Debug log">
      <div className="log-toolbar">
        <div>
          <p className="eyebrow">Debug</p>
          <h2>Session log</h2>
        </div>
        <button className="small-icon" type="button" title="Close debug log" aria-label="Close debug log" onClick={onClose}>
          <PanelRightClose size={18} />
        </button>
      </div>
      <div className="log-tab-bar" role="tablist">
        <button role="tab" aria-selected={activeTab === "events"} type="button" onClick={() => setActiveTab("events")}>
          Events
          <span>{events.length}</span>
        </button>
        <button role="tab" aria-selected={activeTab === "output"} type="button" onClick={() => setActiveTab("output")}>
          Raw output
          <span>{rawOutputs.length}</span>
        </button>
      </div>
      <div className="log-body">
        {activeTab === "events" ? <DebugEventList events={events} /> : <DebugOutputList outputs={rawOutputs} />}
      </div>
    </aside>
  );
}

function DebugEventList({ events }: { events: TimelineEvent[] }): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (events.length === 0) {
    return <p className="log-empty">No events yet.</p>;
  }

  return (
    <div className="log-event-list">
      {events.map((event) => {
        const isExpanded = expanded.has(event.id);
        const hasPayload = Object.keys(event.payload).length > 0;
        const time = new Date(event.createdAt).toLocaleTimeString("en-US", { hour12: false });
        return (
          <div className="log-event-row" data-type={event.type} key={event.id}>
            <div className="log-event-header">
              <span className="log-type-badge">{event.type}</span>
              <span className="log-event-time">{time}</span>
              {hasPayload ? (
                <button
                  className="log-expand-btn"
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(event.id)) {
                        next.delete(event.id);
                      } else {
                        next.add(event.id);
                      }
                      return next;
                    })
                  }
                >
                  {isExpanded ? "▴" : "▾"}
                </button>
              ) : null}
            </div>
            {event.message ? <p className="log-event-message">{event.message}</p> : null}
            {isExpanded ? (
              <pre className="log-event-payload">{JSON.stringify(event.payload, null, 2)}</pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function DebugOutputList({ outputs }: { outputs: RawProviderOutput[] }): JSX.Element {
  if (outputs.length === 0) {
    return <p className="log-empty">No raw output yet.</p>;
  }

  const sorted = [...outputs].reverse();
  return (
    <div className="log-output-list">
      {sorted.map((output) => (
        <div className="log-output-row" data-stream={output.stream} key={output.id}>
          <span className="log-stream-badge">{output.stream}</span>
          <pre className="log-output-content">{output.content}</pre>
        </div>
      ))}
    </div>
  );
}

function useNow(active: boolean, intervalMs: number): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

function useFreshSet<T>(items: T[], getId: (item: T) => string, resetKey: string): (item: T) => boolean {
  const stateRef = useRef<{ key: string; seen: Set<string> }>({ key: "", seen: new Set() });
  if (stateRef.current.key !== resetKey) {
    stateRef.current = { key: resetKey, seen: new Set(items.map(getId)) };
  }
  useEffect(() => {
    for (const item of items) stateRef.current.seen.add(getId(item));
  }, [items, getId]);
  return useCallback((item: T) => !stateRef.current.seen.has(getId(item)), [getId]);
}

function ToolCallBubble({
  tool,
  now,
  fresh,
  parallelPosition,
  parallelGroupId,
  nested,
  workspaceCwd
}: {
  tool: ToolCall;
  now: number;
  fresh: boolean;
  parallelPosition?: ParallelPosition;
  parallelGroupId?: string;
  nested?: boolean;
  workspaceCwd?: string | null;
}): JSX.Element {
  // Standalone errors expand themselves so the message is visible without a
  // click. When nested in a group the group is the entry point — let the user
  // open individual error rows on demand so a bursty turn doesn't unfold into
  // a wall of stack traces.
  const shouldAutoExpandOnError = !nested;
  const [expanded, setExpanded] = useState<boolean>(shouldAutoExpandOnError && tool.status === "error");
  const autoExpandedOnErrorRef = useRef<boolean>(shouldAutoExpandOnError && tool.status === "error");
  const [didFlash, setDidFlash] = useState<boolean>(false);

  useEffect(() => {
    if (!shouldAutoExpandOnError) return;
    if (tool.status === "error" && !autoExpandedOnErrorRef.current) {
      autoExpandedOnErrorRef.current = true;
      setExpanded(true);
    }
  }, [tool.status, shouldAutoExpandOnError]);

  const startedMs = Date.parse(tool.createdAt);
  const endedMs = tool.completedAt ? Date.parse(tool.completedAt) : now;
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, endedMs - startedMs) : 0;
  const elapsedText = formatElapsed(elapsedMs);
  const statusWord = tool.status === "running" ? "running" : tool.status === "error" ? "failed" : "done";
  const chipLabel = elapsedText ? `${statusWord}, ${elapsedText}` : statusWord;

  const showFlash = fresh && !didFlash;
  const rootClass = [
    "tool-call-item",
    `tool-call-${tool.status}`,
    nested ? "tool-call-item--nested" : null
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rootClass}
      data-status={tool.status}
      {...(parallelPosition ? { "data-parallel-position": parallelPosition } : {})}
      {...(parallelGroupId ? { "data-parallel-group": parallelGroupId } : {})}
    >
      {showFlash ? (
        <span
          className="tool-call-flash"
          aria-hidden="true"
          onAnimationEnd={() => setDidFlash(true)}
        />
      ) : null}
      <button
        className="tool-call-header"
        type="button"
        aria-expanded={expanded}
        aria-label={`${tool.name}${tool.inputPreview ? ": " + tool.inputPreview : ""}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="tool-call-icon" aria-hidden="true">{getToolIcon(tool.name)}</span>
        <span className="tool-call-name">{tool.name}</span>
        {tool.inputPreview ? <code className="tool-call-preview">{tool.inputPreview}</code> : null}
        <span className="tool-call-status-chip" aria-label={chipLabel} title={chipLabel}>
          <span className="tool-call-status-glyph" aria-hidden="true">
            {tool.status === "running" ? (
              <Loader2 size={11} className="tool-call-spinner" />
            ) : tool.status === "error" ? (
              <X size={11} />
            ) : (
              <Check size={11} />
            )}
          </span>
          {elapsedText ? (
            <span className="tool-call-status-time" aria-hidden="true">
              {tool.status === "error" && elapsedMs < 100 ? "failed" : elapsedText}
            </span>
          ) : null}
        </span>
        <ChevronRight size={11} className={`tool-call-chevron${expanded ? " expanded" : ""}`} />
      </button>
      {expanded ? (
        <div className="tool-call-detail">
          {tool.error ? (
            <div className="tool-call-section">
              <p className="tool-call-section-label">Error</p>
              <pre className="tool-call-code tool-call-code--error">{tool.error}</pre>
            </div>
          ) : null}
          {tool.status !== "error"
            ? (() => {
                const openable = extractOpenablePath(tool.name, tool.inputFull);
                if (!openable) return null;
                const onOpen = (): void => {
                  if (!window.maestro) return;
                  void window.maestro.system
                    .openPath({ path: openable, ...(workspaceCwd ? { cwd: workspaceCwd } : {}) })
                    .catch(() => undefined);
                };
                return (
                  <button className="tool-call-open-button" type="button" onClick={onOpen} aria-label={`Open ${openable}`}>
                    <ExternalLink size={11} aria-hidden="true" />
                    <span>Open {openable}</span>
                  </button>
                );
              })()
            : null}
          {Object.keys(tool.inputFull).length > 0 ? (
            <div className="tool-call-section">
              <p className="tool-call-section-label">Input</p>
              <pre className="tool-call-code">{JSON.stringify(tool.inputFull, null, 2)}</pre>
            </div>
          ) : null}
          {tool.output && !tool.error ? (
            <div className="tool-call-section">
              <p className="tool-call-section-label">
                Output
                {tool.output.length > 3000 ? (
                  <span className="tool-call-section-meta">
                    {" "}— showing first 3,000 of {tool.output.length.toLocaleString()} chars
                  </span>
                ) : null}
              </p>
              <pre
                className={`tool-call-code${isBashLikeTool(tool.name) ? " tool-call-code--terminal" : ""}`}
              >
                {tool.output.length > 3000 ? `${tool.output.slice(0, 3000)}\n…` : tool.output}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolCallGroupBubble({
  group,
  now,
  isFreshTool,
  workspaceCwd
}: {
  group: ToolCallGroup;
  now: number;
  isFreshTool: (tool: ToolCall) => boolean;
  workspaceCwd?: string | null;
}): JSX.Element {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const summary = useMemo(() => summarizeToolGroup(group.tools), [group.tools]);
  // Default to expanded so users can see what the agent did, even after the
  // turn completes. The user can manually collapse to free up vertical space.
  const expanded = userToggle ?? true;
  const earliestStart = useMemo(
    () => Math.min(...group.tools.map((t) => Date.parse(t.createdAt))),
    [group.tools]
  );
  const latestEnd = useMemo(() => {
    const ends = group.tools.map((t) => (t.completedAt ? Date.parse(t.completedAt) : now));
    return Math.max(...ends);
  }, [group.tools, now]);
  const elapsedMs = Number.isFinite(earliestStart) ? Math.max(0, latestEnd - earliestStart) : 0;
  const elapsedText = formatElapsed(elapsedMs);
  const chipLabel =
    summary.worstStatus === "running"
      ? `running, ${elapsedText}`
      : summary.worstStatus === "error"
        ? `failed, ${elapsedText}`
        : `done, ${elapsedText}`;

  return (
    <div className="tool-call-group" data-status={summary.worstStatus}>
      <button
        className="tool-call-group-header"
        type="button"
        aria-expanded={expanded}
        aria-label={`${summary.headline}${summary.preview ? ": " + summary.preview : ""}`}
        onClick={() => setUserToggle(!expanded)}
      >
        <span className="tool-call-group-stack" aria-hidden="true">
          {group.tools.slice(0, 3).map((t) => (
            <span key={t.id} className="tool-call-group-stack-icon">{getToolIcon(t.name)}</span>
          ))}
        </span>
        <span className="tool-call-group-headline">{summary.headline}</span>
        {summary.preview ? <span className="tool-call-group-preview">· {summary.preview}</span> : null}
        <span className="tool-call-status-chip" aria-label={chipLabel} title={chipLabel}>
          <span className="tool-call-status-glyph" aria-hidden="true">
            {summary.worstStatus === "running" ? (
              <Loader2 size={11} className="tool-call-spinner" />
            ) : summary.worstStatus === "error" ? (
              <X size={11} />
            ) : (
              <Check size={11} />
            )}
          </span>
          {elapsedText ? (
            <span className="tool-call-status-time" aria-hidden="true">{elapsedText}</span>
          ) : null}
        </span>
        <ChevronRight size={11} className={`tool-call-chevron${expanded ? " expanded" : ""}`} />
      </button>
      {expanded ? (
        <div className="tool-call-group-body">
          {group.tools.map((tool) => (
            <ToolCallBubble
              key={tool.id}
              tool={tool}
              now={now}
              fresh={isFreshTool(tool)}
              nested
              workspaceCwd={workspaceCwd ?? null}
              {...(group.parallelPositions.get(tool.id)
                ? { parallelPosition: group.parallelPositions.get(tool.id)! }
                : {})}
              {...(group.parallelGroupId.get(tool.id)
                ? { parallelGroupId: group.parallelGroupId.get(tool.id)! }
                : {})}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function useReviewState(workspace: WorkspaceSummary | null): ReviewState {
  const [files, setFiles] = useState<ChangedFileSummary[]>([]);
  const [filesState, setFilesState] = useState<AsyncState>("idle");
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffState, setDiffState] = useState<AsyncState>("idle");
  const [diffError, setDiffError] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isSummaryCollapsed, setIsSummaryCollapsed] = useState(false);
  const fileLoadToken = useRef(0);
  const diffLoadToken = useRef(0);
  const previousWorkspaceId = useRef<string | null>(null);
  const isPanelOpenRef = useRef(false);

  useEffect(() => {
    isPanelOpenRef.current = isPanelOpen;
  }, [isPanelOpen]);

  useEffect(() => {
    const token = ++fileLoadToken.current;
    const workspaceId = workspace?.id ?? null;
    if (previousWorkspaceId.current !== workspaceId) {
      previousWorkspaceId.current = workspaceId;
      setSelectedFilePath(null);
      setDiff(null);
      setDiffState("idle");
      setDiffError(null);
      setIsPanelOpen(false);
      setIsSummaryCollapsed(false);
    }

    if (!workspace?.id || !window.maestro) {
      setFiles([]);
      setFilesState("idle");
      setFilesError(null);
      setIsPanelOpen(false);
      setIsSummaryCollapsed(false);
      return;
    }

    setFilesState("loading");
    setFilesError(null);
    void window.maestro.review
      .listChangedFiles(workspace.id)
      .then((result) => {
        if (token !== fileLoadToken.current) {
          return;
        }
        const sorted = [...result].sort((left, right) => left.path.localeCompare(right.path));
        setFiles(sorted);
        setFilesState("ready");
        setSelectedFilePath((currentPath) => {
          if (currentPath && sorted.some((file) => file.path === currentPath)) {
            return currentPath;
          }
          return isPanelOpenRef.current ? sorted[0]?.path ?? null : null;
        });
        if (sorted.length === 0) {
          setIsPanelOpen(false);
        }
      })
      .catch((error) => {
        if (token !== fileLoadToken.current) {
          return;
        }
        setFiles([]);
        setFilesState("error");
        setFilesError(error instanceof Error ? error.message : "Could not load changed files.");
      });
  }, [workspace?.id, workspace?.changedFiles, workspace?.lastActivityAt]);

  useEffect(() => {
    const token = ++diffLoadToken.current;
    if (!workspace?.id || !selectedFilePath || !window.maestro) {
      setDiff(null);
      setDiffState("idle");
      setDiffError(null);
      return;
    }

    setDiffState("loading");
    setDiffError(null);
    void window.maestro.review
      .loadDiff(workspace.id, selectedFilePath)
      .then((result) => {
        if (token !== diffLoadToken.current) {
          return;
        }
        setDiff(result);
        setDiffState("ready");
      })
      .catch((error) => {
        if (token !== diffLoadToken.current) {
          return;
        }
        setDiff(null);
        setDiffState("error");
        setDiffError(error instanceof Error ? error.message : "Could not load diff.");
      });
  }, [workspace?.id, selectedFilePath]);

  const openFile = useCallback((filePath: string): void => {
    setSelectedFilePath(filePath);
    setIsPanelOpen(true);
  }, []);

  const closePanel = useCallback((): void => {
    setIsPanelOpen(false);
  }, []);

  const toggleSummary = useCallback((): void => {
    setIsSummaryCollapsed((current) => !current);
  }, []);

  return {
    files,
    filesState,
    filesError,
    selectedFilePath,
    diff,
    diffState,
    diffError,
    isPanelOpen,
    isSummaryCollapsed,
    openFile,
    closePanel,
    toggleSummary
  };
}

function ChangedFilesCard({ review }: { review: ReviewState }): JSX.Element | null {
  if (review.filesState === "idle" || (review.filesState === "ready" && review.files.length === 0)) {
    return null;
  }

  if (review.filesState === "loading") {
    return (
      <section className="changed-files-card" aria-label="Changed files">
        <div className="changed-files-header">
          <span>Loading changed files</span>
        </div>
      </section>
    );
  }

  if (review.filesState === "error") {
    return (
      <section className="changed-files-card" aria-label="Changed files">
        <div className="changed-files-header">
          <span>Changed files unavailable</span>
          <span className="review-error">{review.filesError}</span>
        </div>
      </section>
    );
  }

  const totals = summarizeChangedFiles(review.files);
  return (
    <section className="changed-files-card" aria-label="Changed files" data-collapsed={review.isSummaryCollapsed ? "true" : undefined}>
      <div className="changed-files-header">
        <span>{review.files.length} files changed</span>
        <span className="changed-files-actions">
          <ChangeCount additions={totals.additions} deletions={totals.deletions} />
          <button type="button" onClick={review.toggleSummary}>
            {review.isSummaryCollapsed ? "Show diff" : "Hide diff"}
          </button>
        </span>
      </div>
      {review.isSummaryCollapsed ? null : (
        <div className="changed-files-list">
          {review.files.map((file) => (
            <button
              aria-pressed={review.selectedFilePath === file.path && review.isPanelOpen}
              className="changed-file-row"
              key={file.path}
              type="button"
              title={file.path}
              onClick={() => review.openFile(file.path)}
            >
              <span className="changed-file-status">{statusLabel(file.status)}</span>
              <span className="changed-file-path">{file.path}</span>
              <ChangeCount additions={file.additions} deletions={file.deletions} />
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ReviewPanel({ review }: { review: ReviewState }): JSX.Element {
  const selectedFile = review.files.find((file) => file.path === review.selectedFilePath) ?? null;
  const totals = summarizeChangedFiles(review.files);
  const diffBlocks = useMemo(() => parseUnifiedDiff(review.diff?.content ?? ""), [review.diff?.content]);
  const [fileTabsHeight, setFileTabsHeight] = useState(168);
  const panelRef = useRef<HTMLElement>(null);

  const handleResizeMouseDown = (e: ReactMouseEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = fileTabsHeight;
    // Cap so the diff area always gets at least 120px (toolbar ~80px + handle 5px + diff min).
    const maxH = (panelRef.current?.clientHeight ?? 800) - 160;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    const onMove = (me: MouseEvent) => {
      // Minimum of ~80px gives the user at least two file tabs to scan.
      setFileTabsHeight(Math.max(80, Math.min(startH + me.clientY - startY, maxH)));
    };
    const onUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <aside className="review-panel" aria-label="Review panel" ref={panelRef}>
      <div className="review-toolbar">
        <div>
          <p className="eyebrow">Review</p>
          <h2>
            {review.files.length} files changed <ChangeCount additions={totals.additions} deletions={totals.deletions} />
          </h2>
        </div>
        <button className="small-icon" type="button" title="Close review" aria-label="Close review" onClick={review.closePanel}>
          <PanelRightClose size={18} />
        </button>
      </div>
      <div className="review-file-tabs" aria-label="Changed file list" style={{ height: fileTabsHeight }}>
        {review.files.map((file) => (
          <button
            aria-pressed={review.selectedFilePath === file.path}
            key={file.path}
            type="button"
            title={file.path}
            onClick={() => review.openFile(file.path)}
          >
            <FileText size={15} />
            <span>{file.path}</span>
            <ChangeCount additions={file.additions} deletions={file.deletions} />
          </button>
        ))}
      </div>
      <div className="review-resize-handle" onMouseDown={handleResizeMouseDown} />
      <div className="review-diff">
        {selectedFile ? (
          <div className="review-diff-heading">
            <div>
              <span className="changed-file-status">{statusLabel(selectedFile.status)}</span>
              <strong>{selectedFile.path}</strong>
              <ChangeCount additions={selectedFile.additions} deletions={selectedFile.deletions} />
            </div>
            <button className="small-icon" type="button" title="Close review" aria-label="Close review" onClick={review.closePanel}>
              <X size={16} />
            </button>
          </div>
        ) : null}
        {review.diffState === "loading" ? <p className="review-empty">Loading diff...</p> : null}
        {review.diffState === "error" ? <p className="review-empty review-error">{review.diffError}</p> : null}
        {review.diffState === "ready" && diffBlocks.length === 0 ? <p className="review-empty">No textual diff.</p> : null}
        {review.diffState === "ready" && diffBlocks.length > 0 ? <DiffBlocks blocks={diffBlocks} /> : null}
      </div>
    </aside>
  );
}

function DiffBlocks({ blocks }: { blocks: ParsedDiffBlock[] }): JSX.Element {
  return (
    <div className="diff-blocks">
      {blocks.map((block) =>
        block.kind === "omitted" ? (
          <div className="diff-omitted" key={block.id}>
            {block.count} unmodified lines
          </div>
        ) : (
          <div className="diff-hunk" key={block.id}>
            <div className="diff-hunk-header">{block.header}</div>
            {block.lines.map((line, index) => (
              <div className={`diff-line ${line.kind}`} key={`${block.id}-${index}`}>
                <span className="diff-line-number">{line.oldLineNumber ?? ""}</span>
                <span className="diff-line-number">{line.newLineNumber ?? ""}</span>
                <code>{line.content || " "}</code>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function ChangeCount({ additions, deletions }: { additions: number; deletions: number }): JSX.Element {
  return (
    <span className="change-count" aria-label={`${additions} additions, ${deletions} deletions`}>
      <span className="additions">+{additions}</span>
      <span className="deletions">-{deletions}</span>
    </span>
  );
}

function summarizeChangedFiles(files: ChangedFileSummary[]): { additions: number; deletions: number } {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions
    }),
    { additions: 0, deletions: 0 }
  );
}

function statusLabel(status: string): string {
  if (status === "??" || status.includes("A")) {
    return "Added";
  }
  if (status.includes("D")) {
    return "Deleted";
  }
  if (status.includes("R")) {
    return "Renamed";
  }
  if (status.includes("C")) {
    return "Copied";
  }
  return "Modified";
}

function parseUnifiedDiff(content: string): ParsedDiffBlock[] {
  const lines = content.split("\n");
  const blocks: ParsedDiffBlock[] = [];
  let index = 0;
  let previousOldEnd: number | null = null;
  let hunkIndex = 0;

  while (index < lines.length) {
    const header = lines[index];
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(header);
    if (!match) {
      index += 1;
      continue;
    }

    const oldStart = Number(match[1]);
    let oldLineNumber = oldStart;
    let newLineNumber = Number(match[2]);
    if (previousOldEnd !== null) {
      const omittedCount = oldStart - previousOldEnd - 1;
      if (omittedCount > 0) {
        blocks.push({ kind: "omitted", id: `omitted-${hunkIndex}`, count: omittedCount });
      }
    }

    const hunkLines: ParsedDiffLine[] = [];
    index += 1;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const line = lines[index];
      if (line.startsWith("diff --git ")) {
        break;
      }
      if (line.startsWith("\\ No newline")) {
        index += 1;
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++")) {
        hunkLines.push({
          kind: "addition",
          oldLineNumber: null,
          newLineNumber,
          content: line.slice(1)
        });
        newLineNumber += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        hunkLines.push({
          kind: "deletion",
          oldLineNumber,
          newLineNumber: null,
          content: line.slice(1)
        });
        oldLineNumber += 1;
      } else if (line.startsWith(" ")) {
        hunkLines.push({
          kind: "context",
          oldLineNumber,
          newLineNumber,
          content: line.slice(1)
        });
        oldLineNumber += 1;
        newLineNumber += 1;
      }
      index += 1;
    }

    blocks.push({ kind: "hunk", id: `hunk-${hunkIndex}`, header, lines: hunkLines });
    previousOldEnd = oldLineNumber - 1;
    hunkIndex += 1;
  }

  return blocks;
}

function LaunchSurface({
  model,
  onAddProject,
  onLaunchTask,
  onModelChange,
  project
}: {
  model: ModelPickerSelection;
  onAddProject: () => void;
  onLaunchTask: (prompt: string, model: ModelPickerSelection) => Promise<void>;
  onModelChange: (model: ModelPickerSelection) => void;
  project: ProjectSummary | null;
}): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const headingTemplate = useMemo(() => {
    const options = [
      "{name}: the final frontier.",
      "In space, no one can hear your {name} build fail.",
      "You're gonna need a bigger {name}.",
      "What we've got here is a failure to ship {name}.",
      "{name} will remember that.",
      "I'm sorry Dave, I can't merge that into {name}.",
      "With great {name} comes great responsibility.",
      "One does not simply deploy {name} to production.",
      "{name}: it's alive!",
      "I know kung fu. What are we building in {name}?",
    ];
    return options[Math.floor(Math.random() * options.length)];
  }, []);
  const placeholderText = useMemo(() => {
    const options = [
      "Do or do not. There is no try.",
      "You can't handle the diff.",
      "I'll be back. (After this build passes.)",
      "My precious... what are we shipping?",
      "Make it so.",
      "Elementary. What needs debugging?",
      "You had me at \"merge conflict\".",
      "Why so serious? Describe the task.",
      "What is thy bidding, master?",
      "They may take our lives, but they'll never take our main branch.",
    ];
    return options[Math.floor(Math.random() * options.length)];
  }, []);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  useAutoGrowTextArea(promptInputRef, prompt, PROMPT_MAX_HEIGHT_PX);
  const slashAutocomplete = useSlashAutocomplete({
    input: prompt,
    setInput: setPrompt,
    provider: model.provider,
    workspaceId: null
  });

  const onPromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    slashAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const submitPrompt = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setStatus(null);
    try {
      await onLaunchTask(trimmedPrompt, model);
      setPrompt("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start agent.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!project) {
    return (
      <div className="launcher-surface empty-project-launcher">
        <h1>Add a project to start</h1>
        <button className="primary-action" type="button" onClick={onAddProject}>
          <Plus size={18} />
          Add Project
        </button>
      </div>
    );
  }

  return (
    <div className="launcher-surface">
      <h1>{headingTemplate.replace("{name}", project.name)}</h1>
      <form className="composer" ref={formRef} onSubmit={(event) => void submitPrompt(event)}>
        <div className="composer-input">
          <textarea
            aria-label="Task prompt"
            aria-autocomplete="list"
            aria-expanded={slashAutocomplete.popoverOpen}
            aria-controls={slashAutocomplete.popoverOpen ? "skill-popover" : undefined}
            disabled={isSubmitting}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onPromptKeyDown}
            placeholder={placeholderText}
            ref={promptInputRef}
            value={prompt}
            rows={1}
          />
          <SkillPopover state={slashAutocomplete} inputRef={promptInputRef} />
          <button className="composer-tool" type="button" title="Add context">
            <Plus size={18} />
          </button>
          <button className="composer-tool" type="button" title="Commands">
            <Command size={18} />
          </button>
          <button className="composer-tool" type="button" title="Voice input">
            <Mic size={18} />
          </button>
          <button className="send-button" disabled={isSubmitting || !prompt.trim()} type="submit" title="Start agent">
            <kbd className="kbd kbd-hint" aria-hidden="true">⌘ ↵</kbd>
            <ChevronRight size={20} />
          </button>
        </div>
        <div className="composer-context">
          <span className="composer-context-chip">
            <Folder size={14} aria-hidden="true" />
            {project.name}
          </span>
          <span className="composer-context-chip">
            <GitBranch size={14} aria-hidden="true" />
            main
          </span>
          <CombinedModelSelector value={model} onChange={onModelChange} ariaLabel="Launch model" />
        </div>
        {status ? (
          <p className="composer-status" role="status">
            {status}
          </p>
        ) : null}
      </form>
    </div>
  );
}

function SettingsPanel({
  defaultModel,
  onDefaultModelChange,
  onClose
}: {
  defaultModel: ModelPickerSelection;
  onDefaultModelChange: (model: ModelPickerSelection) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="settings-surface">
      <header className="settings-header">
        <div>
          <p className="eyebrow">Preferences</p>
          <h1>Settings</h1>
        </div>
        <button className="small-icon" type="button" title="Close settings" aria-label="Close settings" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <section className="settings-section" aria-labelledby="settings-account">
        <header className="settings-section-header">
          <h2 id="settings-account">Account</h2>
          <p>Maestro runs locally on this machine — there is no cloud account.</p>
        </header>
        <div className="settings-card">
          <div className="settings-account">
            <span className="settings-avatar" aria-hidden="true">M</span>
            <div className="settings-account-meta">
              <span className="settings-account-name">Maestro</span>
              <span className="settings-account-sub">Local · single user</span>
            </div>
          </div>
          <dl className="settings-keyvals">
            <div>
              <dt>Storage</dt>
              <dd>SQLite (on this device)</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>Provider calls only · no telemetry</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-appearance">
        <header className="settings-section-header">
          <h2 id="settings-appearance">Appearance</h2>
          <p>Maestro is light-theme only by design. Fonts are locked to Lilex for consistency.</p>
        </header>
        <div className="settings-card">
          <fieldset className="settings-radio-group">
            <legend>Theme</legend>
            <label>
              <input type="radio" name="theme" value="light" checked readOnly />
              <span>Light</span>
              <span className="settings-pill">Locked</span>
            </label>
            <label className="settings-radio-disabled">
              <input type="radio" name="theme" value="dark" disabled />
              <span>Dark</span>
            </label>
            <label className="settings-radio-disabled">
              <input type="radio" name="theme" value="system" disabled />
              <span>Match system</span>
            </label>
          </fieldset>
          <dl className="settings-keyvals">
            <div>
              <dt>Font family</dt>
              <dd>Lilex Nerd Font</dd>
            </div>
            <div>
              <dt>Reduce motion</dt>
              <dd>Follows OS setting</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-defaults">
        <header className="settings-section-header">
          <h2 id="settings-defaults">Defaults</h2>
          <p>Pick the model that pre-fills the launcher when you start a new session.</p>
        </header>
        <div className="settings-card">
          <div className="settings-row">
            <label htmlFor="settings-default-model">Default model</label>
            <CombinedModelSelector
              ariaLabel="Default model"
              value={defaultModel}
              onChange={onDefaultModelChange}
            />
          </div>
          <dl className="settings-keyvals">
            <div>
              <dt>Worktree base</dt>
              <dd>Configured per project</dd>
            </div>
            <div>
              <dt>Setup &amp; check commands</dt>
              <dd>Configured per project</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-about">
        <header className="settings-section-header">
          <h2 id="settings-about">About</h2>
        </header>
        <div className="settings-card">
          <dl className="settings-keyvals">
            <div>
              <dt>App</dt>
              <dd>Maestro</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>Electron · single-user local</dd>
            </div>
            <div>
              <dt>Providers</dt>
              <dd>Claude Code · Codex</dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
}

function EmptyState({ message, onRetry }: { message?: string | null; onRetry?: () => void }): JSX.Element {
  return (
    <section className="empty-state">
      <AlertTriangle size={24} />
      <h2>Local state could not be loaded</h2>
      <p>
        {message ??
          "Maestro keeps working from local storage, but the database needs attention before the dashboard can render."}
      </p>
      {onRetry ? (
        <button className="empty-state-retry" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </section>
  );
}

async function loadDashboardSnapshot(): Promise<DashboardSnapshot> {
  if (!window.maestro) {
    return demoSnapshot;
  }

  const snapshot = await window.maestro.dashboard.load();
  return { ...snapshot, events: pruneSupersededDeltas(snapshot.events) };
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine || "Local agent task";
}

function providerLabel(provider: ProviderId): string {
  return provider === "codex" ? "Codex" : "Claude";
}

function repoNameFromPath(path: string | null | undefined): string | null {
  const trimmedPath = path?.replace(/\/+$/, "") ?? "";
  return trimmedPath.split("/").at(-1) || null;
}

/**
 * Returns the partial skill name when the input is a slash command being
 * composed (no whitespace yet), otherwise null. The popover only opens on
 * `/<name>` shapes; once the user adds a space (typing args) the popover
 * stays closed.
 */
function parseSlashQuery(input: string): { query: string } | null {
  if (!input.startsWith("/")) {
    return null;
  }
  const rest = input.slice(1);
  if (/\s/.test(rest)) {
    return null;
  }
  return { query: rest };
}

interface UseSlashAutocompleteArgs {
  input: string;
  setInput: (value: string) => void;
  provider: ProviderId | null;
  workspaceId: string | null;
}

interface SlashAutocompleteState {
  popoverOpen: boolean;
  filteredSkills: SkillSummary[];
  selectionIndex: number;
  setSelectionIndex: (index: number) => void;
  selectSkill: (name: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

function useSlashAutocomplete({
  input,
  setInput,
  provider,
  workspaceId
}: UseSlashAutocompleteArgs): SlashAutocompleteState {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectionIndex, setSelectionIndex] = useState(0);
  const fetchedFor = useRef<string | null>(null);
  const slashQuery = parseSlashQuery(input);

  useEffect(() => {
    if (!slashQuery || !provider) {
      return;
    }
    const cacheKey = `${provider}::${workspaceId ?? ""}`;
    if (fetchedFor.current === cacheKey) {
      return;
    }
    fetchedFor.current = cacheKey;
    let cancelled = false;
    const api = window.maestro?.skills;
    if (!api?.list) {
      return;
    }
    void api
      .list(workspaceId ? { provider, workspaceId } : { provider })
      .then((result) => {
        if (!cancelled) {
          setSkills(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSkills([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slashQuery, provider, workspaceId]);

  const filteredSkills = useMemo(() => {
    if (!slashQuery) {
      return [] as SkillSummary[];
    }
    const needle = slashQuery.query.toLowerCase();
    if (!needle) {
      return skills;
    }
    return skills.filter((skill) => skill.name.toLowerCase().includes(needle));
  }, [skills, slashQuery]);

  const popoverOpen = slashQuery !== null && filteredSkills.length > 0;

  useEffect(() => {
    if (selectionIndex >= filteredSkills.length) {
      setSelectionIndex(0);
    }
  }, [filteredSkills.length, selectionIndex]);

  const selectSkill = (name: string): void => {
    setInput(`/${name} `);
    setSelectionIndex(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (!popoverOpen) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectionIndex((selectionIndex + 1) % filteredSkills.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectionIndex((selectionIndex - 1 + filteredSkills.length) % filteredSkills.length);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const choice = filteredSkills[selectionIndex];
      if (choice) {
        event.preventDefault();
        selectSkill(choice.name);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setInput("");
      setSelectionIndex(0);
    }
  };

  return { popoverOpen, filteredSkills, selectionIndex, setSelectionIndex, selectSkill, onKeyDown };
}

function SkillPopover({
  state,
  inputRef
}: {
  state: SlashAutocompleteState;
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}): JSX.Element | null {
  if (!state.popoverOpen) {
    return null;
  }
  return (
    <ul className="skill-popover" id="skill-popover" role="listbox" aria-label="Skill suggestions">
      {state.filteredSkills.map((skill, index) => (
        <li
          key={skill.name}
          role="option"
          aria-selected={index === state.selectionIndex}
          className={`skill-option${index === state.selectionIndex ? " is-selected" : ""}`}
          onMouseDown={(event) => {
            event.preventDefault();
            state.setSelectionIndex(index);
            state.selectSkill(skill.name);
            inputRef.current?.focus();
          }}
        >
          <span className="skill-option-name">/{skill.name}</span>
          {skill.description ? <span className="skill-option-description">{skill.description}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function ModelSelector({
  ariaLabel,
  onChange,
  provider,
  value
}: {
  ariaLabel: string;
  onChange: (model: ProviderModelSelection) => void;
  provider: ProviderId;
  value: ProviderModelSelection;
}): JSX.Element {
  const models = PROVIDER_MODELS[provider];
  const fallbackKey = models[0] ? optionKey(models[0]) : "";
  const matchedKey = models.find(
    (model) => model.modelId === value.modelId && model.reasoningEffort === value.reasoningEffort
  );
  const selectedValue = matchedKey ? optionKey(matchedKey) : fallbackKey;

  return (
    <span className="model-selector">
      <select
        aria-label={ariaLabel}
        value={selectedValue}
        onChange={(event) => {
          const model = models.find((option) => optionKey(option) === event.target.value);
          if (model) {
            onChange({
              label: model.label,
              modelId: model.modelId,
              ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
            });
          }
        }}
      >
        {models.map((model) => (
          <option key={optionKey(model)} value={optionKey(model)}>
            {model.reasoningEffort ? `${model.label} · ${effortLabel(model.reasoningEffort)}` : model.label}
          </option>
        ))}
      </select>
    </span>
  );
}

function CombinedModelSelector({
  ariaLabel,
  onChange,
  value
}: {
  ariaLabel: string;
  onChange: (model: ModelPickerSelection) => void;
  value: ModelPickerSelection;
}): JSX.Element {
  const fallbackKey = allModelOptions[0] ? modelValue(allModelOptions[0]) : "";
  const matched = allModelOptions.find(
    (model) =>
      model.provider === value.provider &&
      model.modelId === value.modelId &&
      model.reasoningEffort === value.reasoningEffort
  );
  const selectedValue = matched ? modelValue(matched) : fallbackKey;

  return (
    <span className="model-selector model-selector-combined">
      <select
        aria-label={ariaLabel}
        value={selectedValue}
        onChange={(event) => {
          const model = allModelOptions.find((option) => modelValue(option) === event.target.value);
          if (model) {
            onChange(model);
          }
        }}
      >
        <optgroup label="Codex">
          {PROVIDER_MODELS.codex.map((model) => (
            <option key={optionKey(model)} value={modelValue({ provider: "codex", ...model })}>
              {model.reasoningEffort ? `${model.label} · ${effortLabel(model.reasoningEffort)}` : model.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Claude">
          {PROVIDER_MODELS.claude.map((model) => (
            <option key={optionKey(model)} value={modelValue({ provider: "claude", ...model })}>
              {model.label}
            </option>
          ))}
        </optgroup>
      </select>
    </span>
  );
}

function modelValue(model: Pick<ModelPickerSelection, "provider" | "modelId" | "reasoningEffort">): string {
  return model.reasoningEffort
    ? `${model.provider}:${model.modelId}:${model.reasoningEffort}`
    : `${model.provider}:${model.modelId}`;
}

function optionKey(model: Pick<ProviderModelSelection, "modelId" | "reasoningEffort">): string {
  return model.reasoningEffort ? `${model.modelId}:${model.reasoningEffort}` : model.modelId;
}

function effortLabel(reasoningEffort: NonNullable<ProviderModelSelection["reasoningEffort"]>): string {
  return `${reasoningEffort[0]?.toUpperCase() ?? ""}${reasoningEffort.slice(1)}`;
}

function modelDefaultForProvider(provider: ProviderId): ProviderModelSelection {
  const model = PROVIDER_MODEL_DEFAULTS[provider];
  return {
    label: model.label,
    modelId: model.modelId,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
  };
}

function modelSelectionFromSession(session: SessionSummary | null): ProviderModelSelection {
  if (!session) {
    return modelDefaultForProvider("codex");
  }
  return {
    label: session.modelLabel,
    modelId: session.modelId,
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {})
  };
}

function buildTerminalTranscript(rawOutputs: RawProviderOutput[], sessionId: string | null): string {
  if (!sessionId) {
    return "";
  }

  // Stream-json events can be split across multiple raw output chunks; concatenate
  // first so the JSON-line filter sees whole lines and hides them properly.
  const combined = rawOutputs
    .filter((output) => output.sessionId === sessionId && ["stdout", "stderr"].includes(output.stream))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((output) => stripTerminalControls(output.content))
    .join("");

  const transcript = visibleRawProviderLines(combined).join("").trim();

  return transcript.length > 8_000 ? transcript.slice(-8_000) : transcript;
}

function visibleRawProviderLines(content: string): string[] {
  return content
    .split(/(\r?\n)/)
    .filter((part) => part === "\n" || part === "\r\n" || !isHiddenRawProviderLine(part.trim()));
}

function isHiddenRawProviderLine(line: string): boolean {
  const record = tryParseJsonObject(line);
  return record !== null && typeof record.type === "string";
}

function mergeSlice<T extends { id: string }>(
  current: T[],
  updates: T[] | undefined,
  sortBy: (item: T) => string,
  limit?: number
): T[] {
  if (!updates) {
    return current;
  }
  const merged = upsertById(current, updates);
  if (merged === current) {
    return current;
  }
  const sorted = sortByTimestamp(merged, sortBy);
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}

/**
 * Drops message.delta events that have a subsequent message.completed within
 * the same turn. A streaming response can produce hundreds of deltas; if we
 * keep them in renderer state they crowd out command.started/completed pairs
 * under the event cap, and tool calls vanish from the UI once the response
 * finishes. We still keep the latest deltas (no completion yet) so live
 * streaming continues to render.
 *
 * Events may arrive in any order; this works on either ascending or descending
 * arrays.
 */
function pruneSupersededDeltas(events: TimelineEvent[]): TimelineEvent[] {
  if (events.length < 2) return events;
  const first = events[0];
  const last = events[events.length - 1];
  const isDescending = !!first && !!last && first.createdAt > last.createdAt;
  const ascending = isDescending ? [...events].reverse() : events;
  const kept: TimelineEvent[] = [];
  for (let i = 0; i < ascending.length; i++) {
    const event = ascending[i];
    if (!event) continue;
    if (event.type !== "message.delta") {
      kept.push(event);
      continue;
    }
    let superseded = false;
    for (let j = i + 1; j < ascending.length; j++) {
      const next = ascending[j];
      if (!next) break;
      if (next.type === "user.message") break;
      if (next.type === "message.completed") {
        superseded = true;
        break;
      }
    }
    if (!superseded) kept.push(event);
  }
  return isDescending ? kept.reverse() : kept;
}

function mergeDashboardDelta(snapshot: DashboardSnapshot, delta: DashboardDelta): DashboardSnapshot {
  const projects = delta.projects
    ? (() => {
        const merged = upsertById(snapshot.projects, delta.projects);
        return merged === snapshot.projects ? snapshot.projects : sortProjects(merged);
      })()
    : snapshot.projects;
  const workspaces = mergeSlice(snapshot.workspaces, delta.workspaces, (workspace) => workspace.lastActivityAt);
  const sessions = mergeSlice(snapshot.sessions, delta.sessions, (session) => session.lastActivityAt);
  const events = pruneSupersededDeltas(
    mergeSlice(snapshot.events, delta.events, (event) => event.createdAt, 500)
  );
  const rawOutputs = mergeSlice(snapshot.rawOutputs, delta.rawOutputs, (output) => output.createdAt, 100);
  const approvals = mergeSlice(snapshot.approvals, delta.approvals, (approval) => approval.createdAt, 200);
  const checks = mergeSlice(snapshot.checks, delta.checks, (check) => check.startedAt, 200);
  const checkpoints = mergeSlice(snapshot.checkpoints, delta.checkpoints, (checkpoint) => checkpoint.createdAt, 200);

  if (
    projects === snapshot.projects &&
    workspaces === snapshot.workspaces &&
    sessions === snapshot.sessions &&
    events === snapshot.events &&
    rawOutputs === snapshot.rawOutputs &&
    approvals === snapshot.approvals &&
    checks === snapshot.checks &&
    checkpoints === snapshot.checkpoints
  ) {
    return snapshot;
  }

  return { projects, workspaces, sessions, events, rawOutputs, approvals, checks, checkpoints };
}

function upsertById<T extends { id: string }>(current: T[], updates: T[]): T[] {
  if (updates.length === 0) {
    return current;
  }
  const byId = new Map(current.map((item) => [item.id, item]));
  let changed = false;
  for (const item of updates) {
    if (byId.get(item.id) !== item) {
      changed = true;
      byId.set(item.id, item);
    }
  }
  return changed ? [...byId.values()] : current;
}

function mergeByCreatedAt<T extends { id: string; createdAt: string }>(
  current: T[],
  updates: T[],
  limit: number,
  direction: "asc" | "desc"
): T[] {
  const sorted = upsertById(current, updates).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const limited = sorted.slice(-limit);
  return direction === "asc" ? limited : limited.reverse();
}

function sortProjects(projects: DashboardSnapshot["projects"]): DashboardSnapshot["projects"] {
  return sortByTimestamp(projects, (project) => project.latestActivityAt ?? "");
}

function sortByTimestamp<T>(items: T[], getTimestamp: (item: T) => string): T[] {
  return [...items].sort((left, right) => getTimestamp(right).localeCompare(getTimestamp(left)));
}

function isBrowserPreview(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return ["127.0.0.1", "localhost"].includes(window.location.hostname);
}
