import {
  Bot,
  Columns2,
  CornerDownLeft,
  Eraser,
  FileDiff,
  Folder,
  FolderOpen,
  GitBranch,
  ListChecks,
  Maximize2,
  MoreHorizontal,
  Paperclip,
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
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useComposerAttachments } from "../hooks/useComposerAttachments.js";
import { useComposerDraft } from "../hooks/useComposerDraft.js";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useFileAutocomplete } from "../hooks/useFileAutocomplete.js";
import { useFollowUpSuggestion } from "../hooks/useFollowUpSuggestion.js";
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
import { isClearCommand, type ComposerCommand } from "../lib/composerCommands.js";
import { multitaskCommandPrompt } from "../lib/multitask.js";
import { clearDraft } from "../lib/composerDrafts.js";
import { appendOpenFilesToPrompt, openFilesChipLabel } from "../lib/openFileContext.js";
import { splitSkillTokens } from "../lib/slashHighlight.js";
import type { ModelPickerSelection } from "../lib/models.js";
import { ChangeCount } from "./ChangeCount.js";
import { ContextRing } from "./ContextRing.js";
import { FilePopover } from "./FilePopover.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { LaunchModelSelector, ModelSelector } from "./ModelSelector.js";
import { ProviderSwitchDialog } from "./ProviderSwitchDialog.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";
import { useProviderAvailability } from "../hooks/useProviderAvailability.js";

const PROMPT_MAX_HEIGHT_PX = 168;

/**
 * Feedback line floating above the composer. Pane-local actions surface their
 * outcome here — a global toast can't say which pane it belongs to on a
 * multi-pane grid. Errors persist until the next action; info auto-clears.
 */
export interface ComposerStatus {
  kind: "error" | "info";
  message: string;
}

/** What the provider-switch dialog hands the launcher when the user takes the
 *  recommended path: the model they picked, and the follow-up they had
 *  half-written for the old agent. */
export interface NewSessionSeed {
  model: ModelPickerSelection;
  prompt: string;
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
  onMultitask,
  onExpandToFullChat,
  onSendSessionInput,
  onStartNewSession,
  onTerminateSession,
  onClearSession,
  pendingAnnotations = [],
  onRemoveAnnotation,
  onClearAnnotations,
  openFilePaths = [],
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
  /** Dispatch a prompt as a multitask: a sibling chat in this checkout that
   *  runs alongside the current turn instead of waiting behind it. */
  onMultitask?: (sessionId: string, prompt: string) => Promise<void>;
  /** For a chat that lives inside a panel (a multitask in the Agents dock):
   *  promote it to the pane it is docked beside. Absent in a pane, which is
   *  already the full chat. */
  onExpandToFullChat?: () => void;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  /** Offered by the provider-switch dialog as the recommended alternative:
      opens the launcher with the picked model and this composer's draft. */
  onStartNewSession?: (seed: NewSessionSeed) => void;
  onTerminateSession: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
  onClearSession: (sessionId: string) => Promise<void>;
  /** Transcript excerpts attached via the selection toolbar; serialized into
      the prompt at send time and cleared through `onClearAnnotations`. */
  pendingAnnotations?: ComposerAnnotation[];
  onRemoveAnnotation?: (id: string) => void;
  onClearAnnotations?: () => void;
  /** Paths open as tabs in the review panel, active tab first; appended to the
      prompt as `@path` references at send time unless the chip is dismissed. */
  openFilePaths?: string[];
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
  const [isSending, setIsSending] = useState(false);
  // Unsent text belongs to the session, not to this component: it survives
  // switching to another session and comes back when this one does.
  const [input, setInput] = useComposerDraft(sessionId, { persist: !isSending });
  const [sendingQueuedMessageId, setSendingQueuedMessageId] = useState<string | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [workspaceDetailsOpen, setWorkspaceDetailsOpen] = useState(false);
  // A pick that changes provider is held here until the user confirms: the new
  // agent can't resume this one's conversation, so the swap is worth a beat.
  // Cancelling drops the pick and the composer keeps the current provider. The
  // session id rides along because this pane outlives the session it shows: a
  // held pick must not land on whatever session the pane retargets to.
  const [pendingProviderSwitch, setPendingProviderSwitch] = useState<
    { sessionId: string; model: ModelPickerSelection } | null
  >(null);
  const { availability: providerAvailability } = useProviderAvailability();
  // The placeholder answers the agent's last message instead of repeating the
  // same generic hint at every turn. Not gated on an empty draft: the
  // placeholder is invisible once there is text, and re-running on every keypress
  // would spend a CLI call each time the draft went back to empty.
  const followUpSuggestion = useFollowUpSuggestion(session, canSend && !isQueueing);
  // Dismissing the open-files chip skips those paths until the set of open
  // tabs changes, at which point the new set rides along again.
  const [dismissedOpenFilesKey, setDismissedOpenFilesKey] = useState<string | null>(null);
  const openFilesKey = openFilePaths.join("\n");
  const openFilesAttached = openFilePaths.length > 0 && dismissedOpenFilesKey !== openFilesKey;
  const inputFormRef = useRef<HTMLFormElement | null>(null);
  // The "…" panel sits nearest the composer's right edge, so it is the one that
  // most often flips to end-alignment. That flip is now derived from the space
  // available rather than hardcoded as `right: 0`, which was right only for as
  // long as the trigger stayed at the edge.
  const workspaceDetails = useAnchoredPopover({
    open: workspaceDetailsOpen,
    placement: "bottom-start",
    strategy: "absolute"
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
    draftKey: sessionId,
    workspacePath: workspace?.path ?? null,
    setInput,
    persist: !isSending,
    // The attachments hook only ever reports failures (string status contract,
    // shared with LaunchSurface); lift them into the error kind here.
    setStatus: (message) => setStatus(message === null ? null : { kind: "error", message })
  });

