import { ChevronsUpDown, Folder, GitBranch, Paperclip, Play, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { PROVIDER_TITLE_MODEL } from "../../shared/providerModels.js";
import {
  SCRATCH_PROJECT_ID,
  type ComposerAttachment,
  type ProjectSummary,
  type WorkspaceSummary
} from "../../shared/types.js";
import { Mascot } from "../components/Mascot.js";
import { ImageLightbox } from "../components/ImageLightbox.js";
import { LaunchModelSelector } from "../components/ModelSelector.js";
import type { NewSessionSeed } from "../components/SessionComposer.js";
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
import {
  launchProjectIdFrom,
  persistLaunchProjectId,
  sortProjectsByLaunchRecency
} from "../lib/launchProjectPreference.js";
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
    // The session composer's thumbnails: the image is the label, so there is
    // nothing to read and nothing to translate. The preview URL comes from the
    // screen rather than the attachment protocol, which the bridge can't reach.
    <div className="composer-attachments" aria-label="Attached images">
      {attachments.map((attachment, index) => {
        const previewUrl = previewUrls[attachment.filePath];
        return (
          <div className="composer-attachment-chip" key={attachment.filePath}>
            {previewUrl ? (
              <button
                type="button"
                className="attachment-open-button"
                aria-label={`View image ${index + 1}`}
                title={`View image ${index + 1}`}
                onClick={() => onView(previewUrl)}
              >
                <img src={previewUrl} alt={`Attached image ${index + 1}`} />
              </button>
            ) : (
              <span className="composer-attachment-pending" aria-hidden="true">
                <Paperclip size={14} />
              </span>
            )}
            <button
              type="button"
              className="composer-attachment-remove"
              aria-label="Remove attachment"
              title="Remove attachment"
              onClick={() => onRemove(attachment.filePath)}
            >
              <X size={12} aria-hidden="true" />
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
  workspaces,
  initialWorkspaceId,
  initialSeed,
  backLabel,
  onClose,
  onLaunched,
  onError,
  openSheet,
  onOpenSheetChange
}: {
  projects: ProjectSummary[];
  workspaces?: WorkspaceSummary[];
  initialWorkspaceId?: string | null;
  initialSeed?: NewSessionSeed | null;
  backLabel?: string;
  onClose: () => void;
  /** Called with the new workspace id after refresh-worthy state exists. */
  onLaunched: (workspaceId: string) => Promise<void>;
  onError: (message: string) => void;
  /** Which picker is open. Owned by MobileApp so a back gesture can dismiss
   *  it instead of tearing down this screen and the typed prompt. */
  openSheet: PickerKind | null;
  onOpenSheetChange: (kind: PickerKind | null) => void;
}): JSX.Element {
  const initialWorkspace = useMemo(
    () => (initialWorkspaceId && workspaces ? workspaces.find((w) => w.id === initialWorkspaceId) ?? null : null),
    [initialWorkspaceId, workspaces]
  );

  const [projectId, setProjectId] = useState(
    () =>
      initialWorkspace?.projectId ??
      launchProjectIdFrom(projects) ??
      projects[0]?.id ??
      ""
  );
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(() => {
    if (initialWorkspace && initialWorkspace.kind === "git" && !initialWorkspace.sharedWorkspace) {
      return "worktree";
    }
    return readStoredWorkspaceMode();
  });
  const [chosenBaseRef, setChosenBaseRef] = useState<string | null>(() => {
    if (initialWorkspace && initialWorkspace.kind === "git" && !initialWorkspace.sharedWorkspace) {
      return initialWorkspace.branch;
    }
    return null;
  });

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
  const screenRef = useRef<HTMLDivElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === projectId) ?? projects[0] ?? null,
    [projectId, projects]
  );

  const projectWorktrees = useMemo(
    () =>
      (workspaces ?? []).filter(
        (w) =>
          w.projectId === project?.id &&
          w.kind === "git" &&
          !w.sharedWorkspace &&
          w.branch.length > 0
      ),
    [project?.id, workspaces]
  );

  // Keep the mobile launcher on the same draft keys as the desktop launcher.
  // Switching projects or choosing Side chat carries the sentence and its
  // screenshots together instead of stranding either half on the old target.
  const draftKey = sideChat ? launcherDraftKey(SCRATCH_PROJECT_ID) : project ? launcherDraftKey(project.id) : null;
  const [prompt, setPrompt, promptCarriedOnRetarget] = useComposerDraft(draftKey, {
    carryTextOnRetarget: true,
    persist: !launching
  });

  useEffect(() => {
    if (initialSeed?.prompt && initialSeed.prompt.trim() !== "") {
      setPrompt(initialSeed.prompt);
    }
  }, [initialSeed?.prompt, setPrompt]);

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

  // Same default as the desktop launcher: seeded model if present, then
  // the stored global preference, then the factory pick (Claude Opus 5).
  const [model, setModel] = useState<ModelPickerSelection>(
    () => initialSeed?.model ?? readStoredLaunchModel() ?? factoryLaunchModel()
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
      const baseRef =
        workspaceMode === "worktree"
          ? chosenBaseRef ?? repoTarget?.currentBranch ?? null
          : null;
      const workspace = repoTarget
        ? workspaceMode === "worktree"
          ? await window.argmax.workspaces.createIsolated({
              projectId: repoTarget.id,
              taskLabel,
              baseRef
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
    chosenBaseRef,
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

  const baseWorktree = chosenBaseRef
    ? projectWorktrees.find((w) => w.branch === chosenBaseRef)
    : null;

  const workspaceValue = sideChat
    ? "Side chat"
    : workspaceMode === "worktree"
      ? chosenBaseRef
        ? `New worktree · from ${baseWorktree?.taskLabel ?? chosenBaseRef}`
        : "New worktree"
      : `Current branch · ${project?.currentBranch ?? "main"}`;

  return (
    <div
      ref={screenRef}
      className="mobile-new-screen"
    >
      <MobileScreenHeader onBack={onClose} backLabel={backLabel ?? "Back to chats"} title="New chat" />

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

        {/* The session composer's own card and type scale, so starting a chat
            and replying to one are one component — see mobile.css. */}
        <form
          className="session-input"
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
            aria-label="Task"
            /* Not LAUNCHER_TITLE: the hero above already asks that, and the
               same sentence twice on one screen reads as a rendering bug. */
            placeholder={sideChat ? SIDE_CHAT_PLACEHOLDER : "Describe the task"}
            value={prompt}
            rows={1}
            // The screen opens from a deliberate "+" tap, so raising the
            // keyboard immediately is the expected next step, not a theft.
            autoFocus
            onChange={(event) => setPrompt(event.target.value)}
            onPaste={onComposerPaste}
          />
          <div className="session-input-toolbar mobile-new-composer-toolbar">
            {/* The group is what holds model and effort together: "Opus 5 High"
                is one phrase, and outside it the two chips drift apart by the
                toolbar's own gap. */}
            <div className="composer-chips-group composer-chips-model">
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
            </div>
            <button
              type="button"
              className="composer-footer-chip composer-attach-chip mobile-new-attach"
              aria-label="Attach file or screenshot"
              title="Attach file or screenshot"
              onClick={openFilePicker}
            >
              {/* No count badge: the thumbnails above the field are the count,
                  and the session composer says it the same way. */}
              <Paperclip size={15} aria-hidden="true" />
            </button>
            <button
              type="submit"
              className="session-send-button"
              aria-label="Start chat"
              disabled={launching || prompt.trim().length === 0}
            >
              <Play size={13} fill="currentColor" strokeWidth={0} aria-hidden="true" />
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
            {sortProjectsByLaunchRecency(projects).map((candidate) => (
              <SheetOption
                key={candidate.id}
                label={candidate.name}
                selected={candidate.id === project?.id}
                onSelect={() => {
                  persistLaunchProjectId(candidate.id);
                  setProjectId(candidate.id);
                  setChosenBaseRef(null);
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
                  label="Current branch"
                  detail={project?.currentBranch ?? undefined}
                  selected={!sideChat && workspaceMode === "current"}
                  onSelect={() => {
                    chooseWorkspaceMode("current");
                    setChosenBaseRef(null);
                    onOpenSheetChange(null);
                  }}
                />
                <SheetOption
                  label="New worktree"
                  selected={!sideChat && workspaceMode === "worktree" && chosenBaseRef === null}
                  onSelect={() => {
                    chooseWorkspaceMode("worktree");
                    setChosenBaseRef(null);
                    onOpenSheetChange(null);
                  }}
                />
                {projectWorktrees.length > 0 ? (
                  <p className="mobile-sheet-group-label">Branch from a worktree</p>
                ) : null}
                {projectWorktrees.map((wt) => (
                  <SheetOption
                    key={wt.id}
                    label={wt.taskLabel}
                    detail={wt.branch}
                    selected={
                      !sideChat &&
                      workspaceMode === "worktree" &&
                      chosenBaseRef === wt.branch
                    }
                    onSelect={() => {
                      chooseWorkspaceMode("worktree");
                      setChosenBaseRef(wt.branch);
                      onOpenSheetChange(null);
                    }}
                  />
                ))}
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
