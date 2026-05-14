import { ChevronDown, CornerDownLeft, Folder, GitBranch, Mic, Plus } from "lucide-react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import type { ProjectSummary } from "../../shared/types.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useReviewState, type ReviewSource } from "../hooks/useReviewState.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import { WORKSPACE_DRAG_MIME } from "../lib/gridState.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import { type ModelPickerSelection } from "../lib/models.js";
import { FileSearchOverlay } from "./FileSearchOverlay.js";
import { LaunchModelSelector } from "./ModelSelector.js";
// ReviewPanel pulls in shiki + diff utilities — heavy and only needed when
// the right-side review pane is open. Lazy-mounted (ralph B4) so the
// launcher's first paint doesn't ship the highlighter.
const ReviewPanel = lazy(async () => ({
  default: (await import("./ReviewPanel.js")).ReviewPanel
}));
import { SkeletonPane } from "./SkeletonPane.js";
import { SkillPopover } from "./SkillPopover.js";
// WelcomePane only renders on a fresh install (no projects) — lazy-mounted
// (ralph B2) so its provider-discovery code path doesn't ship in the main
// launcher bundle for the common case.
const WelcomePane = lazy(async () => ({
  default: (await import("./WelcomePane.js")).WelcomePane
}));

const PROMPT_MAX_HEIGHT_PX = 140;

const LAUNCH_STARTERS = [
  "Add a test for…",
  "Investigate why…",
  "Refactor…"
] as const;

function isOptionButtonTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button.project-picker-item") !== null;
}

