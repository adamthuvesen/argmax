import {
  Bot,
  ChevronDown,
  Folder,
  FolderGit2,
  GitBranch,
  ListChecks,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Play,
  Plus,
  X
} from "lucide-react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent as ReactUIEvent
} from "react";
import { createPortal } from "react-dom";
import {
  SCRATCH_PROJECT_ID,
  type AgentMode,
  type ComposerAttachment,
  type ProjectSummary
} from "../../shared/types.js";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import {
  appendReferencesToPrompt,
  imageAttachmentReference
} from "../lib/composerAttachments.js";
import { clearDraft, launcherDraftKey, readDraft } from "../lib/composerDrafts.js";
import { splitSkillTokens } from "../lib/slashHighlight.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useProviderAvailability } from "../hooks/useProviderAvailability.js";
import { useComposerAttachments } from "../hooks/useComposerAttachments.js";
import { useComposerDraft } from "../hooks/useComposerDraft.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useFileAutocomplete } from "../hooks/useFileAutocomplete.js";
import { useReviewState, type ReviewSource } from "../hooks/useReviewState.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import { useTypeToFilter } from "../hooks/useTypeToFilter.js";
import { LAUNCHER_TITLE, SIDE_CHAT_TITLE } from "../lib/launcherTitle.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import { preferredLaunchModel, type ModelPickerSelection } from "../lib/models.js";
import {
  LAUNCHER_MODE_LABELS,
  agentModeForLaunch,
  cycleLauncherMode,
  launcherModeTitle,
  type LauncherMode
} from "../lib/agentMode.js";
import type { ComposerCommand } from "../lib/composerCommands.js";
import {
  readStoredWorkspaceMode,
  toggleWorkspaceMode,
  writeWorkspaceMode,
  type WorkspaceMode
} from "../lib/workspaceMode.js";
import { ComposerPixelField } from "./ComposerPixelField.js";
import { PickerFilterRow } from "./PickerFilterRow.js";
import { LaunchModelSelector } from "./ModelSelector.js";
import { Mascot } from "./Mascot.js";
// ReviewPanel pulls in shiki + diff utilities — heavy and only needed when
// the right-side review pane is open. Lazy-mounted (ralph B4) so the
// launcher's first paint doesn't ship the highlighter.
const ReviewPanel = lazy(async () => ({
  default: (await import("./ReviewPanel.js")).ReviewPanel
}));
import { FilePopover } from "./FilePopover.js";
import { SkeletonPane } from "./SkeletonPane.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";
// WelcomePane only renders on a fresh install (no projects) — lazy-mounted
// (ralph B2) so its provider-discovery code path doesn't ship in the main
// launcher bundle for the common case.
const WelcomePane = lazy(async () => ({
  default: (await import("./WelcomePane.js")).WelcomePane
}));

const PROMPT_MAX_HEIGHT_PX = 168;

function isOptionButtonTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button.project-picker-item") !== null;
}

