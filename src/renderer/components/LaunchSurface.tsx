import { ChevronDown, ChevronRight, Folder, GitBranch, Mic, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import type { ProjectSummary } from "../../shared/types.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useReviewState, type ReviewSource } from "../hooks/useReviewState.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import { type ModelPickerSelection } from "../lib/models.js";
import { FileSearchOverlay } from "./FileSearchOverlay.js";
import { LaunchModelSelector } from "./ModelSelector.js";
import { ReviewPanel } from "./ReviewPanel.js";
import { SkillPopover } from "./SkillPopover.js";
import { WelcomePane } from "./WelcomePane.js";

const PROMPT_MAX_HEIGHT_PX = 140;

// Shared with SessionPane so the user gets one consistent panel width across both views.
const RIGHT_PANEL_WIDTH_KEY = "argmax.session.rightPanel.width";
const RIGHT_PANEL_MIN = 260;
const RIGHT_PANEL_MAX = 1400;
const RIGHT_PANEL_DEFAULT = 420;

function isOptionButtonTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button.project-picker-item") !== null;
}

export function LaunchSurface({
  model,
  onAddProject,
  onBranchSwitch,
  onLaunchTask,
  onModelChange,
  onSelectProject,
  project,
  projects
}: {
  model: ModelPickerSelection;
  onAddProject: () => void;
  onBranchSwitch: (updated: ProjectSummary) => void;
  onLaunchTask: (prompt: string, model: ModelPickerSelection) => Promise<void>;
  onModelChange: (model: ModelPickerSelection) => void;
  onSelectProject: (id: string) => void;
  project: ProjectSummary | null;
  projects: ProjectSummary[];
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
  const reviewTogglePanel = reviewState.togglePanel;
  const reviewOpenInFilesView = reviewState.openInFilesView;
  const reviewIsPanelOpen = reviewState.isPanelOpen;
  const [isQuickOpenOpen, setIsQuickOpenOpen] = useState(false);
  useEffect(() => {
    if (!project) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "b") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      reviewTogglePanel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [project, reviewTogglePanel]);

  // Cmd/Ctrl+P opens the file quick-open overlay, but only while the
  // right-side ReviewPanel is mounted against this project.
  useEffect(() => {
    if (!project || !reviewIsPanelOpen) return undefined;
    const handler = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "p") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setIsQuickOpenOpen(true);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [project, reviewIsPanelOpen]);

  // Drop the overlay if the panel closes underneath us.
  useEffect(() => {
    if (!reviewIsPanelOpen) setIsQuickOpenOpen(false);
  }, [reviewIsPanelOpen]);

  useDismissOnOutsideOrEscape(projectPickerRef, projectPickerOpen, () => setProjectPickerOpen(false));
  useDismissOnOutsideOrEscape(branchPickerRef, branchPickerOpen, () => setBranchPickerOpen(false));
  const anyContextPickerOpen = projectPickerOpen || branchPickerOpen || modelPickerOpen;

  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(RIGHT_PANEL_WIDTH_KEY) : null;
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(n) && n >= RIGHT_PANEL_MIN && n <= RIGHT_PANEL_MAX ? n : RIGHT_PANEL_DEFAULT;
  });
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const panelDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      panelDragCleanupRef.current?.();
      panelDragCleanupRef.current = null;
    },
    []
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  const onResizePanelMouseDown = useCallback((event: ReactMouseEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightPanelWidth;
    setIsPanelResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e: MouseEvent): void => {
      // Dragging left widens the panel (handle sits on its left edge); dragging right narrows it.
      const next = Math.max(
        RIGHT_PANEL_MIN,
        Math.min(RIGHT_PANEL_MAX, startWidth - (e.clientX - startX))
      );
      setRightPanelWidth(next);
    };
    const cleanup = (): void => {
      setIsPanelResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      panelDragCleanupRef.current = null;
    };
    const onMouseUp = (): void => cleanup();
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    panelDragCleanupRef.current = cleanup;
  }, [rightPanelWidth]);

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

  if (!project) {
    // Fresh-install surface: setup checklist + provider discovery + the
    // disabled-until-a-provider-is-detected Add Project CTA. The component
    // owns its own discovery call so the cold-launch path doesn't pay for it
    // when the user already has a project registered.
    return <WelcomePane onAddProject={onAddProject} />;
  }

  const isReviewOpen = reviewState.isPanelOpen && project !== null;
  const shellStyle = {
    "--session-review-panel-width": `${rightPanelWidth}px`
  } as CSSProperties;

  return (
    <div
      className="launcher-shell"
      data-review-open={isReviewOpen ? "true" : undefined}
      data-panel-resizing={isPanelResizing ? "true" : undefined}
      style={isReviewOpen ? shellStyle : undefined}
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
          <button className="composer-tool" type="button" title="Voice input">
            <Mic size={18} />
          </button>
          <button className="send-button" disabled={isSubmitting || !prompt.trim()} type="submit" title="Start agent">
            <ChevronRight size={20} />
          </button>
        </div>
        <div className="composer-context">
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
            {status}
          </p>
        ) : null}
      </form>
      </div>
      {isReviewOpen ? <ReviewPanel review={reviewState} onResizePanelMouseDown={onResizePanelMouseDown} /> : null}
      {isReviewOpen && project ? (
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