  const toggleMode = useCallback((): void => {
    setAgentMode((mode) => toggleAgentMode(mode));
  }, [setAgentMode]);

  // Composer actions offered above the skills in the `/` menu. Every entry is
  // a control that already exists in this toolbar — the menu is a keyboard
  // route to them, not a second set of features. Entries that would be a
  // no-op right now (no changes to review, nothing running) are left out
  // rather than shown disabled: a menu you can only reach by typing should
  // never answer with a dead row.
  const nextMode = toggleAgentMode(agentMode);
  const composerCommands = useMemo<ComposerCommand[]>(() => {
    const commands: ComposerCommand[] = [
      {
        name: nextMode,
        label: AGENT_MODE_LABELS[nextMode],
        hint:
          nextMode === "plan"
            ? "Draft a plan before touching anything"
            : "Work and approve each step",
        icon: nextMode === "plan" ? ListChecks : Bot,
        run: toggleMode
      }
    ];
    if (session?.state === "running") {
      commands.push({
        name: "stop",
        label: "Stop",
        hint: "Stop the agent mid-turn",
        icon: Square,
        run: () => void onTerminateSession(session.id)
      });
    }
    if (session) {
      commands.push({
        name: "clear",
        label: "Clear",
        hint: "Start a fresh conversation here",
        icon: Eraser,
        run: () => void onClearSession(session.id).catch(() => undefined)
      });
    }
    if (session && onMultitask) {
      commands.push({
        name: "multitask",
        label: "Multitask",
        hint: "Run something alongside this chat's turn",
        icon: Columns2,
        run: () => setInput("/multitask ")
      });
    }
    commands.push({
      name: "attach",
      label: "Attach file",
      hint: "Add an image or file to the prompt",
      icon: Paperclip,
      run: openFilePicker
    });
    if (changeSummary) {
      commands.push({
        name: "changes",
        label: "Changes",
        hint: `Open ${changeSummary.fileCount} changed ${
          changeSummary.fileCount === 1 ? "file" : "files"
        } in review`,
        icon: FileDiff,
        run: changeSummary.onOpen
      });
    }
    if (workspace && workspace.kind === "git" && !workspace.sharedWorkspace) {
      commands.push({
        name: "worktree",
        label: "Worktree",
        hint: "Open the worktree folder",
        icon: FolderOpen,
        run: () => {
          void window.argmax?.system.openPath({ path: workspace.path }).catch(() => undefined);
        }
      });
    }
    return commands;
  }, [
    changeSummary,
    nextMode,
    onClearSession,
    onMultitask,
    onTerminateSession,
    openFilePicker,
    session,
    setInput,
    toggleMode,
    workspace
  ]);

