import {
  ArrowRight,
  Bot,
  Cloud,
  Folder,
  FolderGit2,
  GitBranch,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Play,
  PlugZap,
  Plus,
  Target,
  X
} from "lucide-react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import {
  SCRATCH_PROJECT_ID,
  type AgentMode,
  type ComposerAttachment,
  type ProjectSummary,
  type WorkspaceSummary
} from "../../shared/types.js";
import { PROVIDER_DISPLAY_NAMES } from "../../shared/providerModels.js";
import {
  cloudProviderName,
  isHostedCloudProvider,
  type HostedCloudProvider
} from "../../shared/cloudProviders.js";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import { errorMessage } from "../../shared/error.js";
import {
  appendReferencesToPrompt,
  imageAttachmentReference
} from "../lib/composerAttachments.js";
import { clearDraft, launcherDraftKey, readDraft } from "../lib/composerDrafts.js";
import { parseGoalCommand } from "../lib/goalCommand.js";
import { splitSkillTokens } from "../lib/slashHighlight.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useProviderAvailability } from "../hooks/useProviderAvailability.js";
import { useComposerAttachments } from "../hooks/useComposerAttachments.js";
import { useComposerDraft } from "../hooks/useComposerDraft.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useFileAutocomplete } from "../hooks/useFileAutocomplete.js";
import { useProjectCheckoutTerminal } from "../hooks/useProjectCheckoutTerminal.js";
import { useReviewState, type ReviewSource } from "../hooks/useReviewState.js";
import {
  PICKER_MENU_EDGE_PADDING_PX,
  PICKER_MENU_MAX_HEIGHT_PX,
  useAnchoredPopover
} from "../hooks/useAnchoredPopover.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import { useTypeToFilter } from "../hooks/useTypeToFilter.js";
import { LAUNCHER_TITLE, SIDE_CHAT_PLACEHOLDER, SIDE_CHAT_TITLE } from "../lib/launcherTitle.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import type { FontSize } from "../lib/fonts.js";
import {
  persistLaunchProjectId,
  sortProjectsByLaunchRecency
} from "../lib/launchProjectPreference.js";
import { preferredLaunchModel, type ModelPickerSelection } from "../lib/models.js";
import {
  LAUNCHER_MODE_LABELS,
  cycleLauncherMode,
  launcherModeTitle,
  type LauncherMode
} from "../lib/agentMode.js";
import { isMcpCommand, type ComposerCommand } from "../lib/composerCommands.js";
import {
  readStoredWorkspaceMode,
  toggleWorkspaceMode,
  writeWorkspaceMode,
  type WorkspaceMode
} from "../lib/workspaceMode.js";
import { CloudTaskDialog } from "./CloudTaskDialog.js";
import { ConnectionDialog } from "./ConnectionDialog.js";
import { PickerFilterRow } from "./PickerFilterRow.js";
import { PickerLead } from "./PickerLead.js";
import { collapseHome } from "../lib/pathDisplay.js";
import { importChunk } from "../lib/importChunk.js";
import { LaunchModelSelector } from "./ModelSelector.js";
import { Mascot, type MascotMood } from "./Mascot.js";
// ReviewPanel pulls in shiki + diff utilities — heavy and only needed when
// the right-side review pane is open. Lazy-mounted (ralph B4) so the
// launcher's first paint doesn't ship the highlighter.
const ReviewPanel = lazy(() =>
  importChunk(async () => ({
    default: (await import("./ReviewPanel.js")).ReviewPanel
  }))
);
import { FilePopover } from "./FilePopover.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { SkeletonPane } from "./SkeletonPane.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";
// WelcomePane only renders on a fresh install (no projects) — lazy-mounted
// (ralph B2) so its provider-discovery code path doesn't ship in the main
// launcher bundle for the common case.
const WelcomePane = lazy(() =>
  importChunk(async () => ({
    default: (await import("./WelcomePane.js")).WelcomePane
  }))
);

const PROMPT_MAX_HEIGHT_PX = 168;

// The fox dozes off after a long untouched stretch and wakes on the first
// keystroke, click, or focus inside the surface. Ten pets in a row — each
// within PET_STREAK_GAP_MS of the last — earn the sunglasses.
const DOZE_AFTER_MS = 90_000;
const PET_STREAK_GAP_MS = 3_000;
const PETS_FOR_SHADES = 10;

/** The folder a repository sits in ("~/dev/menti"): the project row's trailing
 *  column, so two checkouts of the same repository read apart. */
function parentFolderLabel(repoPath: string): string {
  const parent = collapseHome(repoPath).replace(/\/+$/, "").replace(/\/[^/]*$/, "");
  return parent || "/";
}

function isOptionButtonTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button.project-picker-item") !== null;
}

