import {
  CornerDownRight,
  Folder,
  GitBranch,
  MoreHorizontal,
  Play,
  Plus,
  Send,
  Square,
  Trash2,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type SetStateAction,
  type UIEvent as ReactUIEvent
} from "react";
import type {
  AgentMode,
  ComposerAttachment,
  PendingMessage,
  SessionSummary,
  WorkspaceSummary
} from "../../shared/types.js";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useComposerAttachments } from "../hooks/useComposerAttachments.js";
import { useComposerDraft } from "../hooks/useComposerDraft.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useFileAutocomplete } from "../hooks/useFileAutocomplete.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import {
  appendReferencesToPrompt,
  imageAttachmentReference
} from "../lib/composerAttachments.js";
import {
  annotationChipLabel,
  prependAnnotationsToPrompt,
  type ComposerAnnotation
} from "../lib/composerAnnotations.js";
import {
  AGENT_MODE_LABELS,
  toggleAgentMode
} from "../lib/agentMode.js";
import { clearDraft } from "../lib/composerDrafts.js";
import { leadingSlashCommand } from "../lib/slashHighlight.js";
import type { ModelPickerSelection } from "../lib/models.js";
import { ChangeCount } from "./ChangeCount.js";
import { ContextRing } from "./ContextRing.js";
import { FilePopover } from "./FilePopover.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { LaunchModelSelector, ModelSelector } from "./ModelSelector.js";
import { SkillPopover } from "./SkillPopover.js";

const PROMPT_MAX_HEIGHT_PX = 140;

/**
 * Feedback line floating above the composer. Pane-local actions surface their
 * outcome here — a global toast can't say which pane it belongs to on a
 * multi-pane grid. Errors persist until the next action; info auto-clears.
 */
export interface ComposerStatus {
  kind: "error" | "info";
  message: string;
}

export interface ComposerChangeSummary {
  fileCount: number;
  additions: number;
  deletions: number;
  isOpen: boolean;
  onOpen: () => void;
}