  const slashAutocomplete = useSlashAutocomplete({
    input,
    setInput,
    provider: session?.provider ?? null,
    workspaceId: workspace?.id ?? null,
    commands: composerCommands,
    inputRef
  });

  const fileAutocomplete = useFileAutocomplete({
    input,
    setInput,
    inputRef,
    source: workspace ? { kind: "workspace", id: workspace.id } : null
  });

  useAutoGrowTextArea(inputRef, input, PROMPT_MAX_HEIGHT_PX);

  // Tint every `/command` token that maps to a real skill — leading or
  // mid-message — in the accent colour. A textarea can't colour a substring,
  // so a mirror div renders the same text behind a transparent-text textarea —
  // mounted only while a valid skill is present, so normal typing never
  // routes through the overlay.
  const skillHighlight = useMemo(
    () => splitSkillTokens(input, (name) => slashAutocomplete.skillNames.has(name)),
    [input, slashAutocomplete.skillNames]
  );
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
  useDismissOnOutsideOrEscape(workspaceDetails.anchorRef, workspaceDetailsOpen, () =>
    setWorkspaceDetailsOpen(false)
  );

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
    if (
      event.key === "Tab" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing
    ) {
      // Tab belongs to the suggested follow-up: it drops the placeholder into
      // the draft so Enter sends it. Mode moved to Shift+Tab. Both swallow the
      // keypress either way — Tab out of the composer would lose the draft's
      // focus mid-thought.
      event.preventDefault();
      if (event.shiftKey) {
        toggleMode();
      } else if (followUpSuggestion && input.length === 0) {
        setInput(followUpSuggestion);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      inputFormRef.current?.requestSubmit();
    }
  };

  // An annotation is a message on its own: "Add to chat" and review comments
  // already name what the agent should look at, so send stays available with
  // an empty draft once a chip is attached.
  const hasSendableContent = input.trim().length > 0 || pendingAnnotations.length > 0;

