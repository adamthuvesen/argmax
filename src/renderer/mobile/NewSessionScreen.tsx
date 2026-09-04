import { ArrowUp, ChevronsUpDown, Folder, GitBranch, Paperclip, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { PROVIDER_TITLE_MODEL } from "../../shared/providerModels.js";
import { SCRATCH_PROJECT_ID, type ComposerAttachment, type ProjectSummary } from "../../shared/types.js";
import { Mascot } from "../components/Mascot.js";
import { ImageLightbox } from "../components/ImageLightbox.js";
import { LaunchModelSelector } from "../components/ModelSelector.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useComposerAttachments } from "../hooks/useComposerAttachments.js";
import { useComposerDraft } from "../hooks/useComposerDraft.js";
import { BottomSheet, SheetOption } from "./BottomSheet.js";
import { MobileScreenHeader } from "./MobileScreenHeader.js";
import {
  appendReferencesToPrompt,
  imageAttachmentReference,
  SUPPORTED_IMAGE_MIME_TYPES
} from "../lib/composerAttachments.js";
import { clearDraft, launcherDraftKey } from "../lib/composerDrafts.js";
import { persistLaunchModel, readStoredLaunchModel } from "../lib/launchModelPreference.js";
import { factoryLaunchModel, type ModelPickerSelection } from "../lib/models.js";
import { LAUNCHER_TITLE, SIDE_CHAT_PLACEHOLDER, SIDE_CHAT_TITLE } from "../lib/launcherTitle.js";
import { titleFromPrompt } from "../lib/projects.js";
import {
  readStoredWorkspaceMode,
  writeWorkspaceMode,
  type WorkspaceMode
} from "../lib/workspaceMode.js";
import { REMOTE_CONNECTION_LOST_MESSAGE } from "../lib/wsTransport.js";

// The ceiling the session and launcher composers already use.
const PROMPT_MAX_HEIGHT_PX = 168;

/** A quiet context row for project and workspace choices. */
function ContextRow({
  icon,
  value,
  label,
  open,
  onOpen
}: {
  icon: ReactNode;
  value: string;
  label: string;
  open: boolean;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="mobile-new-row">
      <span className="mobile-new-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="mobile-new-row-value">{value}</span>
      <ChevronsUpDown size={14} className="mobile-new-row-caret" aria-hidden="true" />
      <button
        type="button"
        className="mobile-new-row-select"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onOpen}
      />
    </div>
  );
}

