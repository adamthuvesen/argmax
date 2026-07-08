import { Folder, GitBranch, Play, Plus, Square, X } from "lucide-react";
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
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useComposerAttachments } from "../hooks/useComposerAttachments.js";
import { useFileAutocomplete } from "../hooks/useFileAutocomplete.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import {
  appendReferencesToPrompt,
  imageAttachmentReference
} from "../lib/composerAttachments.js";
import {
  AGENT_MODE_LABELS,
  toggleAgentMode
} from "../lib/agentMode.js";
import { leadingSlashCommand } from "../lib/slashHighlight.js";
import type { ModelPickerSelection } from "../lib/models.js";
import { ChangeCount } from "./ChangeCount.js";
import { FilePopover } from "./FilePopover.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { LaunchModelSelector, ModelSelector } from "./ModelSelector.js";
import { SkillPopover } from "./SkillPopover.js";

const PROMPT_MAX_HEIGHT_PX = 140;

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
  inputRef,
  isQueueing,
  onFastModeEnabledChange,
  onCancelQueuedMessage,
  onSendSessionInput,
  onTerminateSession,
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
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  isQueueing: boolean;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onCancelQueuedMessage?: (sessionId: string, messageId: string) => Promise<void>;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onTerminateSession: (sessionId: string) => Promise<void>;
  pendingMessages: PendingMessage[];
  reviewPanelOpen: boolean;
  selectedModel: ModelPickerSelection;
  session: SessionSummary | null;
  setAgentMode: Dispatch<SetStateAction<AgentMode>>;
  setSelectedModel: Dispatch<SetStateAction<ModelPickerSelection>>;
  setStatus: (message: string | null) => void;
  shouldRefocusInput: MutableRefObject<boolean>;
  status: string | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const inputFormRef = useRef<HTMLFormElement | null>(null);
  const sessionId = session?.id ?? null;
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
    sessionId,
    workspacePath: workspace?.path ?? null,
    setInput,
    setStatus
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

  const submitInput = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedInput = input.trim();
    if (!session || !trimmedInput || isSending) {
      return;
    }

    const refs = pendingAttachments.map((a) => imageAttachmentReference(a.filePath));
    const prompt = refs.length > 0 ? appendReferencesToPrompt(trimmedInput, refs) : trimmedInput;
    const attachmentsForPersist: ComposerAttachment[] = pendingAttachments.map((a) => ({
      filePath: a.filePath,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes
    }));

    setIsSending(true);
    setStatus(null);
    shouldRefocusInput.current = true;
    try {
      await onSendSessionInput(
        session.id,
        prompt,
        selectedModel,
        agentMode,
        attachmentsForPersist.length > 0 ? attachmentsForPersist : undefined
      );
      setInput("");
      clearAttachments();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send input.");
    } finally {
      setIsSending(false);
    }
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
      {pendingAttachments.length > 0 ? (
        <div className="composer-attachments" aria-label="Attached images">
          {pendingAttachments.map((attachment) => (
            <div key={attachment.id} className="composer-attachment-chip">
              <button
                type="button"
                className="attachment-open-button"
                aria-label="View attachment"
                title="View attachment"
                onClick={() => setLightboxSrc(attachment.thumbnailDataUrl)}
              >
                <img src={attachment.thumbnailDataUrl} alt="" />
              </button>
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
      {pendingMessages.length > 0 ? (
        <div className="composer-queued-lane" role="list" aria-label="Queued follow-ups">
          {pendingMessages.map((entry) => {
            const cancel = (): void => {
              if (!session || !onCancelQueuedMessage) return;
              void onCancelQueuedMessage(session.id, entry.id).catch(() => undefined);
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
                  if (event.key === "Backspace" || event.key === "Delete") {
                    event.preventDefault();
                    cancel();
                  }
                }}
              >
                <span className="composer-queued-chip-label">{entry.content}</span>
                <button
                  type="button"
                  className="composer-queued-chip-remove"
                  aria-label="Cancel queued follow-up"
                  title="Cancel queued follow-up"
                  onClick={cancel}
                >
                  <X size={12} />
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
                ariaLabel="Session model"
              />
            )}
          </div>
        ) : null}
        {workspace ? (
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
            <button
              type="button"
              className="composer-footer-chip composer-footer-chip--branch"
              title={`Branch: ${workspace.branch}`}
              aria-label={`Branch ${workspace.branch}`}
            >
              <GitBranch size={11} aria-hidden="true" />
              <span className="composer-footer-chip-label">{workspace.branch}</span>
            </button>
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
          <button
            className="session-send-button session-stop-button"
            type="button"
            title="Stop session"
            aria-label="Stop session"
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
        <p className="composer-status" role="status">
          {status}
        </p>
      ) : null}
      <ImageLightbox src={lightboxSrc} alt="Attached image" onClose={() => setLightboxSrc(null)} />
    </form>
  );
}