export function LaunchSurface({
  claimsBrowserRequests = false,
  isFocused = true,
  fastModeEnabled = false,
  goalEnabled = true,
  hasRunningSession = false,
  chatFontSize,
  model,
  onAddProject,
  onBranchSwitch,
  onFastModeEnabledChange,
  onLaunchTask,
  onLaunchSideChat,
  onModelChange,
  onSelectProject,
  onSideChatModeChange,
  project,
  projects,
  resetSignal,
  rightPanelToggleSignal,
  registerPaletteFileContext,
  sideChatMode = false,
  workspaces = [],
  onCheckoutWorkspaceCreated
}: {
  /** True when this launcher is the only surface on screen, so chat links and
   *  the actions menu have nowhere else to open the browser. False for a
   *  launcher cell sharing the grid with session panes. */
  claimsBrowserRequests?: boolean;
  isFocused?: boolean;
  fastModeEnabled?: boolean;
  goalEnabled?: boolean;
  /** True while an agent is running in this launcher's project. The hero fox
   *  stays awake rather than dozing. */
  hasRunningSession?: boolean;
  /** Settings → Appearance: keep the launcher's composer on the agent-window scale. */
  chatFontSize?: FontSize;
  model: ModelPickerSelection;
  onAddProject: () => void;
  onBranchSwitch: (updated: ProjectSummary) => void;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onLaunchTask: (
    prompt: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    workspaceMode: WorkspaceMode,
    attachments?: ComposerAttachment[],
    goalCondition?: string
  ) => Promise<void>;
  onLaunchSideChat?: (
    prompt: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[],
    goalCondition?: string
  ) => Promise<void>;
  onModelChange: (model: ModelPickerSelection) => void;
  onSelectProject: (id: string) => void;
  onSideChatModeChange?: (active: boolean) => void;
  project: ProjectSummary | null;
  projects: ProjectSummary[];
  resetSignal?: number;
  rightPanelToggleSignal?: number;
  registerPaletteFileContext?: (
    context: { source: { kind: "workspace" | "project"; id: string }; onPick: (path: string) => void } | null
  ) => void;
  sideChatMode?: boolean;
  /** Workspaces from the dashboard snapshot — used to resolve the checkout
   *  row that backs the launcher's Terminal tab. */
  workspaces?: readonly WorkspaceSummary[];
  onCheckoutWorkspaceCreated?: (workspace: WorkspaceSummary) => void;
}): JSX.Element {
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  // Side chat is the repo-less flavor of this surface: same composer and
  // model picker, but no project, branch, worktree, or review chrome. The
  // selected project stays untouched behind the mode so switching back is
  // instant; every repo-coupled hook below reads `activeProject` instead of
  // `project` so chat mode disables them without unmounting the surface.
  const chatMode = sideChatMode && onLaunchSideChat !== undefined;
  const [cloudSelected, setCloudSelected] = useState(false);
  const cloudProvider = isHostedCloudProvider(model.provider) ? model.provider : null;
  const cloudMode = cloudSelected && !chatMode && cloudProvider !== null;
  useEffect(() => {
    if (chatMode || !isHostedCloudProvider(model.provider)) setCloudSelected(false);
  }, [chatMode, model.provider]);
  const [cloudDraft, setCloudDraft] = useState<{
    projectId: string;
    provider: HostedCloudProvider;
    brief: string;
  } | null>(null);
  const activeProject = chatMode ? null : project;
  // The unsent prompt and its screenshots belong to the project they will be
  // launched in, not to the mounted launcher: a grid cell that retargets its
  // repo remounts, and the full launcher outlives an app restart. Side-chat
  // drafts get their own stable key under the hidden scratch project.
  const draftKey = chatMode
    ? launcherDraftKey(SCRATCH_PROJECT_ID)
    : project
      ? launcherDraftKey(project.id)
      : null;
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Picking another project from the context picker is how the user aims a
  // prompt they are still writing, so the text follows the pick. Switching
  // to Chat uses the same carry so the draft survives the retarget.
  const [prompt, setPrompt, promptCarriedOnRetarget] = useComposerDraft(draftKey, {
    carryTextOnRetarget: true,
    persist: !isSubmitting
  });
  const {
    pendingAttachments,
    pendingAttachmentPreviews,
    isDraggingFiles,
    attachmentInputRef,
    removePendingAttachment,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    onComposerPaste,
    onAttachmentInputChange,
    openFilePicker,
    clearAttachments
  } = useComposerAttachments({
    draftKey,
    workspacePath: activeProject?.repoPath ?? null,
    setInput: setPrompt,
    setStatus,
    carriedOnRetarget: promptCarriedOnRetarget,
    persist: !isSubmitting
  });
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(readStoredWorkspaceMode);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const [compactContextOpen, setCompactContextOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const compactContextRef = useRef<HTMLDivElement | null>(null);

  // Provider discovery for the model picker. Non-blocking: fires after mount
  // (cached in Rust, so the cold-launch path pays nothing extra) and the picker
  // stays optimistic — every model enabled — until it resolves. Used to disable
  // uninstalled providers and annotate ones that need login.
  const { availability: providerAvailability, discovered: discoveredProviders } = useProviderAvailability();

  // If the pre-filled selection points at a provider that isn't usable — CLI
  // not installed, or installed but not logged in — steer to the highest-
  // priority usable provider's default (Claude → Codex → Cursor → OpenCode,
  // else Big Pickle) so the composer isn't stuck on an unlaunchable pick.
  // Skip an empty discovery result: that is "we learned nothing", not "nothing
  // is installed", and must not overwrite the factory seed. Runs once when
  // discovery resolves; picks the user makes afterwards are never overridden.
  const providerSteeringDone = useRef(false);
  const surfaceReady = chatMode || project !== null;
  useEffect(() => {
    if (!surfaceReady || !discoveredProviders || discoveredProviders.length === 0 || providerSteeringDone.current) {
      return;
    }
    providerSteeringDone.current = true;
    const current = discoveredProviders.find((entry) => entry.provider === model.provider);
    if (current?.installed && current.authenticated !== false) return;
    const preferred = preferredLaunchModel(discoveredProviders);
    if (preferred.provider === model.provider && preferred.modelId === model.modelId) return;
    onModelChange(preferred);
  }, [surfaceReady, discoveredProviders, model.provider, model.modelId, onModelChange]);

  // Changes + Files panel against the selected project's main checkout. Lets
  // the user inspect and edit files before starting a session. Cmd/Ctrl+B
  // toggles it (same shortcut as inside a session); no menu icon today, just
  // the keyboard shortcut.
  const reviewSource = useMemo<ReviewSource | null>(
    () => (activeProject ? { kind: "project", project: activeProject } : null),
    [activeProject]
  );
  const onWorkspaceCreated = useCallback(
    (workspace: WorkspaceSummary): void => {
      onCheckoutWorkspaceCreated?.(workspace);
    },
    [onCheckoutWorkspaceCreated]
  );
  const { terminalWorkspaceId, ensureCheckoutWorkspace } = useProjectCheckoutTerminal(
    activeProject,
    workspaces,
    onWorkspaceCreated
  );
  const reviewState = useReviewState(reviewSource, null, {
    claimsBrowserRequests,
    terminalWorkspaceId
  });
  const reviewOpenPanelInFilesMode = reviewState.openPanelInFilesMode;
  const reviewOpenInFilesView = reviewState.openInFilesView;
  const reviewClosePanel = reviewState.closePanel;
  const reviewIsPanelOpen = reviewState.isPanelOpen;
  const reviewModes = reviewState.layout.modes;
  const reviewClosePane = reviewState.closePane;
  const reviewOpenBrowser = reviewState.openBrowser;
  const lastResetSignal = useRef(resetSignal);
  const lastRightPanelToggleSignal = useRef(rightPanelToggleSignal);

  useEffect(() => {
    if (!reviewState.isPanelOpen || !activeProject) return;
    void ensureCheckoutWorkspace();
  }, [activeProject, ensureCheckoutWorkspace, reviewState.isPanelOpen]);

  // Register this surface's file source + pick handler with App so the
  // command palette can surface project files in its Files group. Cleared
  // on unmount or when no project is selected.
  useEffect(() => {
    if (!registerPaletteFileContext) return undefined;
    if (!activeProject) {
      registerPaletteFileContext(null);
      return () => registerPaletteFileContext(null);
    }
    registerPaletteFileContext({
      source: { kind: "project", id: activeProject.id },
      onPick: reviewOpenInFilesView
    });
    return () => registerPaletteFileContext(null);
  }, [activeProject, registerPaletteFileContext, reviewOpenInFilesView]);
  const toggleReviewPanel = useCallback((): void => {
    if (reviewIsPanelOpen) {
      reviewClosePanel();
    } else {
      reviewOpenPanelInFilesMode();
    }
  }, [reviewClosePanel, reviewIsPanelOpen, reviewOpenPanelInFilesMode]);

  useEffect(() => {
    if (!activeProject) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        toggleReviewPanel();
        return;
      }
      if (key === "g") {
        event.preventDefault();
        if (reviewIsPanelOpen && reviewModes.includes("files")) {
          reviewClosePane(reviewModes[0] === "files" ? 0 : 1);
        } else {
          reviewOpenPanelInFilesMode();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeProject, reviewClosePane, reviewIsPanelOpen, reviewModes, reviewOpenPanelInFilesMode, toggleReviewPanel]);

  // ⌘⇧M, ⌘⇧E and ⌘⇧R open the model, effort and folder pickers and ⌘⇧I
  // toggles the browser. Only the focused launcher answers, and the folder
  // picker exists only on the task launcher: a side chat has no project to
  // switch.
  const supportsEffort = model.reasoningEffort != null;
  useEffect(() => {
    if (!isFocused) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.isComposing || event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === "m" && !cloudMode) {
        event.preventDefault();
        setProjectPickerOpen(false);
        setBranchPickerOpen(false);
        setEffortPickerOpen(false);
        setModelPickerOpen((open) => !open);
        return;
      }
      if (key === "e" && supportsEffort && !cloudMode) {
        event.preventDefault();
        setProjectPickerOpen(false);
        setBranchPickerOpen(false);
        setModelPickerOpen(false);
        setEffortPickerOpen((open) => !open);
        return;
      }
      if (key === "r" && !chatMode) {
        event.preventDefault();
        setBranchPickerOpen(false);
        setModelPickerOpen(false);
        setEffortPickerOpen(false);
        // Narrow, the folder chip folds behind the "…" and its list only
        // shows inside the open compact panel, so unfold first.
        const compactTrigger = compactContextRef.current?.querySelector<HTMLElement>(
          ".composer-compact-context-trigger"
        );
        if (compactTrigger?.offsetParent) setCompactContextOpen(true);
        setProjectPickerOpen((open) => !open);
        return;
      }
      if (key === "i" && window.argmax?.browser) {
        event.preventDefault();
        if (reviewIsPanelOpen && reviewModes.includes("browser")) {
          reviewClosePane(reviewModes[0] === "browser" ? 0 : 1);
        } else {
          reviewOpenBrowser();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [chatMode, cloudMode, isFocused, reviewClosePane, reviewIsPanelOpen, reviewModes, reviewOpenBrowser, supportsEffort]);

  useEffect(() => {
    if (resetSignal === lastResetSignal.current) return;
    lastResetSignal.current = resetSignal;
    setCloudSelected(false);
    reviewClosePanel();
    if (draftKey) setPrompt(readDraft(draftKey).text);
  }, [draftKey, resetSignal, reviewClosePanel, setPrompt]);

  useEffect(() => {
    if (rightPanelToggleSignal === lastRightPanelToggleSignal.current) return;
    lastRightPanelToggleSignal.current = rightPanelToggleSignal;
    if (!activeProject) return;
    toggleReviewPanel();
  }, [activeProject, rightPanelToggleSignal, toggleReviewPanel]);

  useEffect(() => {
    if (!activeProject || !reviewIsPanelOpen) return undefined;
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      reviewClosePanel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeProject, reviewClosePanel, reviewIsPanelOpen]);

  // The launcher composer sits mid-viewport. A menu that only knows "open
  // downward, at most 440px" runs off the bottom of .work-scroll; the clipped
  // list's wheel then scrolls that ancestor. Stay below the chip — flipping
  // would put this menu above the composer while the model menu dropped the
  // other way — and cap to the room actually left. Stay in the anchor's
  // stacking context too: a body portal paints under the dismiss layer.
  const projectPopover = useAnchoredPopover({
    open: projectPickerOpen,
    placement: "bottom-start",
    flip: false,
    strategy: "absolute",
    capHeight: true,
    edgePadding: PICKER_MENU_EDGE_PADDING_PX,
    maxHeight: PICKER_MENU_MAX_HEIGHT_PX
  });
  const branchPopover = useAnchoredPopover({
    open: branchPickerOpen,
    placement: "bottom-start",
    flip: false,
    strategy: "absolute",
    capHeight: true,
    edgePadding: PICKER_MENU_EDGE_PADDING_PX,
    maxHeight: PICKER_MENU_MAX_HEIGHT_PX
  });
  const {
    setAnchor: setProjectAnchor,
    setPopover: setProjectPopover,
    anchorRef: projectAnchorRef,
    floatingStyles: projectFloatingStyles
  } = projectPopover;
  const {
    setAnchor: setBranchAnchor,
    setPopover: setBranchPopover,
    anchorRef: branchAnchorRef,
    floatingStyles: branchFloatingStyles
  } = branchPopover;
  useDismissOnOutsideOrEscape(projectAnchorRef, projectPickerOpen, () => setProjectPickerOpen(false));
  useDismissOnOutsideOrEscape(branchAnchorRef, branchPickerOpen, () => setBranchPickerOpen(false));
  useDismissOnOutsideOrEscape(compactContextRef, compactContextOpen, () => setCompactContextOpen(false));
  const anyContextPickerOpen = projectPickerOpen || branchPickerOpen || modelPickerOpen;

  const closeContextPickers = useCallback((): void => {
    setProjectPickerOpen(false);
    setBranchPickerOpen(false);
    setModelPickerOpen(false);
    setCompactContextOpen(false);
  }, []);

  const chatAvailable = Boolean(onLaunchSideChat && onSideChatModeChange);
  const launcherMode: LauncherMode = chatMode ? "chat" : "auto";

  const toggleMode = useCallback((): void => {
    setCloudSelected(false);
    const next = cycleLauncherMode(launcherMode, chatAvailable);
    if (next === "chat") {
      closeContextPickers();
      onSideChatModeChange?.(true);
      return;
    }
    onSideChatModeChange?.(false);
  }, [chatAvailable, closeContextPickers, launcherMode, onSideChatModeChange]);

  const toggleWorkspace = useCallback((): void => {
    setWorkspaceMode((mode) => {
      const next = toggleWorkspaceMode(mode);
      writeWorkspaceMode(next);
      return next;
    });
  }, []);

  // The persisted current branch goes stale when the user checks out a
  // different branch outside Argmax (e.g. in a terminal). Re-read the repo's
  // live HEAD when the launcher mounts or the project changes so the branch
  // chip — and the shared workspace a launch forks from — track what's actually
  // checked out. Keyed on id + branch (not the whole project) so unrelated
  // dashboard deltas don't trigger a git shellout; only pushes an update when
  // the branch actually moved.
  const projectId = activeProject?.id ?? null;
  const knownBranch = activeProject?.currentBranch ?? null;
  useEffect(() => {
    if (!window.argmax || !projectId) return undefined;
    let cancelled = false;
    void window.argmax.projects
      .refreshBranch(projectId)
      .then((updated) => {
        if (cancelled || updated.currentBranch === knownBranch) return;
        onBranchSwitch(updated);
      })
      .catch(() => {
        // Best-effort refresh; a transient git failure leaves the persisted
        // branch in place rather than surfacing an error on the launcher.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, knownBranch, onBranchSwitch]);

  const openBranchPicker = useCallback(async (): Promise<void> => {
    if (!window.argmax || !activeProject) return;
    setStatus(null);
    try {
      const list = await window.argmax.projects.listBranches(activeProject.id);
      setBranches(list);
      setBranchPickerOpen(true);
    } catch (error) {
      setBranchPickerOpen(false);
      setStatus(errorMessage(error) || "Could not load branches.");
    }
  }, [activeProject]);

  const switchBranch = useCallback(async (branch: string): Promise<void> => {
    if (!window.argmax || !activeProject) return;
    setBranchPickerOpen(false);
    setCompactContextOpen(false);
    if (branch === activeProject.currentBranch) return;
    setStatus(null);
    try {
      const updated = await window.argmax.projects.switchBranch(activeProject.id, branch);
      onBranchSwitch(updated);
    } catch (error) {
      setStatus(errorMessage(error) || "Could not switch branch.");
      if (isFocusedRef.current) promptInputRef.current?.focus();
    }
  }, [activeProject, onBranchSwitch]);
  // Typing into an open picker filters it through useTypeToFilter. The lists take
  // focus while open, so characters land here instead of in the prompt behind.
  const projectListRef = useRef<HTMLUListElement | null>(null);
  const branchListRef = useRef<HTMLUListElement | null>(null);
  // One node is both the positioned menu and the list useTypeToFilter focuses.
  // A fresh inline ref would detach and reattach every render.
  const setProjectListNode = useCallback((node: HTMLUListElement | null): void => {
    projectListRef.current = node;
    setProjectPopover(node);
  }, [setProjectPopover]);
  const setBranchListNode = useCallback((node: HTMLUListElement | null): void => {
    branchListRef.current = node;
    setBranchPopover(node);
  }, [setBranchPopover]);
  const pickProject = useCallback(
    (candidate: ProjectSummary): void => {
      persistLaunchProjectId(candidate.id);
      onSideChatModeChange?.(false);
      onSelectProject(candidate.id);
      setProjectPickerOpen(false);
      setCompactContextOpen(false);
    },
    [onSelectProject, onSideChatModeChange]
  );
  const orderedProjects = sortProjectsByLaunchRecency(projects);
  const selectedProjectIndex = orderedProjects.findIndex((candidate) => candidate.id === project?.id);
  const projectFilter = useTypeToFilter({
    open: projectPickerOpen,
    items: orderedProjects,
    toLabel: (candidate: ProjectSummary) => candidate.name,
    listRef: projectListRef,
    initialIndex: selectedProjectIndex >= 0 ? selectedProjectIndex : 0,
    onPick: pickProject
  });
  const selectedBranchIndex = project ? branches.findIndex((b) => b === project.currentBranch) : -1;
  const branchFilter = useTypeToFilter({
    open: branchPickerOpen,
    items: branches,
    toLabel: (branch: string) => branch,
    listRef: branchListRef,
    initialIndex: selectedBranchIndex >= 0 ? selectedBranchIndex : 0,
    onPick: (branch: string) => void switchBranch(branch)
  });

  const placeholderText = chatMode
    ? SIDE_CHAT_PLACEHOLDER
    : "Ask your agent to inspect, build, or fix something";
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  useAutoGrowTextArea(promptInputRef, prompt, PROMPT_MAX_HEIGHT_PX);

  // Read inside the auto-focus effect without widening its deps: whether a
  // picker is open decides nothing about *when* to refocus, only whether to.
  const contextPickerOpenRef = useRef(false);
  contextPickerOpenRef.current = anyContextPickerOpen;

  const wasFocused = useRef(false);
  // Auto-focus the prompt when the launcher is the active surface — on
  // first visit, on project switch, and again whenever the right-side
  // review panel closes, so the user can keep typing without clicking.
  useEffect(() => {
    const becameFocused = isFocused && !wasFocused.current;
    wasFocused.current = isFocused;
    if (!isFocused || (!projectId && !chatMode) || reviewIsPanelOpen || isSubmitting) return;
    // An open picker holds focus to filter keystrokes; a re-render behind it
    // (a dashboard delta re-identifying the project) must not yank that away.
    if (contextPickerOpenRef.current) return;
    const active = document.activeElement;
    if (becameFocused && active !== promptInputRef.current && promptInputRef.current?.closest('[role="region"]')?.contains(active)) return;
    promptInputRef.current?.focus();
    // Metadata refreshes replace the project object even in background cells.
    // Only the active launcher may refocus after its project changes.
  }, [projectId, chatMode, reviewIsPanelOpen, isSubmitting, isFocused]);

  // The hero fox reacts to the user and to real work, never to a clock alone:
  // it thinks while this project has an agent running, and dozes off only once
  // the surface has sat untouched with nothing typed into it.
  const [isDozing, setIsDozing] = useState(false);
  const [wearsShades, setWearsShades] = useState(false);
  const petStreakRef = useRef({ count: 0, lastAt: 0 });
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // A side chat has no repo, so the fox does not watch the project's agents there.
  const watchesAgents = hasRunningSession && !chatMode;
  const canDoze = !watchesAgents && !isSubmitting && prompt.trim() === "";

  useEffect(() => {
    if (!canDoze) {
      setIsDozing(false);
      return;
    }
    // Listeners go on the surface, not the document: a grid can host several
    // launchers, and typing in one must not wake the fox in the next cell.
    const surface = surfaceRef.current;
    let timer = setTimeout(() => setIsDozing(true), DOZE_AFTER_MS);
    const wake = (): void => {
      setIsDozing(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIsDozing(true), DOZE_AFTER_MS);
    };
    surface?.addEventListener("keydown", wake);
    surface?.addEventListener("pointerdown", wake);
    surface?.addEventListener("focusin", wake);
    return () => {
      clearTimeout(timer);
      surface?.removeEventListener("keydown", wake);
      surface?.removeEventListener("pointerdown", wake);
      surface?.removeEventListener("focusin", wake);
    };
  }, [canDoze]);

  const mascotMood: MascotMood = isDozing ? "sleepy" : "idle";

  const petMascot = useCallback((): void => {
    const streak = petStreakRef.current;
    const now = Date.now();
    if (now - streak.lastAt > PET_STREAK_GAP_MS) streak.count = 0;
    streak.count += 1;
    streak.lastAt = now;
    if (streak.count >= PETS_FOR_SHADES) setWearsShades(true);
  }, []);
  // Composer actions offered above the skills in the `/` menu. Each one is a
  // control that already sits in this toolbar — the menu is a keyboard route
  // to them, not a second set of features.
  const launcherCommands = useMemo<ComposerCommand[]>(() => {
    const setMode = (next: LauncherMode) => () => {
      if (next === "chat") {
        closeContextPickers();
        onSideChatModeChange?.(true);
        return;
      }
      onSideChatModeChange?.(false);
    };
    const modes: ComposerCommand[] = [
      {
        name: "auto",
        label: LAUNCHER_MODE_LABELS.auto,
        hint: "Work and approve each step",
        icon: Bot,
        run: setMode("auto")
      }
    ];
    if (chatAvailable) {
      modes.push({
        name: "chat",
        label: LAUNCHER_MODE_LABELS.chat,
        hint: "Don't attach a repository",
        icon: MessageCircle,
        run: setMode("chat")
      });
    }
    const commands = modes.filter((mode) => mode.name !== launcherMode);
    if (goalEnabled) {
      commands.push({
        name: "goal",
        label: "Goal",
        hint: "Keep working until a condition holds",
        icon: Target,
        writesDraft: true,
        run: () => setPrompt("/goal ")
      });
    }
    commands.push({
      name: "mcp",
      label: "Connections",
      hint: "Show MCP servers, plugins, and connectors",
      icon: PlugZap,
      run: () => setConnectionsOpen(true)
    });
    commands.push({
      name: "attach",
      label: "Attach file",
      hint: "Add an image or file to the prompt",
      icon: Paperclip,
      run: openFilePicker
    });
    if (!chatMode) {
      commands.push(
        {
          name: "project",
          label: "Project",
          hint: "Choose the project this task runs in",
          icon: Folder,
          run: () => {
            setCompactContextOpen(true);
            setProjectPickerOpen(true);
          }
        },
        {
          name: "branch",
          label: "Branch",
          hint: `Start from a branch other than ${activeProject?.currentBranch ?? "the current one"}`,
          icon: GitBranch,
          run: () => {
            setCompactContextOpen(true);
            void openBranchPicker();
          }
        },
        {
          name: "worktree",
          label: workspaceMode === "worktree" ? "Worktree off" : "Worktree on",
          hint:
            workspaceMode === "worktree"
              ? "Run in your current checkout instead"
              : "Run in an isolated git worktree on a new branch",
          icon: FolderGit2,
          run: toggleWorkspace
        }
      );
    }
    return commands;
  }, [
    activeProject,
    chatAvailable,
    chatMode,
    closeContextPickers,
    goalEnabled,
    launcherMode,
    onSideChatModeChange,
    openBranchPicker,
    openFilePicker,
    setPrompt,
    toggleWorkspace,
    workspaceMode
  ]);

  const slashAutocomplete = useSlashAutocomplete({
    input: cloudMode ? "" : prompt,
    setInput: setPrompt,
    provider: model.provider,
    workspaceId: null,
    commands: launcherCommands,
    inputRef: promptInputRef
  });

  const fileAutocomplete = useFileAutocomplete({
    input: cloudMode ? "" : prompt,
    setInput: setPrompt,
    inputRef: promptInputRef,
    source: activeProject && !cloudMode ? { kind: "project", id: activeProject.id } : null
  });

  // Same accent tint for `/skill` tokens as the session composer: a mirror
  // div behind a transparent-text textarea (see chat-composer-chips.css).
  const skillHighlight = useMemo(
    () =>
      splitSkillTokens(
        prompt,
        (name) =>
          name === "mcp" ||
          (goalEnabled && name === "goal") ||
          slashAutocomplete.skillNames.has(name)
      ),
    [goalEnabled, prompt, slashAutocomplete.skillNames]
  );
  // The mirror follows the textarea's scroll by transform, not by its own
  // scrollTop: WebKit leaves the div's bottom padding out of its scroll range,
  // so a long prompt scrolled to the end clamped the mirror a line short and
  // the caret sat a line above the text it belongs to. Synced after every
  // render as well, since the mirror mounts into an already-scrolled field.
  const highlightTextRef = useRef<HTMLDivElement | null>(null);
  const syncHighlightScroll = useCallback((): void => {
    const text = highlightTextRef.current;
    const field = promptInputRef.current;
    if (text && field) text.style.transform = `translateY(${-field.scrollTop}px)`;
  }, [promptInputRef]);
  useLayoutEffect(syncHighlightScroll, [skillHighlight, syncHighlightScroll]);

  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    slashAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    fileAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    if (
      event.key === "Tab" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      toggleMode();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const hasSendableContent = prompt.trim().length > 0 || pendingAttachments.length > 0;

  const submitPrompt = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!hasSendableContent || isSubmitting) {
      return;
    }
    if (!cloudMode && isMcpCommand(trimmedPrompt)) {
      setPrompt("");
      if (draftKey) clearDraft(draftKey);
      setConnectionsOpen(true);
      return;
    }

    if (cloudMode) {
      if (!project || !cloudProvider) return;
      if (pendingAttachments.length > 0) {
        setStatus("Cloud tasks support text only. Remove attachments or switch to Local.");
        return;
      }
      if (/^\/goal(?:\s|$)/i.test(trimmedPrompt)) {
        setStatus("Goals run locally. Switch to Local or write a task without /goal.");
        return;
      }
      setStatus(null);
      setCloudDraft({ projectId: project.id, provider: cloudProvider, brief: trimmedPrompt });
      return;
    }

    const goalCommand = goalEnabled ? parseGoalCommand(trimmedPrompt) : null;
    if (goalEnabled && (/^\/goal\s*$/i.test(trimmedPrompt) || goalCommand?.kind === "clear")) {
      setStatus(goalCommand?.kind === "clear"
        ? "There is no goal to clear in a new chat."
        : "Write a completion condition after /goal.");
      return;
    }
    const goalCondition = goalCommand?.kind === "set" ? goalCommand.condition : undefined;
    const openingPrompt = goalCondition ?? trimmedPrompt;
    const refs = pendingAttachments.map((a) => imageAttachmentReference(a.filePath));
    const finalPrompt = refs.length > 0 ? appendReferencesToPrompt(openingPrompt, refs) : openingPrompt;

    setIsSubmitting(true);
    setStatus(null);
    // Drop the stored draft before the first await. Launching unmounts this
    // surface, and a remounted NEW CHAT reads storage: if the entry is still
    // here, the sent prompt comes back. `persist: !isSubmitting` stops the
    // write effect from recreating it while the text stays on screen.
    if (draftKey) clearDraft(draftKey);
    try {
      const attachments = pendingAttachments.length > 0 ? pendingAttachments : undefined;
      if (chatMode && onLaunchSideChat) {
        await onLaunchSideChat(finalPrompt, model, "auto", attachments, goalCondition);
      } else {
        await onLaunchTask(finalPrompt, model, "auto", workspaceMode, attachments, goalCondition);
      }
      setPrompt("");
      clearAttachments();
    } catch (error) {
      setStatus(errorMessage(error) || "Could not start agent.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!project && !chatMode) {
    // Fresh-install surface: setup checklist + provider discovery + the
    // disabled-until-a-provider-is-detected Add Project CTA. The component
    // owns its own discovery call so the cold-launch path doesn't pay for it
    // when the user already has a project registered.
    return (
      <Suspense fallback={<SkeletonPane label="Loading launcher" />}>
        <WelcomePane onAddProject={onAddProject} />
      </Suspense>
    );
  }

  // Browser mode reads nothing from the project, so it opens even before one
  // is picked; Changes and Files have no source without it.
  const isReviewOpen =
    reviewState.isPanelOpen && (activeProject !== null || reviewState.layout.modes.includes("browser"));
  const contextSummary = project
    ? `Project and branch: ${project.name}, ${project.currentBranch}`
    : "";
  const contextChipLabel = project?.name ?? "";

  return (
    <div
      className="launcher-shell"
      data-review-open={isReviewOpen ? "true" : undefined}
    >
      <div className="launcher-surface" ref={surfaceRef}>
      {anyContextPickerOpen && createPortal(
        <div
          className="picker-dismiss-layer"
          aria-hidden="true"
          onMouseDown={closeContextPickers}
        />,
        document.body
      )}
      <header className="launcher-hero">
        <Mascot
          mood={mascotMood}
          shades={wearsShades}
          size={104}
          className="launcher-hero-mascot"
          buttonClassName="launcher-hero-mascot-button"
          onClick={petMascot}
          title="Pet the fox"
        />
        <h1 className="launcher-hero-title">{chatMode ? SIDE_CHAT_TITLE : LAUNCHER_TITLE}</h1>
      </header>
      <form
        className="composer"
        data-drag-active={isDraggingFiles ? "true" : undefined}
        data-font-size={chatFontSize === undefined ? undefined : String(chatFontSize)}
        data-type-scale={chatFontSize === undefined ? "composer" : undefined}
        ref={formRef}
        onSubmit={(event) => void submitPrompt(event)}
        onDragEnter={cloudMode ? undefined : onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={(event) => {
          if (!cloudMode) return onComposerDrop(event);
          event.preventDefault();
          setStatus("Cloud tasks support text only. Switch to Local to attach files.");
        }}
      >
        <div className="composer-drop-overlay" aria-hidden="true">
          <Paperclip size={20} />
          <span>Drop to attach</span>
          <small>Images and files</small>
        </div>
        <input
          ref={attachmentInputRef}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={onAttachmentInputChange}
        />
        {pendingAttachments.length > 0 ? (
          <div className="composer-attachments" aria-label="Attached images">
            {pendingAttachments.map((attachment) => {
              const src =
                pendingAttachmentPreviews[attachment.filePath] ?? attachmentProtocolUrl(attachment.filePath);
              return (
                <div key={attachment.filePath} className="composer-attachment-chip">
                  <button
                    type="button"
                    className="attachment-open-button"
                    aria-label="View attachment"
                    title="View attachment"
                    onClick={() => setLightboxSrc(src)}
                  >
                    <img src={src} alt="" />
                  </button>
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    aria-label="Remove attachment"
                    title="Remove attachment"
                    onClick={() => removePendingAttachment(attachment.filePath)}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="composer-input">
          {skillHighlight ? (
            <div className="composer-highlight-backdrop" aria-hidden="true">
              <div className="composer-highlight-text" ref={highlightTextRef}>
                {skillHighlight.map((segment, index) =>
                  segment.skill ? (
                    <span key={index} className="skill-token">
                      {segment.text}
                    </span>
                  ) : (
                    segment.text
                  )
                )}
                {/* Holds open the empty last line a trailing newline makes, as the textarea does. */}
                {prompt.endsWith("\n") ? "\u200b" : null}
              </div>
            </div>
          ) : null}
          <textarea
            className={skillHighlight ? "composer-input--highlighting" : undefined}
            aria-label="Task prompt"
            aria-autocomplete="list"
            aria-expanded={slashAutocomplete.popoverOpen || fileAutocomplete.popoverOpen}
            aria-controls={
              slashAutocomplete.popoverOpen
                ? "slash-menu"
                : fileAutocomplete.popoverOpen
                  ? "file-popover"
                  : undefined
            }
            disabled={isSubmitting}
            onChange={(event) => {
              setPrompt(event.target.value);
              fileAutocomplete.onSelectionChange(event);
            }}
            onKeyDown={onPromptKeyDown}
            onPaste={(event) => {
              if (!cloudMode) return onComposerPaste(event);
              if (event.clipboardData.files.length > 0) {
                event.preventDefault();
                setStatus("Cloud tasks support text only. Switch to Local to attach files.");
              }
            }}
            onScroll={syncHighlightScroll}
            onSelect={fileAutocomplete.onSelectionChange}
            onClick={fileAutocomplete.onSelectionChange}
            placeholder={placeholderText}
            ref={promptInputRef}
            value={prompt}
            rows={1}
          />
          <SlashCommandMenu state={slashAutocomplete} />
          <FilePopover state={fileAutocomplete} inputRef={promptInputRef} />
          <button
            className="send-button"
            type="submit"
            disabled={isSubmitting || !hasSendableContent}
            title={cloudMode ? "Review cloud task" : "Start agent"}
            aria-label={cloudMode ? "Review cloud task" : "Start agent"}
          >
            {cloudMode ? <ArrowRight size={15} aria-hidden="true" /> : <Play size={13} fill="currentColor" strokeWidth={0} aria-hidden="true" />}
          </button>
        </div>
        <div className="composer-context">
          <button
            className="composer-tool"
            type="button"
            title={cloudMode ? "Cloud tasks take text only. Switch to Local to attach files." : "Attach file"}
            aria-label="Attach file"
            disabled={cloudMode}
            onClick={openFilePicker}
          >
            <Plus size={14} />
          </button>
          <div className="composer-context-group composer-context-group--model">
            {cloudMode ? (
              <span
                className="composer-context-chip composer-cloud-provider"
                title={`${cloudProviderName(cloudProvider)} picks the model`}
              >
                <Cloud size={14} aria-hidden="true" />
                <span className="model-picker-label">{cloudProviderName(cloudProvider)}</span>
              </span>
            ) : <LaunchModelSelector
              ariaLabel="Switch model"
              availability={providerAvailability}
              fastModeEnabled={fastModeEnabled}
              open={modelPickerOpen}
              onOpenChange={setModelPickerOpen}
              openBelow
              withEffortSlider
              effortOpen={effortPickerOpen}
              onEffortOpenChange={setEffortPickerOpen}
              value={model}
              onChange={onModelChange}
              onFastModeEnabledChange={onFastModeEnabledChange}
            />}
          </div>
          {chatMode ? null : (
          <div
            className="composer-context-group composer-context-group--workspace"
            data-compact-open={compactContextOpen ? "true" : undefined}
            ref={compactContextRef}
          >
            <button
              type="button"
              className="composer-compact-context-trigger"
              title={contextSummary}
              aria-label={contextSummary}
              aria-haspopup="dialog"
              aria-expanded={compactContextOpen}
              onClick={() => {
                if (!compactContextOpen) {
                  setProjectPickerOpen(false);
                  setBranchPickerOpen(false);
                  setModelPickerOpen(false);
                }
                setCompactContextOpen((open) => !open);
              }}
            >
              <MoreHorizontal size={14} aria-hidden="true" />
            </button>
            <div
              className="launch-workspace-pickers"
              role={compactContextOpen ? "dialog" : undefined}
              aria-label={compactContextOpen ? "Project and branch" : undefined}
            >
            <div className="project-picker-anchor" ref={setProjectAnchor}>
            <button
              className="composer-context-chip"
              type="button"
              aria-label="Switch project"
              aria-haspopup="listbox"
              aria-expanded={projectPickerOpen}
              title={contextChipLabel}
              onClick={() => setProjectPickerOpen((o) => !o)}
            >
              <Folder size={14} aria-hidden="true" />
              <span className="composer-context-chip-label">{contextChipLabel}</span>
            </button>
            {projectPickerOpen && (
              <ul
                className="project-picker-popover"
                // Menus read at app-chrome size even though the composer around
                // them sits one step up. See tokens.css.
                data-type-scale="chrome"
                role="listbox"
                aria-label="Select project"
                ref={setProjectListNode}
                style={projectFloatingStyles}
                tabIndex={-1}
                onKeyDown={projectFilter.onKeyDown}
                onClick={(event) => {
                  if (!isOptionButtonTarget(event.target)) {
                    setProjectPickerOpen(false);
                  }
                }}
              >
                <PickerFilterRow
                  query={projectFilter.query}
                  matchCount={projectFilter.matches.length}
                  totalCount={orderedProjects.length}
                />
                {projectFilter.matches.map((p, index) => (
                  <li
                    key={p.id}
                    role="option"
                    aria-selected={p.id === project?.id}
                    data-active={index === projectFilter.activeIndex ? "true" : undefined}
                  >
                    <button
                      type="button"
                      className="project-picker-item"
                      aria-pressed={p.id === project?.id}
                      onClick={() => pickProject(p)}
                    >
                      <PickerLead selected={p.id === project?.id}>
                        <Folder size={13} />
                      </PickerLead>
                      <span className="picker-label">{p.name}</span>
                      <span className="picker-meta" aria-hidden="true">
                        {parentFolderLabel(p.repoPath)}
                      </span>
                    </button>
                  </li>
                ))}
                {projectFilter.matches.length === 0 ? (
                  <li className="project-picker-empty" role="presentation">
                    No projects match
                  </li>
                ) : null}
                <li className="project-picker-divider" role="separator" />
                <li role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="project-picker-item"
                    onClick={() => {
                      onAddProject();
                      setProjectPickerOpen(false);
                      setCompactContextOpen(false);
                    }}
                  >
                    <PickerLead>
                      <Plus size={13} />
                    </PickerLead>
                    Browse folder…
                  </button>
                </li>
              </ul>
            )}
            </div>
            {project ? (
            <div className="project-picker-anchor" ref={setBranchAnchor}>
            <button
              className="composer-context-chip branch-chip"
              type="button"
              aria-label="Switch branch"
              aria-haspopup="listbox"
              aria-expanded={branchPickerOpen}
              title={project.currentBranch}
              onClick={() => void openBranchPicker()}
            >
              <GitBranch size={14} aria-hidden="true" />
              <span className="composer-context-chip-label">{project.currentBranch}</span>
            </button>
            {branchPickerOpen && (
              <ul
                className="project-picker-popover"
                data-type-scale="chrome"
                role="listbox"
                aria-label="Select branch"
                ref={setBranchListNode}
                style={branchFloatingStyles}
                tabIndex={-1}
                onKeyDown={branchFilter.onKeyDown}
                onClick={(event) => {
                  if (!isOptionButtonTarget(event.target)) {
                    setBranchPickerOpen(false);
                  }
                }}
              >
                <PickerFilterRow
                  query={branchFilter.query}
                  matchCount={branchFilter.matches.length}
                  totalCount={branches.length}
                />
                {branchFilter.matches.length > 0 ? (
                  branchFilter.matches.map((b, index) => (
                    <li
                      key={b}
                      role="option"
                      aria-selected={b === project.currentBranch}
                      data-active={index === branchFilter.activeIndex ? "true" : undefined}
                    >
                      <button
                        type="button"
                        className="project-picker-item"
                        aria-pressed={b === project.currentBranch}
                        onClick={() => void switchBranch(b)}
                      >
                        <PickerLead selected={b === project.currentBranch}>
                          <GitBranch size={13} />
                        </PickerLead>
                        <span className="picker-label">{b}</span>
                      </button>
                    </li>
                  ))
                ) : (
                  <li role="option" aria-selected={false} aria-disabled="true">
                    <button type="button" className="project-picker-item" disabled>
                      {branchFilter.query ? "No branches match" : "No branches"}
                    </button>
                  </li>
                )}
              </ul>
            )}
            </div>
            ) : null}
            </div>
          </div>
          )}
          <div className="composer-context-group composer-context-group--behavior">
            {!chatMode ? (
              <button
                type="button"
                className="composer-context-chip composer-run-location"
                aria-label={`Run location: ${cloudMode ? "Cloud" : "Local"}`}
                aria-pressed={cloudMode}
                disabled={isSubmitting}
                title={cloudMode
                  ? "Switch to Local"
                  : isHostedCloudProvider(model.provider)
                    ? `Switch to Cloud · ${cloudProviderName(model.provider)}`
                    : `${PROVIDER_DISPLAY_NAMES[model.provider]} can’t run cloud tasks`}
                onClick={() => {
                  if (!cloudMode && !isHostedCloudProvider(model.provider)) {
                    setStatus(`${PROVIDER_DISPLAY_NAMES[model.provider]} can’t run cloud tasks. Pick a Claude, Codex, or Cursor model to use Cloud.`);
                    return;
                  }
                  closeContextPickers();
                  setCloudSelected((selected) => !selected);
                  setStatus(!cloudMode && pendingAttachments.length > 0
                    ? "Cloud tasks support text only. Remove attachments or switch to Local."
                    : null);
                }}
              >
                {cloudMode ? "Cloud" : "Local"}
              </button>
            ) : null}
            {/* Auto is the resting mode and carries no flags, so it stays unlabelled.
                The chip appears only for a scratch Chat. */}
            {launcherMode === "auto" ? null : (
              <button
                type="button"
                className="composer-context-chip chat-mode-toggle"
                aria-label="Chat mode"
                aria-pressed
                title={launcherModeTitle(launcherMode, chatAvailable)}
                onClick={toggleMode}
              >
                {LAUNCHER_MODE_LABELS[launcherMode]}
              </button>
            )}
            {chatMode || cloudMode ? null : (
              <button
                type="button"
                className="composer-context-chip workspace-mode-toggle"
                aria-label="Worktree"
                aria-pressed={workspaceMode === "worktree"}
                title={
                  workspaceMode === "worktree"
                    ? "On — agent runs in an isolated git worktree on a new branch"
                    : "Off — agent runs in your current checkout. Enable to isolate in a worktree."
                }
                onClick={toggleWorkspace}
              >
                Worktree
              </button>
            )}
          </div>
        </div>
        {status ? (
          <div className="launcher-error" role="alert">
            <span>{status}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => {
                setStatus(null);
                if (isFocusedRef.current) promptInputRef.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </div>
        ) : null}
      </form>
      </div>
      {cloudDraft ? (
        <CloudTaskDialog
          open
          projectId={cloudDraft.projectId}
          provider={cloudDraft.provider}
          initialBrief={cloudDraft.brief}
          onClose={() => setCloudDraft(null)}
          onLaunched={() => {
            if (project?.id === cloudDraft.projectId && prompt.trim() === cloudDraft.brief) {
              setPrompt("");
              if (draftKey) clearDraft(draftKey);
            }
          }}
        />
      ) : null}
      <ImageLightbox src={lightboxSrc} alt="Attached image" onClose={() => setLightboxSrc(null)} />
      {connectionsOpen ? (
        <ConnectionDialog
          anchorRef={formRef}
          provider={model.provider}
          workspaceId={null}
          onClose={() => {
            setConnectionsOpen(false);
            if (isFocusedRef.current) promptInputRef.current?.focus();
          }}
        />
      ) : null}
      {isReviewOpen ? (
        <Suspense fallback={null}>
          <ReviewPanel review={reviewState} />
        </Suspense>
      ) : null}
    </div>
  );
}