function PendingAttachments({
  attachments,
  onRemove,
  previewUrls,
  onView
}: {
  attachments: ComposerAttachment[];
  onRemove: (filePath: string) => void;
  previewUrls: Readonly<Record<string, string>>;
  onView: (src: string) => void;
}): JSX.Element | null {
  if (attachments.length === 0) return null;
  return (
    <div className="mobile-new-attachments" aria-label="Attached images">
      {attachments.map((attachment, index) => {
        const previewUrl = previewUrls[attachment.filePath];
        return (
          <div className="mobile-new-attachment" key={attachment.filePath}>
            {previewUrl ? (
              <button
                type="button"
                className="mobile-new-attachment-preview attachment-open-button"
                aria-label={`View image ${index + 1}`}
                title={`View image ${index + 1}`}
                onClick={() => onView(previewUrl)}
              >
                <img src={previewUrl} alt={`Attached image ${index + 1}`} />
              </button>
            ) : (
              <Paperclip size={14} aria-hidden="true" />
            )}
            <span>Image {index + 1}</span>
            <button
              type="button"
              className="mobile-new-attachment-remove"
              aria-label="Remove attachment"
              title="Remove attachment"
              onClick={() => onRemove(attachment.filePath)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export type PickerKind = "project" | "workspace" | "model" | "model-effort";

export function NewSessionScreen({
  projects,
  onClose,
  onLaunched,
  onError,
  openSheet,
  onOpenSheetChange
}: {
  projects: ProjectSummary[];
  onClose: () => void;
  /** Called with the new workspace id after refresh-worthy state exists. */
  onLaunched: (workspaceId: string) => Promise<void>;
  onError: (message: string) => void;
  /** Which picker is open. Owned by MobileApp so a back gesture can dismiss
   *  it instead of tearing down this screen and the typed prompt. */
  openSheet: PickerKind | null;
  onOpenSheetChange: (kind: PickerKind | null) => void;
}): JSX.Element {
  const [projectId, setProjectId] = useState(() => projects[0]?.id ?? "");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(readStoredWorkspaceMode);
  // Side chat is the repo-less flavor of this screen, the same mode the
  // desktop launcher cycles into: a scratch workspace instead of a checkout,
  // so no project and no branch. Per launch, not persisted — the desktop
  // treats it the same way. Kept out of `WorkspaceMode` on purpose: that type
  // is the stored current-vs-worktree preference both surfaces share.
  const [sideChatChosen, setSideChatChosen] = useState(false);
  // With no repository registered, a side chat is the only thing this screen
  // can launch, so it is the mode rather than one of the options.
  const sideChat = sideChatChosen || projects.length === 0;
  const [launching, setLaunching] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null,
    [projectId, projects]
  );

  // Keep the mobile launcher on the same draft keys as the desktop launcher.
  // Switching projects or choosing Side chat carries the sentence and its
  // screenshots together instead of stranding either half on the old target.
  const draftKey = sideChat ? launcherDraftKey(SCRATCH_PROJECT_ID) : project ? launcherDraftKey(project.id) : null;
  const [prompt, setPrompt, promptCarriedOnRetarget] = useComposerDraft(draftKey, {
    carryTextOnRetarget: true,
    persist: !launching
  });
  useAutoGrowTextArea(promptRef, prompt, PROMPT_MAX_HEIGHT_PX);
  const {
    pendingAttachments,
    pendingAttachmentPreviews,
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
    workspacePath: sideChat ? null : project?.repoPath ?? null,
    setInput: setPrompt,
    setStatus,
    carriedOnRetarget: promptCarriedOnRetarget,
    persist: !launching
  });

  // Same default as the desktop launcher: the stored global preference, then
  // the factory pick (Claude Opus 5) — not the project's configured model. The
  // phone's localStorage is its own store, so the preference is per device.
  const [model, setModel] = useState<ModelPickerSelection>(
    () => readStoredLaunchModel() ?? factoryLaunchModel()
  );

  const chooseWorkspaceMode = useCallback((mode: WorkspaceMode): void => {
    setWorkspaceMode(mode);
    writeWorkspaceMode(mode);
    setSideChatChosen(false);
  }, []);

  const launch = useCallback(async (): Promise<void> => {
    if (!window.argmax || launching) return;
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;
    const refs = pendingAttachments.map((attachment) => imageAttachmentReference(attachment.filePath));
    const finalPrompt = refs.length > 0 ? appendReferencesToPrompt(trimmed, refs) : trimmed;
    setLaunching(true);
    setStatus(null);
    if (draftKey) clearDraft(draftKey);
    // Null exactly when this launch is a side chat, which is what makes the
    // repo-less branch below the one TypeScript keeps the project out of.
    const repoTarget = sideChat ? null : project;
    try {
      const taskLabel = titleFromPrompt(trimmed);
      const workspace = repoTarget
        ? workspaceMode === "worktree"
          ? await window.argmax.workspaces.createIsolated({
              projectId: repoTarget.id,
              taskLabel,
              baseRef: repoTarget.currentBranch ?? null
            })
          : await window.argmax.workspaces.createCurrent({ projectId: repoTarget.id, taskLabel })
        : await window.argmax.workspaces.createScratch({ taskLabel, kind: null });
      try {
        await window.argmax.providers.launch({
          workspaceId: workspace.id,
          provider: model.provider,
          prompt: finalPrompt,
          modelLabel: model.label,
          modelId: model.modelId,
          reasoningEffort: model.reasoningEffort ?? null,
          fastMode: false,
          agentMode: "auto",
          permissionMode: "auto-approve",
          cols: 120,
          rows: 32,
          attachments: pendingAttachments.length > 0 ? pendingAttachments : null
        });
      } catch (error) {
        // No session started, so the workspace (and its worktree) would sit
        // stranded with no explanation. A lost socket is the exception: the
        // backend may have launched fine and only the reply went missing, so
        // archiving there would kill a live session and delete its worktree.
        if (!(error instanceof Error && error.message === REMOTE_CONNECTION_LOST_MESSAGE)) {
          void window.argmax.workspaces
            .archive({ workspaceId: workspace.id, force: true })
            .catch(() => undefined);
        }
        throw error;
      }
      void window.argmax.workspaces
        .autoTitle({
          workspaceId: workspace.id,
          provider: model.provider,
          modelId: PROVIDER_TITLE_MODEL[model.provider],
          prompt: trimmed
        })
        .catch(() => undefined);
      setPrompt("");
      clearAttachments();
      await onLaunched(workspace.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Starting the chat failed.");
      setLaunching(false);
    }
  }, [
    clearAttachments,
    draftKey,
    launching,
    model,
    onError,
    onLaunched,
    pendingAttachments,
    project,
    prompt,
    setPrompt,
    sideChat,
    workspaceMode
  ]);

  const workspaceValue = sideChat
    ? "Side chat"
    : workspaceMode === "worktree"
      ? "New worktree"
      : `Current branch · ${project?.currentBranch ?? "main"}`;

  return (
    <div className="mobile-new-screen">
      <MobileScreenHeader onBack={onClose} backLabel="Back to chats" title="New chat" />

      <div className="mobile-new-body">
        <div className="mobile-new-hero launcher-hero">
          <Mascot className="launcher-hero-mascot" size={72} />
          <h1 className="launcher-hero-title">{sideChat ? SIDE_CHAT_TITLE : LAUNCHER_TITLE}</h1>
        </div>
        {/* Project and workspace stay above the composer. Model and effort
            are composer controls so the launch choices stay together. A side
            chat has no repository, so it drops the project row entirely. */}
        <div className="mobile-new-context">
          {sideChat ? null : (
            <ContextRow
              icon={<Folder size={16} />}
              value={project?.name ?? ""}
              label="Project"
              open={openSheet === "project"}
              onOpen={() => onOpenSheetChange("project")}
            />
          )}
          <ContextRow
            icon={<GitBranch size={16} />}
            value={workspaceValue}
            label="Workspace"
            open={openSheet === "workspace"}
            onOpen={() => onOpenSheetChange("workspace")}
          />
        </div>

        {/* Same type scale as the session composer, so both prompts and both
            chip rows land on the same sizes — see mobile.css. */}
        <form
          className="mobile-new-composer"
          data-type-scale="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void launch();
          }}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          <input
            ref={attachmentInputRef}
            type="file"
            multiple
            accept={SUPPORTED_IMAGE_MIME_TYPES.join(",")}
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={onAttachmentInputChange}
          />
          <PendingAttachments
            attachments={pendingAttachments}
            onRemove={removePendingAttachment}
            previewUrls={pendingAttachmentPreviews}
            onView={(src) => setLightboxSrc(src)}
          />
          <textarea
            ref={promptRef}
            className="mobile-new-prompt"
            aria-label="Task"
            placeholder={sideChat ? SIDE_CHAT_PLACEHOLDER : "What are we building?"}
            value={prompt}
            rows={1}
            // The screen opens from a deliberate "+" tap, so raising the
            // keyboard immediately is the expected next step, not a theft.
            autoFocus
            onChange={(event) => setPrompt(event.target.value)}
            onPaste={onComposerPaste}
          />
          <div className="mobile-new-composer-toolbar">
            <button
              type="button"
              className="mobile-new-attach"
              aria-label="Attach file or screenshot"
              title="Attach file or screenshot"
              onClick={openFilePicker}
            >
              <Paperclip size={17} aria-hidden="true" />
              {pendingAttachments.length > 0 ? (
                <span className="mobile-new-attach-count" aria-hidden="true">
                  {pendingAttachments.length}
                </span>
              ) : null}
            </button>
            <LaunchModelSelector
              ariaLabel="Chat model"
              open={openSheet === "model"}
              onOpenChange={(open) => onOpenSheetChange(open ? "model" : null)}
              effortOpen={openSheet === "model-effort"}
              onEffortOpenChange={(open) => onOpenSheetChange(open ? "model-effort" : null)}
              value={model}
              withEffortSlider
              onChange={(next) => {
                setModel(next);
                persistLaunchModel(next);
              }}
            />
            <button
              type="submit"
              className="mobile-new-send"
              aria-label="Start chat"
              disabled={launching || prompt.trim().length === 0}
            >
              <ArrowUp size={18} aria-hidden="true" />
            </button>
          </div>
          {status ? (
            <div className="mobile-new-status" role="alert">
              {status}
            </div>
          ) : null}
        </form>
      </div>

      <ImageLightbox
        src={lightboxSrc}
        alt="Attached image"
        onClose={() => setLightboxSrc(null)}
      />

      {openSheet === "project" ? (
        <BottomSheet label="Choose project" onClose={() => onOpenSheetChange(null)}>
          <div className="mobile-sheet-group">
            {projects.map((candidate) => (
              <SheetOption
                key={candidate.id}
                label={candidate.name}
                selected={candidate.id === project?.id}
                onSelect={() => {
                  setProjectId(candidate.id);
                  onOpenSheetChange(null);
                }}
              />
            ))}
          </div>
        </BottomSheet>
      ) : null}

      {openSheet === "workspace" ? (
        <BottomSheet label="Choose workspace" onClose={() => onOpenSheetChange(null)}>
          <div className="mobile-sheet-group">
            {/* The repo modes need a repository. With none registered the
                sheet offers side chat alone rather than two dead options. */}
            {projects.length === 0 ? null : (
              <>
                <SheetOption
                  label={`Current branch${project?.currentBranch ? ` (${project.currentBranch})` : ""}`}
                  selected={!sideChat && workspaceMode === "current"}
                  onSelect={() => {
                    chooseWorkspaceMode("current");
                    onOpenSheetChange(null);
                  }}
                />
                <SheetOption
                  label="New worktree"
                  selected={!sideChat && workspaceMode === "worktree"}
                  onSelect={() => {
                    chooseWorkspaceMode("worktree");
                    onOpenSheetChange(null);
                  }}
                />
              </>
            )}
            <SheetOption
              label="Side chat"
              selected={sideChat}
              onSelect={() => {
                setSideChatChosen(true);
                onOpenSheetChange(null);
              }}
            />
          </div>
        </BottomSheet>
      ) : null}

    </div>
  );
}
