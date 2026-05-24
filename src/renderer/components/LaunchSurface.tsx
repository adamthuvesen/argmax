import { ChevronDown, Folder, GitBranch, Plus, X } from "lucide-react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import type { AgentMode, AttachmentMimeType, ComposerAttachment, ProjectSummary } from "../../shared/types.js";
import {
  appendReferencesToPrompt,
  buildAttachmentReferences,
  imageAttachmentReference,
  isSupportedImageMime,
  readBlobAsBase64
} from "../lib/composerAttachments.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useFileAutocomplete } from "../hooks/useFileAutocomplete.js";
import { useReviewState, type ReviewSource } from "../hooks/useReviewState.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import { isTypingTarget } from "../lib/typingTarget.js";
import { type ModelPickerSelection } from "../lib/models.js";
import { AGENT_MODE_LABELS, toggleAgentMode } from "../lib/agentMode.js";
import { Mascot } from "./Mascot.js";
import { LaunchModelSelector } from "./ModelSelector.js";
// ReviewPanel pulls in shiki + diff utilities — heavy and only needed when
// the right-side review pane is open. Lazy-mounted (ralph B4) so the
// launcher's first paint doesn't ship the highlighter.
const ReviewPanel = lazy(async () => ({
  default: (await import("./ReviewPanel.js")).ReviewPanel
}));
import { FilePopover } from "./FilePopover.js";
import { SkeletonPane } from "./SkeletonPane.js";
import { SkillPopover } from "./SkillPopover.js";
// WelcomePane only renders on a fresh install (no projects) — lazy-mounted
// (ralph B2) so its provider-discovery code path doesn't ship in the main
// launcher bundle for the common case.
const WelcomePane = lazy(async () => ({
  default: (await import("./WelcomePane.js")).WelcomePane
}));

