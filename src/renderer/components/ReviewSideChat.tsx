import { useEffect, useId, useMemo, useRef, useState, type ComponentProps, type FormEvent, type JSX } from "react";
import { MessageSquarePlus, Paperclip, Play, Plus, X } from "lucide-react";
import { errorMessage } from "../../shared/error.js";
import type { ComposerAttachment, PendingMessage, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import { useComposerAttachments } from "../hooks/useComposerAttachments.js";
import { useProviderAvailability } from "../hooks/useProviderAvailability.js";
import { appendReferencesToPrompt, imageAttachmentReference } from "../lib/composerAttachments.js";
import { clearDraft } from "../lib/composerDrafts.js";
import { preferredLaunchModel, type ModelPickerSelection } from "../lib/models.js";
import { ComposerEditor } from "./ComposerEditor.js";
import type { ComposerField } from "./composerEditor/composerField.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { LaunchModelSelector } from "./ModelSelector.js";
import { MultitaskPanel } from "./MultitaskPanel.js";
import "../styles/review-side-chat.css";

export interface ReviewSideChatFormState {
  prompt: string;
  launching: boolean;
  error: string | null;
}

export interface ReviewSideChatSession {
  sessionId: string;
  workspaceId: string;
}

export type ReviewSideChatContext = Pick<ComponentProps<typeof MultitaskPanel>,
  | "chatFontSize"
  | "defaultToolCallsDisplay"
  | "defaultToolCallGroupsExpanded"
  | "thinkingDisplay"
  | "onCancelQueuedMessage"
  | "onClearSession"
  | "onLoadSessionEvents"
  | "onOpenFullChat"
  | "onSendQueuedMessageNow"
  | "onSendSessionInput"
  | "onTerminateSession"
> & {
  launch: (prompt: string, options?: {
    model?: ModelPickerSelection;
    attachments?: ComposerAttachment[];
  }) => Promise<ReviewSideChatSession>;
  selectedModel?: ModelPickerSelection;
  onModelChange?: (model: ModelPickerSelection) => void;
  autoRouting?: boolean;
  fastModeEnabled?: boolean;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  sessionsById: ReadonlyMap<string, SessionSummary>;
  workspacesById: ReadonlyMap<string, WorkspaceSummary>;
  pendingMessages?: Record<string, PendingMessage[]>;
};

export function ReviewSideChat({
  context,
  draftKey,
  sessionId,
  workspaceId,
  isFocused = true,
  formState: controlledFormState,
  onFormStateChange,
  onLaunched
}: {
  context: ReviewSideChatContext;
  draftKey?: string;
  sessionId?: string;
  workspaceId?: string;
  isFocused?: boolean;
  formState?: ReviewSideChatFormState;
  onFormStateChange?: (patch: Partial<ReviewSideChatFormState>) => void;
  onLaunched: (session: ReviewSideChatSession) => void;
}): JSX.Element {
  const fallbackDraftId = useId();
  const attachmentDraftKey = `side-chat-${(draftKey ?? fallbackDraftId).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const [localModel, setLocalModel] = useState(() => context.selectedModel ?? preferredLaunchModel([]));
  const selectedModel = context.selectedModel ?? localModel;
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [localFormState, setLocalFormState] = useState<ReviewSideChatFormState>({ prompt: "", launching: false, error: null });
  const { prompt, launching, error } = controlledFormState ?? localFormState;
  const updateForm = (patch: Partial<ReviewSideChatFormState>): void => {
    if (onFormStateChange) onFormStateChange(patch);
    else setLocalFormState((current) => ({ ...current, ...patch }));
  };
  const launchPending = useRef(false);
  const promptRef = useRef<ComposerField | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const { availability } = useProviderAvailability();
  const chatChips = useMemo(() => ({
    resolve: (id: string) => {
      const chat = context.sessionsById.get(id);
      if (!chat) return null;
      return { title: context.workspacesById.get(chat.workspaceId)?.taskLabel || chat.prompt };
    },
    open: (id: string) => context.onOpenFullChat?.(id)
  }), [context]);
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
    draftKey: attachmentDraftKey,
    workspacePath: null,
    fieldRef: promptRef,
    setInput: (updater) => updateForm({ prompt: updater(promptRef.current?.value ?? prompt) }),
    persist: !launching
  });

  useEffect(() => {
    if (isFocused && !sessionId) promptRef.current?.focus();
  }, [isFocused, sessionId]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = (promptRef.current?.value ?? prompt).trim();
    if ((!trimmed && pendingAttachments.length === 0) || launching || launchPending.current) return;
    launchPending.current = true;
    updateForm({ launching: true, error: null });
    try {
      const references = pendingAttachments.map((attachment) => imageAttachmentReference(attachment.filePath));
      const launched = await context.launch(appendReferencesToPrompt(trimmed, references), {
        model: selectedModel,
        attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined
      });
      clearDraft(attachmentDraftKey);
      clearAttachments();
      onLaunched(launched);
    } catch (cause) {
      updateForm({ error: errorMessage(cause) });
    } finally {
      launchPending.current = false;
      updateForm({ launching: false });
    }
  };

  if (sessionId) {
    const session = context.sessionsById.get(sessionId);
    const workspace = workspaceId ? context.workspacesById.get(workspaceId) ?? null : null;
    if (!session) {
      return (
        <div className="review-side-chat-empty" role="status">
          <p>This chat is unavailable.</p>
          {context.onOpenFullChat ? (
            <button type="button" className="button button-secondary" onClick={() => context.onOpenFullChat?.(sessionId)}>
              Open full chat
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <MultitaskPanel
        {...context}
        session={session}
        workspace={workspace}
        taskLabel={workspace?.taskLabel || "Side chat"}
        pendingMessages={context.pendingMessages?.[sessionId] ?? []}
        isFocused={isFocused}
      />
    );
  }

  return (
    <div className="review-side-chat-launch">
      <div className="review-side-chat-intro">
        <MessageSquarePlus size={24} strokeWidth={1.5} aria-hidden="true" />
        <h2>Side chat</h2>
        <p>Ask a separate question while your main chat stays open.</p>
      </div>
      <form
        ref={formRef}
        className="session-composer-stack review-side-chat-composer"
        data-font-size={context.chatFontSize === undefined ? undefined : String(context.chatFontSize)}
        data-type-scale={context.chatFontSize === undefined ? "composer" : undefined}
        onSubmit={(event) => { void submit(event); }}
        onDragEnter={launching ? undefined : onComposerDragEnter}
        onDragOver={launching ? undefined : onComposerDragOver}
        onDragLeave={launching ? undefined : onComposerDragLeave}
        onDrop={launching ? undefined : onComposerDrop}
      >
        <input ref={attachmentInputRef} type="file" multiple hidden aria-hidden="true" tabIndex={-1} onChange={onAttachmentInputChange} />
        <div className="session-input" data-drag-active={isDraggingFiles ? "true" : undefined}>
          <div className="composer-drop-overlay" aria-hidden="true">
            <Paperclip size={20} />
            <span>Drop to attach</span>
            <small>Images and files</small>
          </div>
          {pendingAttachments.length > 0 ? (
            <div className="composer-attachments" aria-label="Attached images">
              {pendingAttachments.map((attachment) => {
                const src = pendingAttachmentPreviews[attachment.filePath] ?? attachmentProtocolUrl(attachment.filePath);
                return (
                  <div key={attachment.filePath} className="composer-attachment-chip">
                    <button type="button" className="attachment-open-button" aria-label="View attachment" onClick={() => setLightboxSrc(src)}>
                      <img src={src} alt="" />
                    </button>
                    <button type="button" className="composer-attachment-remove" aria-label="Remove attachment" disabled={launching} onClick={() => removePendingAttachment(attachment.filePath)}>
                      <X size={12} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="session-input-field">
            <ComposerEditor
              fieldRef={promptRef}
              documentKey={attachmentDraftKey}
              ariaLabel="Side chat message"
              placeholder="Ask anything…"
              value={prompt}
              disabled={launching}
              onChange={(value) => updateForm({ prompt: value })}
              onPaste={onComposerPaste}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                  event.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
              chats={chatChips}
            />
          </div>
          <div className="session-input-toolbar">
            <button type="button" className="composer-tool" aria-label="Attach file" title="Attach file" disabled={launching} onClick={openFilePicker}>
              <Plus size={14} aria-hidden="true" />
            </button>
            <div className="composer-chips-group composer-chips-model" inert={launching}>
              <LaunchModelSelector
                ariaLabel="Side chat model"
                value={selectedModel}
                availability={availability}
                autoRouting={context.autoRouting}
                fastModeEnabled={context.fastModeEnabled}
                onFastModeEnabledChange={context.onFastModeEnabledChange}
                withEffortSlider
                portaled
                onChange={(model) => {
                  setLocalModel(model);
                  context.onModelChange?.(model);
                }}
              />
            </div>
            <span className="session-toolbar-spacer" />
            <button
              type="submit"
              className="session-send-button"
              aria-label="Start side chat"
              title="Start side chat"
              disabled={(!prompt.trim() && pendingAttachments.length === 0) || launching}
            >
              <Play size={13} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </button>
          </div>
        </div>
        {launching ? <p className="composer-status" role="status">Starting chat…</p> : null}
        {error ? <p className="composer-status" data-status="error" role="alert">{error}</p> : null}
      </form>
      <ImageLightbox src={lightboxSrc} alt="Attached image" onClose={() => setLightboxSrc(null)} />
    </div>
  );
}