export function LaunchSurface({
  fastModeEnabled = false,
  pixelFieldEnabled = false,
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
  sideChatMode = false
}: {
  fastModeEnabled?: boolean;
  pixelFieldEnabled?: boolean;
  model: ModelPickerSelection;
  onAddProject: () => void;
  onBranchSwitch: (updated: ProjectSummary) => void;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onLaunchTask: (
    prompt: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    workspaceMode: WorkspaceMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onLaunchSideChat?: (
    prompt: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
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
}): JSX.Element {
  // Side chat is the repo-less flavor of this surface: same composer and
  // model picker, but no project, branch, worktree, or review chrome. The
  // selected project stays untouched behind the mode so switching back is
  // instant; every repo-coupled hook below reads `activeProject` instead of
  // `project` so chat mode disables them without unmounting the surface.
  const chatMode = sideChatMode && onLaunchSideChat !== undefined;
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
    attachmentInputRef,
    removePendingAttachment,
    onComposerDragOver,
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
  const [agentMode, setAgentMode] = useState<AgentMode>("auto");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(readStoredWorkspaceMode);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const branchPickerRef = useRef<HTMLDivElement | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [compactContextOpen, setCompactContextOpen] = useState(false);
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
  const reviewState = useReviewState(reviewSource);
  const reviewOpenPanelInFilesMode = reviewState.openPanelInFilesMode;
  const reviewOpenInFilesView = reviewState.openInFilesView;
  const reviewClosePanel = reviewState.closePanel;
  const reviewIsPanelOpen = reviewState.isPanelOpen;
  const reviewMode = reviewState.mode;
  const lastResetSignal = useRef(resetSignal);
  const lastRightPanelToggleSignal = useRef(rightPanelToggleSignal);

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
        if (reviewIsPanelOpen && reviewMode === "files") {
          reviewClosePanel();
        } else {
          reviewOpenPanelInFilesMode();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeProject, reviewClosePanel, reviewIsPanelOpen, reviewMode, reviewOpenPanelInFilesMode, toggleReviewPanel]);

  useEffect(() => {
    if (resetSignal === lastResetSignal.current) return;
    lastResetSignal.current = resetSignal;
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

  useDismissOnOutsideOrEscape(projectPickerRef, projectPickerOpen, () => setProjectPickerOpen(false));
  useDismissOnOutsideOrEscape(branchPickerRef, branchPickerOpen, () => setBranchPickerOpen(false));
  useDismissOnOutsideOrEscape(compactContextRef, compactContextOpen, () => setCompactContextOpen(false));
  const anyContextPickerOpen = projectPickerOpen || branchPickerOpen || modelPickerOpen;

  const closeContextPickers = useCallback((): void => {
    setProjectPickerOpen(false);
    setBranchPickerOpen(false);
    setModelPickerOpen(false);
    setCompactContextOpen(false);
  }, []);

  const chatAvailable = Boolean(onLaunchSideChat && onSideChatModeChange);
  const launcherMode: LauncherMode = chatMode ? "chat" : agentMode;

  const toggleMode = useCallback((): void => {
    const next = cycleLauncherMode(chatMode ? "chat" : agentMode, chatAvailable);
    if (next === "chat") {
      closeContextPickers();
      onSideChatModeChange?.(true);
      return;
    }
    onSideChatModeChange?.(false);
    setAgentMode(next);
  }, [agentMode, chatAvailable, chatMode, closeContextPickers, onSideChatModeChange]);

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
    try {
      const list = await window.argmax.projects.listBranches(activeProject.id);
      const otherBranches = list.filter((branch) => branch !== activeProject.currentBranch);
      setBranches(otherBranches);
      setBranchPickerOpen(true);
    } catch (error) {
      setBranchPickerOpen(false);
      setStatus(error instanceof Error ? error.message : "Could not load branches.");
    }
  }, [activeProject]);

  const switchBranch = useCallback(async (branch: string): Promise<void> => {
    if (!window.argmax || !activeProject) return;
    setBranchPickerOpen(false);
    setCompactContextOpen(false);
    try {
      const updated = await window.argmax.projects.switchBranch(activeProject.id, branch);
      onBranchSwitch(updated);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not switch branch.");
    }
  }, [activeProject, onBranchSwitch]);
  // Typing into an open picker filters it through useTypeToFilter. The lists take
  // focus while open, so characters land here instead of in the prompt behind.
  const projectListRef = useRef<HTMLUListElement | null>(null);
  const branchListRef = useRef<HTMLUListElement | null>(null);
  const pickProject = useCallback(
    (candidate: ProjectSummary): void => {
      onSideChatModeChange?.(false);
      onSelectProject(candidate.id);
      setProjectPickerOpen(false);
      setCompactContextOpen(false);
    },
    [onSelectProject, onSideChatModeChange]
  );
  const selectedProjectIndex = projects.findIndex((candidate) => candidate.id === project?.id);
  const projectFilter = useTypeToFilter({
    open: projectPickerOpen,
    items: projects,
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
    ? "Ask anything — no repository attached"
    : "Ask your agent to inspect, build, or fix something";
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  useAutoGrowTextArea(promptInputRef, prompt, PROMPT_MAX_HEIGHT_PX);

  // Read inside the auto-focus effect without widening its deps: whether a
  // picker is open decides nothing about *when* to refocus, only whether to.
  const contextPickerOpenRef = useRef(false);
  contextPickerOpenRef.current = anyContextPickerOpen;

  // Auto-focus the prompt when the launcher is the active surface — on
  // first visit, on project switch, and again whenever the right-side
  // review panel closes, so the user can keep typing without clicking.
  useEffect(() => {
    if ((!activeProject && !chatMode) || reviewIsPanelOpen || isSubmitting) return;
    // An open picker holds focus to filter keystrokes; a re-render behind it
    // (a dashboard delta re-identifying the project) must not yank that away.
    if (contextPickerOpenRef.current) return;
    promptInputRef.current?.focus();
    // `activeProject` (a fresh object per switch) keeps the "refocus on
    // project switch" behavior; a collapsed boolean would only fire once.
  }, [activeProject, chatMode, reviewIsPanelOpen, isSubmitting]);
  // Composer actions offered above the skills in the `/` menu. Each one is a
  // control that already sits in this toolbar — the menu is a keyboard route
  // to them, not a second set of features. The mode rows name the mode you
  // would land in, so `/plan` sets Plan outright instead of advancing the
  // chip's cycle by one.
  const launcherCommands = useMemo<ComposerCommand[]>(() => {
    const setMode = (next: LauncherMode) => () => {
      if (next === "chat") {
        closeContextPickers();
        onSideChatModeChange?.(true);
        return;
      }
      onSideChatModeChange?.(false);
      setAgentMode(next);
    };
    const modes: ComposerCommand[] = [
      {
        name: "auto",
        label: LAUNCHER_MODE_LABELS.auto,
        hint: "Work and approve each step",
        icon: Bot,
        run: setMode("auto")
      },
      {
        name: "plan",
        label: LAUNCHER_MODE_LABELS.plan,
        hint: "Draft a plan before touching anything",
        icon: ListChecks,
        run: setMode("plan")
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
    launcherMode,
    onSideChatModeChange,
    openBranchPicker,
    openFilePicker,
    setAgentMode,
    toggleWorkspace,
    workspaceMode
  ]);

  const slashAutocomplete = useSlashAutocomplete({
    input: prompt,
    setInput: setPrompt,
    provider: model.provider,
    workspaceId: null,
    commands: launcherCommands,
    inputRef: promptInputRef
  });

  const fileAutocomplete = useFileAutocomplete({
    input: prompt,
    setInput: setPrompt,
    inputRef: promptInputRef,
    source: activeProject ? { kind: "project", id: activeProject.id } : null
  });

  // Same accent tint for `/skill` tokens as the session composer: a mirror
  // div behind a transparent-text textarea (see chat-composer-chips.css).
  const skillHighlight = useMemo(
    () => splitSkillTokens(prompt, (name) => slashAutocomplete.skillNames.has(name)),
    [prompt, slashAutocomplete.skillNames]
  );
  const highlightBackdropRef = useRef<HTMLDivElement | null>(null);
  const syncHighlightScroll = useCallback((event: ReactUIEvent<HTMLTextAreaElement>): void => {
    const backdrop = highlightBackdropRef.current;
    if (backdrop) backdrop.scrollTop = event.currentTarget.scrollTop;
  }, []);

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

  const submitPrompt = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || isSubmitting) {
      return;
    }

    const refs = pendingAttachments.map((a) => imageAttachmentReference(a.filePath));
    const finalPrompt = refs.length > 0 ? appendReferencesToPrompt(trimmedPrompt, refs) : trimmedPrompt;

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
        await onLaunchSideChat(finalPrompt, model, agentModeForLaunch(launcherMode), attachments);
      } else {
        await onLaunchTask(finalPrompt, model, agentMode, workspaceMode, attachments);
      }
      setPrompt("");
      clearAttachments();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start agent.");
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
      <Suspense fallback={<SkeletonPane />}>
        <WelcomePane onAddProject={onAddProject} />
      </Suspense>
    );
  }

  const isReviewOpen = reviewState.isPanelOpen && activeProject !== null;
  const contextSummary = project
    ? `Project and branch: ${project.name}, ${project.currentBranch}`
    : "";
  const contextChipLabel = project?.name ?? "";

  return (
    <div
      className="launcher-shell"
      data-review-open={isReviewOpen ? "true" : undefined}
    >
      <div className="launcher-surface">
      {anyContextPickerOpen && createPortal(
        <div
          className="picker-dismiss-layer"
          aria-hidden="true"
          onMouseDown={closeContextPickers}
        />,
        document.body
      )}
      <header className="launcher-hero">
        <Mascot className="launcher-hero-mascot" size={104} />
        <h1 className="launcher-hero-title">{chatMode ? SIDE_CHAT_TITLE : LAUNCHER_TITLE}</h1>
      </header>
      <form
        className="composer"
        // One step above app chrome, same as the session composer. See tokens.css.
        data-type-scale="composer"
        ref={formRef}
        onSubmit={(event) => void submitPrompt(event)}
        onDragOver={onComposerDragOver}
        onDrop={onComposerDrop}
      >
        {pixelFieldEnabled ? <ComposerPixelField text={prompt} /> : null}
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
            {pendingAttachments.map((attachment) => (
              <div key={attachment.filePath} className="composer-attachment-chip">
                <img src={attachmentProtocolUrl(attachment.filePath)} alt="" />
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
            ))}
          </div>
        ) : null}
        <div className="composer-input">
          {skillHighlight ? (
            <div className="composer-highlight-backdrop" aria-hidden="true" ref={highlightBackdropRef}>
              {skillHighlight.map((segment, index) =>
                segment.skill ? (
                  <span key={index} className="composer-skill-token">
                    {segment.text}
                  </span>
                ) : (
                  segment.text
                )
              )}
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
            onPaste={onComposerPaste}
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
            disabled={isSubmitting || !prompt.trim()}
            title="Start agent"
            aria-label="Start agent"
          >
            <Play size={13} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          </button>
        </div>
        <div className="composer-context">
          <div className="composer-context-group composer-context-group--model">
            <LaunchModelSelector
              ariaLabel="Switch model"
              availability={providerAvailability}
              fastModeEnabled={fastModeEnabled}
              open={modelPickerOpen}
              onOpenChange={setModelPickerOpen}
              withEffortSlider
              value={model}
              onChange={onModelChange}
              onFastModeEnabledChange={onFastModeEnabledChange}
            />
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
            <div className="project-picker-anchor" ref={projectPickerRef}>
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
              <ChevronDown size={11} className="composer-context-caret" aria-hidden="true" />
            </button>
            {projectPickerOpen && (
              <ul
                className="project-picker-popover"
                role="listbox"
                aria-label="Select project"
                ref={projectListRef}
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
                  totalCount={projects.length}
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
                      <Folder size={13} aria-hidden="true" />
                      {p.name}
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
                    <Plus size={13} aria-hidden="true" />
                    Browse folder…
                  </button>
                </li>
              </ul>
            )}
            </div>
            {project ? (
            <div className="project-picker-anchor" ref={branchPickerRef}>
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
              <ChevronDown size={11} className="composer-context-caret" aria-hidden="true" />
            </button>
            {branchPickerOpen && (
              <ul
                className="project-picker-popover"
                role="listbox"
                aria-label="Select branch"
                ref={branchListRef}
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
                        <GitBranch size={13} aria-hidden="true" />
                        {b}
                      </button>
                    </li>
                  ))
                ) : (
                  <li role="option" aria-selected={false} aria-disabled="true">
                    <button type="button" className="project-picker-item" disabled>
                      {branchFilter.query ? "No branches match" : "No other branches"}
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
          <button
            className="composer-tool"
            type="button"
            title="Attach file"
            aria-label="Attach file"
            onClick={openFilePicker}
          >
            <Plus size={14} />
          </button>
          <div className="composer-context-group composer-context-group--behavior">
            <button
              type="button"
              className="composer-context-chip agent-mode-toggle"
              aria-label="Agent mode"
              aria-pressed={launcherMode !== "auto"}
              title={launcherModeTitle(launcherMode, chatAvailable)}
              onClick={toggleMode}
            >
              {LAUNCHER_MODE_LABELS[launcherMode]}
            </button>
            {chatMode ? null : (
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
          <p className="composer-status" role="status">
            <span className="composer-status-dot" aria-hidden="true" />
            {status}
          </p>
        ) : null}
      </form>
      </div>
      {isReviewOpen ? (
        <Suspense fallback={null}>
          <ReviewPanel review={reviewState} />
        </Suspense>
      ) : null}
    </div>
  );
}