const PROMPT_MAX_HEIGHT_PX = 140;

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
  projects,
  rightPanelToggleSignal,
  registerPaletteFileContext
}: {
  model: ModelPickerSelection;
  onAddProject: () => void;
  onBranchSwitch: (updated: ProjectSummary) => void;
  onLaunchTask: (
    prompt: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onModelChange: (model: ModelPickerSelection) => void;
  onSelectProject: (id: string) => void;
  project: ProjectSummary | null;
  projects: ProjectSummary[];
  rightPanelToggleSignal?: number;
  registerPaletteFileContext?: (
    context: { source: { kind: "workspace" | "project"; id: string }; onPick: (path: string) => void } | null
  ) => void;
}): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<ComposerAttachment & { id: string; thumbnailDataUrl: string }>
  >([]);
  // Stable per-mount namespace for pre-launch attachments — sessionId doesn't
  // exist yet, and the AttachmentStore only uses this string as a folder name.
  const launchAttachmentNamespaceRef = useRef<string>(`launch-${crypto.randomUUID()}`);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>("auto");
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
  const lastRightPanelToggleSignal = useRef(rightPanelToggleSignal);

  // Register this surface's file source + pick handler with App so the
  // command palette can surface project files in its Files group. Cleared
  // on unmount or when no project is selected.
  useEffect(() => {
    if (!registerPaletteFileContext) return undefined;
    if (!project) {
      registerPaletteFileContext(null);
      return () => registerPaletteFileContext(null);
    }
    registerPaletteFileContext({
      source: { kind: "project", id: project.id },
      onPick: reviewOpenInFilesView
    });
    return () => registerPaletteFileContext(null);
  }, [project, registerPaletteFileContext, reviewOpenInFilesView]);
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

  useEffect(() => {
    if (!project || !reviewIsPanelOpen) return undefined;
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      reviewClosePanel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [project, reviewClosePanel, reviewIsPanelOpen]);

  useDismissOnOutsideOrEscape(projectPickerRef, projectPickerOpen, () => setProjectPickerOpen(false));
  useDismissOnOutsideOrEscape(branchPickerRef, branchPickerOpen, () => setBranchPickerOpen(false));
  const anyContextPickerOpen = projectPickerOpen || branchPickerOpen || modelPickerOpen;

  const closeContextPickers = useCallback((): void => {
    setProjectPickerOpen(false);
    setBranchPickerOpen(false);
    setModelPickerOpen(false);
  }, []);

  const toggleMode = useCallback((): void => {
    setAgentMode((mode) => toggleAgentMode(mode));
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

  // Auto-focus the prompt when the launcher is the active surface — on
  // first visit, on project switch, and again whenever the right-side
  // review panel closes, so the user can keep typing without clicking.
  useEffect(() => {
    if (!project || reviewIsPanelOpen || isSubmitting) return;
    promptInputRef.current?.focus();
  }, [project, reviewIsPanelOpen, isSubmitting]);
  const slashAutocomplete = useSlashAutocomplete({
    input: prompt,
    setInput: setPrompt,
    provider: model.provider,
    workspaceId: null
  });

  const fileAutocomplete = useFileAutocomplete({
    input: prompt,
    setInput: setPrompt,
    inputRef: promptInputRef,
    source: project ? { kind: "project", id: project.id } : null
  });

  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    slashAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    fileAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    if (event.key === "Tab" && event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      toggleMode();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const attachFiles = useCallback(
    (files: Iterable<File> | Iterable<{ path?: string }>): void => {
      const refs = buildAttachmentReferences(files, project?.repoPath ?? null);
      if (refs.length === 0) return;
      setPrompt((prev) => appendReferencesToPrompt(prev, refs));
    },
    [project?.repoPath]
  );

  const attachImageBlobs = useCallback(async (blobs: Blob[]): Promise<void> => {
    if (blobs.length === 0) return;
    const api = window.argmax;
    if (!api) {
      setStatus("Open the Electron app window to attach images.");
      return;
    }
    try {
      for (const blob of blobs) {
        if (!isSupportedImageMime(blob.type)) continue;
        const dataBase64 = await readBlobAsBase64(blob);
        const saved = await api.attachments.saveImage({
          sessionId: launchAttachmentNamespaceRef.current,
          mimeType: blob.type,
          dataBase64
        });
        const thumbnailDataUrl = `data:${blob.type};base64,${dataBase64}`;
        setPendingAttachments((prev) => [
          ...prev,
          {
            id: `${saved.filePath}-${prev.length}`,
            filePath: saved.filePath,
            mimeType: blob.type as AttachmentMimeType,
            sizeBytes: saved.sizeBytes,
            thumbnailDataUrl
          }
        ]);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not attach image.");
    }
  }, []);

  const removePendingAttachment = useCallback((id: string): void => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const onComposerDragOver = (event: ReactDragEvent<HTMLFormElement>): void => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
  };

  const onComposerDrop = (event: ReactDragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer.files || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    const withPath: File[] = [];
    const imageBlobs: Blob[] = [];
    for (const file of Array.from(event.dataTransfer.files)) {
      const path = (file as { path?: string }).path;
      if (typeof path === "string" && path.length > 0) {
        withPath.push(file);
      } else if (isSupportedImageMime(file.type)) {
        imageBlobs.push(file);
      }
    }
    if (withPath.length > 0) attachFiles(withPath);
    if (imageBlobs.length > 0) void attachImageBlobs(imageBlobs);
    if (withPath.length === 0 && imageBlobs.length === 0) {
      setStatus("Only files with a disk path or images can be attached.");
    }
  };

  const onComposerPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const items = event.clipboardData?.items;
    if (!items || items.length === 0) return;
    const images: Blob[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      if (!isSupportedImageMime(item.type)) continue;
      const file = item.getAsFile();
      if (file) images.push(file);
    }
    if (images.length === 0) return;
    event.preventDefault();
    void attachImageBlobs(images);
  };

  const onAttachmentInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files && event.target.files.length > 0) {
      const withPath: File[] = [];
      const imageBlobs: Blob[] = [];
      for (const file of Array.from(event.target.files)) {
        const path = (file as { path?: string }).path;
        if (typeof path === "string" && path.length > 0) {
          withPath.push(file);
        } else if (isSupportedImageMime(file.type)) {
          imageBlobs.push(file);
        }
      }
      if (withPath.length > 0) attachFiles(withPath);
      if (imageBlobs.length > 0) void attachImageBlobs(imageBlobs);
      if (withPath.length === 0 && imageBlobs.length === 0) {
        setStatus("Only files with a disk path or images can be attached.");
      }
    }
    event.target.value = "";
  };

  const openFilePicker = (): void => {
    attachmentInputRef.current?.click();
  };

  const submitPrompt = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || isSubmitting) {
      return;
    }

    const refs = pendingAttachments.map((a) => imageAttachmentReference(a.filePath));
    const finalPrompt = refs.length > 0 ? appendReferencesToPrompt(trimmedPrompt, refs) : trimmedPrompt;
    const attachmentsForPersist: ComposerAttachment[] = pendingAttachments.map((a) => ({
      filePath: a.filePath,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes
    }));

    setIsSubmitting(true);
    setStatus(null);
    try {
      await onLaunchTask(
        finalPrompt,
        model,
        agentMode,
        attachmentsForPersist.length > 0 ? attachmentsForPersist : undefined
      );
      setPrompt("");
      setPendingAttachments([]);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start agent.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const heroEyebrowDate = useMemo(() => {
    const d = new Date();
    const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
    const day = String(d.getDate()).padStart(2, "0");
    return `${month} ${day}`;
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
        <div className="launcher-hero-meta">
          <span className="launcher-hero-dot" aria-hidden="true" />
          <span className="launcher-hero-eyebrow">
            New session · {project.currentBranch} · {heroEyebrowDate}
          </span>
        </div>
      </header>
      <form
        className="composer"
        ref={formRef}
        onSubmit={(event) => void submitPrompt(event)}
        onDragOver={onComposerDragOver}
        onDrop={onComposerDrop}
      >
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
              <div key={attachment.id} className="composer-attachment-chip">
                <img src={attachment.thumbnailDataUrl} alt="" />
                <button
                  type="button"
                  className="composer-attachment-remove"
                  aria-label="Remove attachment"
                  title="Remove attachment"
                  onClick={() => removePendingAttachment(attachment.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="composer-input">
          <textarea
            aria-label="Task prompt"
            aria-autocomplete="list"
            aria-expanded={slashAutocomplete.popoverOpen || fileAutocomplete.popoverOpen}
            aria-controls={
              slashAutocomplete.popoverOpen
                ? "skill-popover"
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
            onSelect={fileAutocomplete.onSelectionChange}
            onClick={fileAutocomplete.onSelectionChange}
            placeholder={placeholderText}
            ref={promptInputRef}
            value={prompt}
            rows={1}
          />
          <SkillPopover state={slashAutocomplete} inputRef={promptInputRef} />
          <FilePopover state={fileAutocomplete} inputRef={promptInputRef} />
          <button
            className="composer-tool"
            type="button"
            title="Attach file"
            aria-label="Attach file"
            onClick={openFilePicker}
          >
            <Plus size={18} />
          </button>
          <Mascot
            size={40}
            mood={isSubmitting || !prompt.trim() ? "sad" : "idle"}
            type="submit"
            disabled={isSubmitting || !prompt.trim()}
            title="Start agent"
            label="Start agent"
            buttonClassName="launcher-send-mascot"
          />
        </div>
        <div className="composer-context">
          <div className="composer-context-group composer-context-group--workspace">
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
              <ChevronDown size={11} className="composer-context-caret" aria-hidden="true" />
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
              <ChevronDown size={11} className="composer-context-caret" aria-hidden="true" />
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
          </div>
          <div className="composer-context-group composer-context-group--model">
            <LaunchModelSelector
              ariaLabel="Switch model"
              open={modelPickerOpen}
              onOpenChange={setModelPickerOpen}
              value={model}
              onChange={onModelChange}
            />
          </div>
          <button
            type="button"
            className="composer-context-chip agent-mode-toggle"
            aria-label="Agent mode"
            aria-pressed={agentMode === "plan"}
            title="Toggle agent mode (Shift+Tab)"
            onClick={toggleMode}
          >
            {AGENT_MODE_LABELS[agentMode]}
          </button>
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