  /**
   * Build the prompt from the draft plus attachments and hand it to `deliver`.
   * Storage is dropped as soon as send starts so a remount cannot restore it.
   * The on-screen text stays until delivery resolves, so a failed send can retry.
   */
  const deliverDraft = async (
    deliver: (
      sessionId: string,
      prompt: string,
      attachments: ComposerAttachment[] | undefined
    ) => Promise<void>
  ): Promise<void> => {
    const trimmedInput = input.trim();
    if (!session || !hasSendableContent || isSending || sendingQueuedMessageId) {
      return;
    }

    if (isClearCommand(trimmedInput)) {
      setIsSending(true);
      setStatus(null);
      shouldRefocusInput.current = true;
      clearDraft(session.id);
      try {
        await onClearSession(session.id);
        setInput("");
        clearAttachments();
        onClearAnnotations?.();
      } catch (error) {
        setStatus({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not clear the conversation."
        });
      } finally {
        setIsSending(false);
      }
      return;
    }

    // `/multitask <prompt>` dispatches instead of sending: the prompt goes to a
    // sibling chat in this checkout, and this composer's turn is left alone.
    const multitaskPrompt = multitaskCommandPrompt(trimmedInput);
    if (multitaskPrompt && onMultitask) {
      setIsSending(true);
      setStatus(null);
      shouldRefocusInput.current = true;
      try {
        await onMultitask(session.id, multitaskPrompt);
        setInput("");
        clearDraft(session.id);
      } catch (error) {
        setStatus({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not start the multitask."
        });
      } finally {
        setIsSending(false);
      }
      return;
    }

    const refs = pendingAttachments.map((a) => imageAttachmentReference(a.filePath));
    const withRefs = refs.length > 0 ? appendReferencesToPrompt(trimmedInput, refs) : trimmedInput;
    const withAnnotations = prependAnnotationsToPrompt(withRefs, pendingAnnotations);
    const prompt = openFilesAttached ? appendOpenFilesToPrompt(withAnnotations, openFilePaths) : withAnnotations;

    setIsSending(true);
    setStatus(null);
    shouldRefocusInput.current = true;
    clearDraft(session.id);
    try {
      await deliver(session.id, prompt, pendingAttachments.length > 0 ? pendingAttachments : undefined);
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
      className="session-composer-stack"
      // The agent window carries its own type scale (Settings → chat font
      // size), which is about reading the transcript. The composer is chrome —
      // model chip, repo, branch, changed files — so it holds the composer
      // scale instead, matching the launcher's composer. See tokens.css.
      data-type-scale="composer"
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
            // Promoting a queued message never touches the running turn: it
            // is dropped from the queue and dispatched as its own chat, so
            // rapid promotions cannot cancel each other the way "send now"
            // (which stops the turn) has to.
            const multitaskQueued = async (id: string, content: string): Promise<void> => {
              if (!session || !onMultitask || sendingQueuedMessageId) return;
              setSendingQueuedMessageId(id);
              setStatus(null);
              try {
                await onMultitask(session.id, content);
              } catch (error) {
                setStatus({
                  kind: "error",
                  message:
                    error instanceof Error ? error.message : "Could not start the multitask."
                });
                setSendingQueuedMessageId(null);
                return;
              }
              try {
                // The multitask is already running, so a dequeue that fails is
                // not a failed multitask — it is a message that would run the
                // same prompt a second time when the queue drains, which is
                // what this says.
                await onCancelQueuedMessage?.(session.id, id);
              } catch (error) {
                setStatus({
                  kind: "error",
                  message:
                    error instanceof Error
                      ? error.message
                      : "The multitask started, but the queued message could not be removed."
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
                <CornerDownLeft
                  className="composer-queued-chip-icon"
                  size={14}
                  aria-hidden="true"
                />
                <span className="composer-queued-chip-label">{entry.content}</span>
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
                {onMultitask ? (
                  <button
                    type="button"
                    className="composer-queued-chip-action"
                    aria-label={`Multitask queued follow-up: ${entry.content}`}
                    title="Run it now in a second chat sharing this checkout; the current turn keeps going"
                    disabled={sendingQueuedMessageId !== null}
                    onClick={() => void multitaskQueued(entry.id, entry.content)}
                  >
                    <Columns2 size={13} aria-hidden="true" />
                    <span>Multitask</span>
                  </button>
                ) : null}
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
      <div className="session-input">
      {pendingAnnotations.length > 0 || openFilesAttached ? (
        <div className="composer-annotations" role="list" aria-label="Annotations">
          {openFilesAttached ? (
            <div
              className="composer-annotation-chip"
              role="listitem"
              title={openFilePaths.join("\n")}
              aria-label={`Attached context: ${openFilesChipLabel(openFilePaths)}`}
            >
              <span className="composer-annotation-chip-label">{openFilesChipLabel(openFilePaths)}</span>
              <button
                type="button"
                className="composer-annotation-remove"
                aria-label="Don't attach open files"
                title="Don't attach open files"
                onClick={() => setDismissedOpenFilesKey(openFilesKey)}
              >
                <X size={12} />
              </button>
            </div>
          ) : null}
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
      <div className="session-input-field">
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
          aria-label="Chat prompt"
          aria-autocomplete="list"
          aria-expanded={slashAutocomplete.popoverOpen || fileAutocomplete.popoverOpen}
          aria-controls={
            slashAutocomplete.popoverOpen
              ? "slash-menu"
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
                ? "Queue a follow-up"
                : (followUpSuggestion ?? "Reply to your agent, or @-mention files")
              : ""
          }
          ref={inputRef}
          value={input}
          rows={1}
        />
        <SlashCommandMenu state={slashAutocomplete} />
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
                ariaLabel="Chat model"
              />
            ) : (
              // Idle: switching provider here relaunches the agent under the new
              // provider on the next send, carrying context via the transcript.
              // Same-provider model changes commit straight away; a different
              // provider goes through the confirmation below first.
              <LaunchModelSelector
                value={selectedModel}
                availability={providerAvailability}
                onChange={(model) => {
                  // `session.provider` only catches up when the backend
                  // relaunches on the next send, so after a confirmed switch
                  // the staged selection is the truth about what was already
                  // confirmed. Without it, a reasoning-effort nudge would
                  // re-raise the dialog and drop the change.
                  if (
                    model.provider !== session.provider &&
                    model.provider !== selectedModel.provider
                  ) {
                    setPendingProviderSwitch({ sessionId: session.id, model });
                    return;
                  }
                  setSelectedModel(model);
                }}
                fastModeEnabled={fastModeEnabled}
                onFastModeEnabledChange={onFastModeEnabledChange}
                withEffortSlider
                ariaLabel="Chat model"
              />
            )}
          </div>
        ) : null}
        {session && !floating ? <ContextRing session={session} /> : null}
        {workspace && !floating ? (
          <div className="composer-footer composer-chips-group composer-chips-context" aria-label="Workspace context">
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
          <div className="composer-compact-context" ref={workspaceDetails.setAnchor}>
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
              <div
                className="composer-compact-context-popover"
                role="dialog"
                aria-label="Workspace details"
                ref={workspaceDetails.setPopover}
                style={workspaceDetails.floatingStyles}
              >
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
                <button
                  type="button"
                  className="composer-compact-context-row composer-compact-context-row--attach"
                  title="Attach file"
                  aria-label="Attach file"
                  disabled={!canSend || isSending}
                  onClick={() => {
                    setWorkspaceDetailsOpen(false);
                    openFilePicker();
                  }}
                >
                  <Plus size={12} aria-hidden="true" />
                  <span>Attach file</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <span className="session-toolbar-spacer" />
        {onExpandToFullChat ? (
          <button
            type="button"
            className="composer-expand-button"
            title="Open as full chat"
            aria-label="Open as full chat"
            onClick={onExpandToFullChat}
          >
            <Maximize2 size={13} aria-hidden="true" />
          </button>
        ) : null}
        {session && agentMode !== "auto" ? (
          // Auto is the default, so naming it on every turn tells the user
          // nothing. Plan changes what the next send does, so it shows — and
          // the chip is then how you get back out. Shift+Tab toggles either way.
          <div className="composer-chips-group composer-chips-mode">
            <button
              type="button"
              className="composer-context-chip agent-mode-toggle"
              aria-label="Agent mode"
              aria-pressed
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
            title="Stop chat"
            aria-label="Stop chat"
            disabled={sendingQueuedMessageId !== null}
            onClick={() => void onTerminateSession(session.id)}
          >
            <Square size={9} fill="currentColor" strokeWidth={0} />
          </button>
        ) : (() => {
          const sendDisabled = !canSend || isSending || !hasSendableContent;
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
      {/* Only while the pick still applies: the same idle session it was made
          on. A turn starting mid-dialog would queue the follow-up and keep the
          current provider anyway, so the offer would be a lie. */}
      {session && pendingProviderSwitch?.sessionId === session.id && session.state !== "running" ? (
        <ProviderSwitchDialog
          from={session.provider}
          to={pendingProviderSwitch.model.provider}
          onCancel={() => setPendingProviderSwitch(null)}
          onSwitch={() => {
            setSelectedModel(pendingProviderSwitch.model);
            setPendingProviderSwitch(null);
            inputRef.current?.focus();
          }}
          onStartNewSession={
            onStartNewSession
              ? () => {
                  // The draft moves to the launcher rather than being copied:
                  // leaving it here too would offer the same text twice, in two
                  // composers that send to different agents.
                  onStartNewSession({ model: pendingProviderSwitch.model, prompt: input });
                  setInput("");
                  setPendingProviderSwitch(null);
                }
              : undefined
          }
        />
      ) : null}
    </form>
  );
}