export function LaunchSurface({
  dragActive = false,
  model,
  onAddProject,
  onBranchSwitch,
  onLaunchTask,
  onModelChange,
  onSelectProject,
  onWorkspaceDrop,
  project,
  projects,
  rightPanelToggleSignal
}: {
  /** Mirrors App.tsx's sidebar drag state — when true, the launch surface accepts a workspace drop. */
  dragActive?: boolean;
  model: ModelPickerSelection;
  onAddProject: () => void;
  onBranchSwitch: (updated: ProjectSummary) => void;
  onLaunchTask: (prompt: string, model: ModelPickerSelection) => Promise<void>;
  onModelChange: (model: ModelPickerSelection) => void;
  onSelectProject: (id: string) => void;
  /** Called when a sidebar workspace is dropped onto the empty launcher surface. */
  onWorkspaceDrop?: (workspaceId: string) => void;
  project: ProjectSummary | null;
  projects: ProjectSummary[];
  rightPanelToggleSignal?: number;
}): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const branchPickerRef = useRef<HTMLDivElement | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  // Read-only Changes + Files review against the selected project's main
  // checkout. Lets the user inspect what's already in the repo before
  // starting a session. Cmd/Ctrl+B toggles it (same shortcut as inside
  // a session); no menu icon today, just the keyboard shortcut.
  const reviewSource = useMemo<ReviewSource | null>(
    () => (project ? { kind: "project", project } : null),
    [project]
  );
  const reviewState = useReviewState(reviewSource);
  const reviewOpenPanelInFilesMode = reviewState.openPanelInFilesMode;
  const reviewOpenInFilesView = reviewState.openInFilesView;
  const reviewClosePanel = reviewState.closePanel;
  const reviewIsPanelOpen = reviewState.isPanelOpen;
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  const lastRightPanelToggleSignal = useRef(rightPanelToggleSignal);
  const toggleReviewPanel = useCallback((): void => {
    if (reviewIsPanelOpen) {
      reviewClosePanel();
    } else {
      reviewOpenPanelInFilesMode();
    }
  }, [reviewClosePanel, reviewIsPanelOpen, reviewOpenPanelInFilesMode]);

  useEffect(() => {
    if (!project) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      toggleReviewPanel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [project, toggleReviewPanel]);

  useEffect(() => {
    if (rightPanelToggleSignal === lastRightPanelToggleSignal.current) return;
    lastRightPanelToggleSignal.current = rightPanelToggleSignal;
    if (!project) return;
    toggleReviewPanel();
  }, [project, rightPanelToggleSignal, toggleReviewPanel]);

  // Cmd/Ctrl+P opens project file quick-open from the launcher. Picking a
  // result opens the right-side ReviewPanel in Files mode.
  useEffect(() => {
    if (!project) return undefined;
    const handler = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      setIsQuickOpenOpen(true);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [project]);

  useEffect(() => {
    if (!project || !reviewIsPanelOpen || isQuickOpenOpen) return undefined;
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      reviewClosePanel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [project, reviewClosePanel, reviewIsPanelOpen, isQuickOpenOpen]);

  useDismissOnOutsideOrEscape(projectPickerRef, projectPickerOpen, () => setProjectPickerOpen(false));
  useDismissOnOutsideOrEscape(branchPickerRef, branchPickerOpen, () => setBranchPickerOpen(false));
  const anyContextPickerOpen = projectPickerOpen || branchPickerOpen || modelPickerOpen;

  const closeContextPickers = useCallback((): void => {
    setProjectPickerOpen(false);
    setBranchPickerOpen(false);
    setModelPickerOpen(false);
  }, []);

  const openBranchPicker = useCallback(async (): Promise<void> => {
    if (!window.argmax || !project) return;
    try {
      const list = await window.argmax.projects.listBranches(project.id);
      setBranches(list);
      setBranchPickerOpen(true);
    } catch (error) {
      setBranchPickerOpen(false);
      setStatus(error instanceof Error ? error.message : "Could not load branches.");
    }
  }, [project]);

  const switchBranch = useCallback(async (branch: string): Promise<void> => {
    if (!window.argmax || !project) return;
    setBranchPickerOpen(false);
    try {
      const updated = await window.argmax.projects.switchBranch(project.id, branch);
      onBranchSwitch(updated);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not switch branch.");
    }
  }, [project, onBranchSwitch]);
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

  // Auto-focus the prompt when the launcher is the active surface — on first
  // visit, on project switch, and again whenever the right-side review panel
  // or quick-open overlay closes, so the user can keep typing without clicking.
  useEffect(() => {
    if (!project || reviewIsPanelOpen || isQuickOpenOpen || isSubmitting) return;
    promptInputRef.current?.focus();
  }, [project, reviewIsPanelOpen, isQuickOpenOpen, isSubmitting]);
  const slashAutocomplete = useSlashAutocomplete({
    input: prompt,
    setInput: setPrompt,
    provider: model.provider,
    workspaceId: null
  });

  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
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

  const [headingBefore, headingAfter] = useMemo(() => {
    const token = "{name}";
    const idx = headingTemplate.indexOf(token);
    if (idx === -1) return [headingTemplate, ""] as const;
    return [headingTemplate.slice(0, idx), headingTemplate.slice(idx + token.length)] as const;
  }, [headingTemplate]);

  const heroEyebrowDate = useMemo(() => {
    const d = new Date();
    const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
    const day = String(d.getDate()).padStart(2, "0");
    return `${month} ${day}`;
  }, []);

  const applyStarter = useCallback((seed: string): void => {
    setPrompt(seed);
    requestAnimationFrame(() => {
      const node = promptInputRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(seed.length, seed.length);
    });
  }, []);

  if (!project) {
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

  const isReviewOpen = reviewState.isPanelOpen && project !== null;

  const handleWorkspaceDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!onWorkspaceDrop) return;
    const types = Array.from(event.dataTransfer.types);
    if (!types.includes(WORKSPACE_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const handleWorkspaceDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!onWorkspaceDrop) return;
    const workspaceId = event.dataTransfer.getData(WORKSPACE_DRAG_MIME);
    if (!workspaceId) return;
    event.preventDefault();
    onWorkspaceDrop(workspaceId);
  };

  return (
    <div
      className="launcher-shell"
      data-review-open={isReviewOpen ? "true" : undefined}
      data-drop-target={dragActive && onWorkspaceDrop ? "true" : undefined}
      onDragOver={handleWorkspaceDragOver}
      onDrop={handleWorkspaceDrop}
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
        <div className="launcher-hero-meta">
          <span className="launcher-hero-dot" aria-hidden="true" />
          <span className="launcher-hero-eyebrow">
            New session · {project.currentBranch} · {heroEyebrowDate}
          </span>
        </div>
        <h1 className="launcher-hero-headline">
          {headingBefore}
          <span className="launcher-hero-project">{project.name}</span>
          {headingAfter}
        </h1>
        <p className="launcher-hero-lede">
          Type a task. Press <kbd className="launcher-hero-kbd">⏎</kbd> and I'll spin up a fresh worktree, branch it, and stream the agent back here.
        </p>
      </header>
      <form className="composer" ref={formRef} onSubmit={(event) => void submitPrompt(event)}>
        <div className="composer-input">
          <span className="composer-marker" aria-hidden="true">▍</span>
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
          <button className="composer-tool" type="button" title="Add context" aria-label="Add context">
            <Plus size={18} />
          </button>
          <button className="composer-tool" type="button" title="Voice input" aria-label="Voice input">
            <Mic size={18} />
          </button>
          <button
            className="send-button"
            disabled={isSubmitting || !prompt.trim()}
            type="submit"
            title="Start agent"
            aria-label="Start agent"
          >
            <CornerDownLeft size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="composer-context">
          <span className="composer-context-tree" aria-hidden="true">└─</span>
          <div className="project-picker-anchor" ref={projectPickerRef}>
            <button
              className="composer-context-chip"
              type="button"
              aria-label="Switch project"
              aria-expanded={projectPickerOpen}
              onClick={() => setProjectPickerOpen((o) => !o)}
            >
              <Folder size={14} aria-hidden="true" />
              {project.name}
              <ChevronDown size={12} aria-hidden="true" style={{ marginLeft: 2, opacity: 0.6 }} />
            </button>
            {projectPickerOpen && (
              <ul
                className="project-picker-popover"
                role="listbox"
                aria-label="Select project"
                onClick={(event) => {
                  if (!isOptionButtonTarget(event.target)) {
                    setProjectPickerOpen(false);
                  }
                }}
              >
                {projects.map((p) => (
                  <li key={p.id} role="option" aria-selected={p.id === project.id}>
                    <button
                      type="button"
                      className="project-picker-item"
                      aria-pressed={p.id === project.id}
                      onClick={() => { onSelectProject(p.id); setProjectPickerOpen(false); }}
                    >
                      <Folder size={13} aria-hidden="true" />
                      {p.name}
                    </button>
                  </li>
                ))}
                <li className="project-picker-divider" role="separator" />
                <li role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="project-picker-item"
                    onClick={() => { onAddProject(); setProjectPickerOpen(false); }}
                  >
                    <Plus size={13} aria-hidden="true" />
                    Browse folder…
                  </button>
                </li>
              </ul>
            )}
          </div>
          <div className="project-picker-anchor" ref={branchPickerRef}>
            <button
              className="composer-context-chip"
              type="button"
              aria-label="Switch branch"
              aria-expanded={branchPickerOpen}
              onClick={() => void openBranchPicker()}
            >
              <GitBranch size={14} aria-hidden="true" />
              {project.currentBranch}
              <ChevronDown size={12} aria-hidden="true" style={{ marginLeft: 2, opacity: 0.6 }} />
            </button>
            {branchPickerOpen && (
              <ul
                className="project-picker-popover"
                role="listbox"
                aria-label="Select branch"
                onClick={(event) => {
                  if (!isOptionButtonTarget(event.target)) {
                    setBranchPickerOpen(false);
                  }
                }}
              >
                {branches.map((b) => (
                  <li key={b} role="option" aria-selected={b === project.currentBranch}>
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
                ))}
              </ul>
            )}
          </div>
          <LaunchModelSelector
            ariaLabel="Switch model"
            open={modelPickerOpen}
            onOpenChange={setModelPickerOpen}
            value={model}
            onChange={onModelChange}
          />
        </div>
        {status ? (
          <p className="composer-status" role="status">
            <span className="composer-status-dot" aria-hidden="true" />
            {status}
          </p>
        ) : null}
      </form>
      <aside className="launcher-starters" aria-label="Starter prompts">
        <span className="launcher-starters-eyebrow">try</span>
        <ul>
          {LAUNCH_STARTERS.map((seed) => (
            <li key={seed}>
              <button
                type="button"
                className="launcher-starter-chip"
                onClick={() => applyStarter(seed)}
                title={`Use: ${seed}`}
              >
                {seed}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      </div>
      {isReviewOpen ? (
        <Suspense fallback={null}>
          <ReviewPanel review={reviewState} />
        </Suspense>
      ) : null}
      {project ? (
        <FileSearchOverlay
          open={isQuickOpenOpen}
          onClose={() => setIsQuickOpenOpen(false)}
          sourceKind="project"
          sourceId={project.id}
          onPick={reviewOpenInFilesView}
        />
      ) : null}
    </div>
  );
}