export function SessionComposer({
  agentMode,
  canSend,
  changeSummary = null,
  fastModeEnabled = false,
  floating = false,
  inputRef,
  isQueueing,
  onFastModeEnabledChange,
  onCancelQueuedMessage,
  onSendQueuedMessageNow,
  onSendSessionInput,
  onTerminateSession,
  pendingAnnotations = [],
  onRemoveAnnotation,
  onClearAnnotations,
  pendingMessages,
  reviewPanelOpen,
  selectedModel,
  session,
  setAgentMode,
  setSelectedModel,
  setStatus,
  shouldRefocusInput,
  status,
  workspace
}: {
  agentMode: AgentMode;
  canSend: boolean;
  changeSummary?: ComposerChangeSummary | null;
  fastModeEnabled?: boolean;
  /** The "More details" popup: too narrow for the workspace-context cluster
      and file attach, so the toolbar keeps only model, mode, and send. */
  floating?: boolean;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  isQueueing: boolean;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onCancelQueuedMessage?: (sessionId: string, messageId: string) => Promise<void>;
  onSendQueuedMessageNow?: (sessionId: string, messageId: string) => Promise<void>;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onTerminateSession: (sessionId: string) => Promise<void>;
  /** Transcript excerpts attached via the selection toolbar; serialized into
      the prompt at send time and cleared through `onClearAnnotations`. */
  pendingAnnotations?: ComposerAnnotation[];
  onRemoveAnnotation?: (id: string) => void;
  onClearAnnotations?: () => void;
  pendingMessages: PendingMessage[];
  reviewPanelOpen: boolean;
  selectedModel: ModelPickerSelection;
  session: SessionSummary | null;
  setAgentMode: Dispatch<SetStateAction<AgentMode>>;
  setSelectedModel: Dispatch<SetStateAction<ModelPickerSelection>>;
  setStatus: (status: ComposerStatus | null) => void;
  shouldRefocusInput: MutableRefObject<boolean>;
  status: ComposerStatus | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const sessionId = session?.id ?? null;
  // Unsent text belongs to the session, not to this component: it survives
  // switching to another session and comes back when this one does.
  const [input, setInput] = useComposerDraft(sessionId);
  const [isSending, setIsSending] = useState(false);
  const [sendingQueuedMessageId, setSendingQueuedMessageId] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [workspaceDetailsOpen, setWorkspaceDetailsOpen] = useState(false);
  const inputFormRef = useRef<HTMLFormElement | null>(null);
  const workspaceDetailsRef = useRef<HTMLDivElement | null>(null);
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
    draftKey: sessionId,
    workspacePath: workspace?.path ?? null,
    setInput,
    // The attachments hook only ever reports failures (string status contract,
    // shared with LaunchSurface); lift them into the error kind here.
    setStatus: (message) => setStatus(message === null ? null : { kind: "error", message })
  });

  const slashAutocomplete = useSlashAutocomplete({
    input,
    setInput,
    provider: session?.provider ?? null,
    workspaceId: workspace?.id ?? null
  });

  const fileAutocomplete = useFileAutocomplete({
    input,
    setInput,
    inputRef,
    source: workspace ? { kind: "workspace", id: workspace.id } : null
  });

  useAutoGrowTextArea(inputRef, input, PROMPT_MAX_HEIGHT_PX);

  // Tint a leading `/command` token in the accent colour once it maps to a
  // real skill. A textarea can't colour a substring, so a mirror div renders
  // the same text behind a transparent-text textarea — mounted only while a
  // valid skill is present, so normal typing never routes through the overlay.
  const skillHighlight = useMemo(() => {
    const name = leadingSlashCommand(input);
    if (name === null || !slashAutocomplete.skillNames.has(name.toLowerCase())) {
      return null;
    }
    const head = `/${name}`;
    return { head, tail: input.slice(head.length) };
  }, [input, slashAutocomplete.skillNames]);
  const highlightBackdropRef = useRef<HTMLDivElement | null>(null);
  const syncHighlightScroll = useCallback((event: ReactUIEvent<HTMLTextAreaElement>): void => {
    const backdrop = highlightBackdropRef.current;
    if (backdrop) backdrop.scrollTop = event.currentTarget.scrollTop;
  }, []);
  const changeSummaryText = changeSummary
    ? `${changeSummary.fileCount} ${changeSummary.fileCount === 1 ? "file" : "files"} changed`
    : null;
  const changeSummaryAriaLabel = changeSummary
    ? `Open changed files in review panel: ${changeSummaryText}, ${changeSummary.additions} ` +
      `${changeSummary.additions === 1 ? "addition" : "additions"}, ${changeSummary.deletions} ` +
      `${changeSummary.deletions === 1 ? "deletion" : "deletions"}`
    : undefined;
  const workspaceDetailsLabel = workspace
    ? `Workspace details: branch ${workspace.branch}${
        changeSummaryText ? `, ${changeSummaryText}` : ""
      }`
    : "Workspace details";
  useDismissOnOutsideOrEscape(workspaceDetailsRef, workspaceDetailsOpen, () => setWorkspaceDetailsOpen(false));

  const toggleMode = useCallback((): void => {
    setAgentMode((mode) => toggleAgentMode(mode));
  }, [setAgentMode]);

  useEffect(() => {
    if (!shouldRefocusInput.current || isSending || !canSend) {
      return;
    }

    shouldRefocusInput.current = false;
    inputRef.current?.focus();
  }, [canSend, inputRef, isSending, shouldRefocusInput]);

  useEffect(() => {
    if (reviewPanelOpen || isSending || !canSend) return;
    // Touch devices (the phone companion) get no programmatic focus: it pops
    // the on-screen keyboard over half the viewport the moment a session
    // opens. Phones focus the composer only on an explicit tap.
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    inputRef.current?.focus();
  }, [reviewPanelOpen, canSend, inputRef, isSending]);

  const onSessionInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
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
      inputFormRef.current?.requestSubmit();
    }
  };

  /**
   * Build the prompt from the draft plus attachments and hand it to `deliver`.
   * The draft is only cleared once delivery resolves, so a failed send leaves
   * the text in place for a retry.
   */
  const deliverDraft = async (
    deliver: (
      sessionId: string,
      prompt: string,
      attachments: ComposerAttachment[] | undefined
    ) => Promise<void>
  ): Promise<void> => {
    const trimmedInput = input.trim();
    if (!session || !trimmedInput || isSending || sendingQueuedMessageId) {
      return;
    }

    const refs = pendingAttachments.map((a) => imageAttachmentReference(a.filePath));
    const withRefs = refs.length > 0 ? appendReferencesToPrompt(trimmedInput, refs) : trimmedInput;
    const prompt = prependAnnotationsToPrompt(withRefs, pendingAnnotations);

    setIsSending(true);
    setStatus(null);
    shouldRefocusInput.current = true;
    try {
      await deliver(session.id, prompt, pendingAttachments.length > 0 ? pendingAttachments : undefined);
      clearDraft(session.id);
      setInput("");
      clearAttachments();
      onClearAnnotations?.();
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not send input."
      });
    } finally {
      setIsSending(false);
    }
  };

  const submitInput = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    // Mid-turn this reaches the backend queue: Enter always means "line up the
    // follow-up", never "cut the current turn short".
    await deliverDraft((sessionId, prompt, attachments) =>
      onSendSessionInput(sessionId, prompt, selectedModel, agentMode, attachments)
    );
  };

  return (
    <form
      className="session-input"
      ref={inputFormRef}
      onSubmit={(event) => void submitInput(event)}
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
      {pendingAnnotations.length > 0 ? (
        <div className="composer-annotations" role="list" aria-label="Annotations">
          {pendingAnnotations.map((annotation) => (
            <div
              key={annotation.id}
              className="composer-annotation-chip"
              role="listitem"
              title={annotationChipLabel(annotation)}
              aria-label={`Annotation: ${annotationChipLabel(annotation)}`}
            >
              <span className="composer-annotation-chip-label">{annotationChipLabel(annotation)}</span>
              <button
                type="button"
                className="composer-annotation-remove"
                aria-label="Remove annotation"
                title="Remove annotation"
                onClick={() => onRemoveAnnotation?.(annotation.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {pendingAttachments.length > 0 ? (
        <div className="composer-attachments" aria-label="Attached images">
          {pendingAttachments.map((attachment) => (
            <div key={attachment.filePath} className="composer-attachment-chip">
              <button
                type="button"
                className="attachment-open-button"
                aria-label="View attachment"
                title="View attachment"
                onClick={() => setLightboxSrc(attachmentProtocolUrl(attachment.filePath))}
              >
                <img src={attachmentProtocolUrl(attachment.filePath)} alt="" />
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
          ))}
        </div>
      ) : null}
      {pendingMessages.length > 0 ? (
        <div className="composer-queued-lane" role="list" aria-label="Queued follow-ups">
          {pendingMessages.map((entry) => {
            const cancel = (): void => {
              if (!session || !onCancelQueuedMessage) return;
              void onCancelQueuedMessage(session.id, entry.id).catch(() => undefined);
            };
            const sendQueuedNow = async (): Promise<void> => {
              if (!session || !onSendQueuedMessageNow || sendingQueuedMessageId) return;
              setSendingQueuedMessageId(entry.id);
              setStatus(null);
              try {
                await onSendQueuedMessageNow(session.id, entry.id);
              } catch (error) {
                setStatus({
                  kind: "error",
                  message:
                    error instanceof Error ? error.message : "Could not send queued follow-up."
                });
              } finally {
                setSendingQueuedMessageId(null);
              }
            };
            return (
              <div
                key={entry.id}
                className="composer-queued-chip"
                role="listitem"
                tabIndex={0}
                title={entry.content}
                aria-label={`Queued follow-up: ${entry.content}`}
                onKeyDown={(event) => {
                  if (
                    sendingQueuedMessageId === null &&
                    (event.key === "Backspace" || event.key === "Delete")
                  ) {
                    event.preventDefault();
                    cancel();
                  }
                }}
              >
                <CornerDownRight
                  className="composer-queued-chip-icon"
                  size={14}
                  aria-hidden="true"
                />
                <span className="composer-queued-chip-label">{entry.content}</span>
                <span className="composer-queued-chip-state">Queued</span>
                <button
                  type="button"
                  className="composer-queued-chip-action"
                  aria-label={`Send queued follow-up now: ${entry.content}`}
                  title="Send now, interrupting the current turn"
                  disabled={sendingQueuedMessageId !== null}
                  onClick={() => void sendQueuedNow()}
                >
                  <Send size={13} aria-hidden="true" />
                  <span>Send now</span>
                </button>
                <button
                  type="button"
                  className="composer-queued-chip-remove"
                  aria-label="Cancel queued follow-up"
                  title="Cancel queued follow-up"
                  disabled={sendingQueuedMessageId !== null}
                  onClick={cancel}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="session-input-field">
        {skillHighlight ? (
          <div className="composer-highlight-backdrop" aria-hidden="true" ref={highlightBackdropRef}>
            <span className="composer-skill-token">{skillHighlight.head}</span>
            {skillHighlight.tail}
          </div>
        ) : null}
        <textarea
          className={skillHighlight ? "composer-input--highlighting" : undefined}
          aria-label="Session prompt"
          aria-autocomplete="list"
          aria-expanded={slashAutocomplete.popoverOpen || fileAutocomplete.popoverOpen}
          aria-controls={
            slashAutocomplete.popoverOpen
              ? "skill-popover"
              : fileAutocomplete.popoverOpen
                ? "file-popover"
                : undefined
          }
          disabled={!canSend || isSending}
          onChange={(event) => {
            setInput(event.target.value);
            fileAutocomplete.onSelectionChange(event);
          }}
          onKeyDown={onSessionInputKeyDown}
          onPaste={onComposerPaste}
          onScroll={syncHighlightScroll}
          onSelect={fileAutocomplete.onSelectionChange}
          onClick={fileAutocomplete.onSelectionChange}
          placeholder={
            canSend
              ? isQueueing
                ? "Queue a follow-up — sent when the current turn finishes"
                : "Reply to your agent, or @-mention files"
              : ""
          }
          ref={inputRef}
          value={input}
          rows={1}
        />
        <SkillPopover state={slashAutocomplete} inputRef={inputRef} />
        <FilePopover state={fileAutocomplete} inputRef={inputRef} />
      </div>
      <div className="session-input-toolbar">
        {session ? (
          <div className="composer-chips-group composer-chips-model">
            {session.state === "running" ? (
              // Mid-turn: the next message queues, so provider can't change yet —
              // keep the picker locked to the session's current provider.
              <ModelSelector
                provider={session.provider}
                value={selectedModel}
                onChange={(model) => setSelectedModel({ provider: session.provider, ...model })}
                fastModeEnabled={fastModeEnabled}
                onFastModeEnabledChange={onFastModeEnabledChange}
                withEffortSlider
                ariaLabel="Session model"
              />
            ) : (
              // Idle: switching provider here relaunches the agent under the new
              // provider on the next send, carrying context via the transcript.
              <LaunchModelSelector
                value={selectedModel}
                onChange={setSelectedModel}
                fastModeEnabled={fastModeEnabled}
                onFastModeEnabledChange={onFastModeEnabledChange}
                withEffortSlider
                ariaLabel="Session model"
              />
            )}
          </div>
        ) : null}
        {session && !floating ? <ContextRing session={session} /> : null}
        {workspace && !floating ? (
          <div className="composer-footer composer-chips-group composer-chips-context" aria-label="Workspace context">
            {workspace.sharedWorkspace ? null : (
              <button
                type="button"
                className="composer-footer-chip"
                title={`Open worktree: ${workspace.path}`}
                aria-label={`Open worktree at ${workspace.path}`}
                onClick={() => {
                  if (!window.argmax) return;
                  void window.argmax.system.openPath({ path: workspace.path }).catch(() => undefined);
                }}
              >
                <Folder size={11} aria-hidden="true" />
                <span className="composer-footer-chip-label">Worktree</span>
              </button>
            )}
            {workspace.kind === "git" ? (
              <button
                type="button"
                className="composer-footer-chip composer-footer-chip--branch"
                title={`Branch: ${workspace.branch}`}
                aria-label={`Branch ${workspace.branch}`}
              >
                <GitBranch size={11} aria-hidden="true" />
                <span className="composer-footer-chip-label">{workspace.branch}</span>
              </button>
            ) : null}
            {changeSummary ? (
              <button
                type="button"
                className="composer-footer-chip composer-footer-chip--changes"
                title={changeSummaryText ?? undefined}
                aria-label={changeSummaryAriaLabel}
                aria-pressed={changeSummary.isOpen}
                onClick={changeSummary.onOpen}
              >
                <ChangeCount additions={changeSummary.additions} deletions={changeSummary.deletions} />
              </button>
            ) : null}
          </div>
        ) : null}
        {workspace && !floating ? (
          <div className="composer-compact-context" ref={workspaceDetailsRef}>
            <button
              type="button"
              className="composer-compact-context-trigger"
              title={workspaceDetailsLabel}
              aria-label={workspaceDetailsLabel}
              aria-haspopup="dialog"
              aria-expanded={workspaceDetailsOpen}
              onClick={() => setWorkspaceDetailsOpen((open) => !open)}
            >
              <MoreHorizontal size={14} aria-hidden="true" />
              {changeSummary ? <span className="composer-compact-context-dot" aria-hidden="true" /> : null}
            </button>
            {workspaceDetailsOpen ? (
              <div className="composer-compact-context-popover" role="dialog" aria-label="Workspace details">
                {session ? (
                  <div className="composer-compact-context-row composer-compact-context-row--context">
                    <span>Context</span>
                    <ContextRing session={session} />
                  </div>
                ) : null}
                {workspace.sharedWorkspace ? null : (
                  <button
                    type="button"
                    className="composer-compact-context-row"
                    title={`Open worktree: ${workspace.path}`}
                    aria-label={`Open worktree at ${workspace.path}`}
                    onClick={() => {
                      setWorkspaceDetailsOpen(false);
                      if (!window.argmax) return;
                      void window.argmax.system.openPath({ path: workspace.path }).catch(() => undefined);
                    }}
                  >
                    <Folder size={12} aria-hidden="true" />
                    <span>Worktree</span>
                  </button>
                )}
                {changeSummary ? (
                  <button
                    type="button"
                    className="composer-compact-context-row composer-compact-context-row--changes"
                    aria-label={changeSummaryAriaLabel}
                    aria-pressed={changeSummary.isOpen}
                    onClick={() => {
                      setWorkspaceDetailsOpen(false);
                      changeSummary.onOpen();
                    }}
                  >
                    <span>Changes</span>
                    <ChangeCount additions={changeSummary.additions} deletions={changeSummary.deletions} />
                  </button>
                ) : null}
                {workspace.kind === "git" ? (
                  <div className="composer-compact-context-row" title={`Branch: ${workspace.branch}`}>
                    <GitBranch size={12} aria-hidden="true" />
                    <span className="composer-compact-context-branch">{workspace.branch}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {floating ? null : (
          <button
            className="composer-tool"
            type="button"
            title="Attach file"
            aria-label="Attach file"
            disabled={!canSend || isSending}
            onClick={openFilePicker}
          >
            <Plus size={14} />
          </button>
        )}
        <span className="session-toolbar-spacer" />
        {session ? (
          <div className="composer-chips-group composer-chips-mode">
            <button
              type="button"
              className="composer-context-chip agent-mode-toggle"
              aria-label="Agent mode"
              aria-pressed={agentMode === "plan"}
              title="Toggle agent mode (Shift+Tab)"
              disabled={!canSend || isSending}
              onClick={toggleMode}
            >
              {AGENT_MODE_LABELS[agentMode]}
            </button>
          </div>
        ) : null}
        {session && session.state === "running" ? (
          // One control while running: Stop. Enter queues the follow-up, and
          // interrupting is the queued chip's explicit "Send now" — a second
          // send button here made the running state read as a puzzle.
          <button
            className="session-send-button session-stop-button"
            type="button"
            title="Stop session"
            aria-label="Stop session"
            disabled={sendingQueuedMessageId !== null}
            onClick={() => void onTerminateSession(session.id)}
          >
            <Square size={9} fill="currentColor" strokeWidth={0} />
          </button>
        ) : (() => {
          const sendDisabled = !canSend || isSending || !input.trim();
          const sendTitle = isQueueing
            ? "Queue follow-up — sent when the current turn finishes"
            : "Send follow-up";
          return (
            <button
              className="session-send-button"
              type="submit"
              disabled={sendDisabled}
              title={sendTitle}
              aria-label={sendTitle}
            >
              <Play size={13} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </button>
          );
        })()}
      </div>
      {status ? (
        // Keyed on kind so a role swap remounts the live region — screen
        // readers don't reliably notice role changing in place.
        <p
          key={status.kind}
          className="composer-status"
          data-status={status.kind}
          role={status.kind === "error" ? "alert" : "status"}
        >
          {status.kind === "error" ? <span className="composer-status-dot" aria-hidden="true" /> : null}
          {status.message}
        </p>
      ) : null}
      <ImageLightbox src={lightboxSrc} alt="Attached image" onClose={() => setLightboxSrc(null)} />
    </form>
  );
}
