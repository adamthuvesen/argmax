import {
  Cloud,
  Columns2,
  CornerDownLeft,
  CornerUpRight,
  Eraser,
  FileDiff,
  FoldVertical,
  FolderOpen,
  GitBranch,
  Maximize2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Play,
  PlugZap,
  Plus,
  Quote,
  Send,
  Square,
  Target,
  Trash2,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type MutableRefObject,
  type ReactNode
} from "react";
import type {
  AgentMode,
  AgentReference,
  ComposerAttachment,
  PendingMessage,
  ProviderId,
  QueuedMessageDelivery,
  SessionSummary,
  WorkspaceSummary
} from "../../shared/types.js";
import {
  cloudProviderName,
  isHostedCloudProvider,
  type HostedCloudProvider
} from "../../shared/cloudProviders.js";
import { PROVIDER_DISPLAY_NAMES, successorModelId } from "../../shared/providerModels.js";
import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import { selectionOfQueuedMessage } from "../lib/queuedSelection.js";
import { canSteerQueuedMessage, hasSteeringContextHeadroom } from "../lib/queuedSteer.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";
import { useComposerAttachments } from "../hooks/useComposerAttachments.js";
import { useComposerDraft } from "../hooks/useComposerDraft.js";
import { useFileAutocomplete } from "../hooks/useFileAutocomplete.js";
import { useFollowUpSuggestion } from "../hooks/useFollowUpSuggestion.js";
import { useWindowSnapshotAttach } from "../hooks/useWindowSnapshotAttach.js";
import { windowSnapshotLabel } from "../lib/windowSnapshotInbox.js";
import { useRouteSwitch, useRouteSwitchElapsed } from "../hooks/useRouteSwitch.js";
import { routeSwitchPace } from "../lib/routeSwitch.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
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
  dispatchedCommandNames,
  isClearCommand,
  cloudCommandPrompt,
  isMcpCommand,
  type ComposerCommand
} from "../lib/composerCommands.js";
import { multitaskCommandPrompt } from "../lib/multitask.js";
import { parseGoalCommand } from "../lib/goalCommand.js";
import { clearDraft, writeDraftAttachments, writeDraftText } from "../lib/composerDrafts.js";
import { appendOpenFilesToPrompt, openFilesChipLabel } from "../lib/openFileContext.js";
import {
  AUTO_TIER_SHORT_LABELS,
  autoSessionChipLabel,
  isAutoTier,
  type ModelPickerSelection
} from "../lib/models.js";
import { chatChipEnvironmentFor } from "../lib/chatChipEnvironment.js";
import { chatReferencesAsTitles } from "../lib/composerContext.js";
import { openChat, useChatDirectory } from "../state/chatDirectory.js";
import { ChangeCount } from "./ChangeCount.js";
import { ComposerEditor } from "./ComposerEditor.js";
import { ComposerUsageSlot } from "./ComposerUsageSlot.js";
import type { ComposerField } from "./composerEditor/composerField.js";
import { CloudTaskDialog } from "./CloudTaskDialog.js";
import { ConnectionDialog } from "./ConnectionDialog.js";
import { isRemoteBridge } from "../lib/tauriBridge.js";
import { ContextRing } from "./ContextRing.js";
import { FilePopover } from "./FilePopover.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { LaunchModelSelector, type ChipRouteSwitch } from "./ModelSelector.js";
import { ProviderSwitchDialog } from "./ProviderSwitchDialog.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";
import { useProviderAvailability } from "../hooks/useProviderAvailability.js";
import type { FontSize } from "../lib/fonts.js";
import type { FollowUpDelivery } from "../lib/uiPreferences.js";
import { showErrorToast } from "../state/toast.js";
import { errorMessage } from "../../shared/error.js";

const NO_SENT_PROMPTS: readonly string[] = [];

/**
 * Feedback line floating above the composer for draft guidance and information.
 */
export interface ComposerStatus {
  kind: "error" | "info";
  message: string;
}

/** The model and complete draft moved from a chat to the new-session launcher. */
export interface NewSessionSeed {
  model: ModelPickerSelection;
  prompt: string;
  attachments: ComposerAttachment[];
}

interface ComposerChangeSummary {
  fileCount: number;
  additions: number;
  deletions: number;
  isOpen: boolean;
  onOpen: () => void;
}

export function SessionComposer({
  canSend,
  chatFontSize,
  changeSummary = null,
  fastModeEnabled = false,
  floating = false,
  inputRef,
  isFocused = true,
  isQueueing,
  defaultFollowUpDelivery = "queue",
  sentPrompts = NO_SENT_PROMPTS,
  onFastModeEnabledChange,
  onDraftPresentChange,
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
  setSelectedModel,
  setStatus,
  shouldRefocusInput,
  status,
  workspace,
  contextIndicatorEnabled = false,
  goalEnabled = true,
  goalMaxTurns,
  goalStatus
}: {
  canSend: boolean;
  /** Settings → Appearance: keep this composer on the agent-window scale. */
  chatFontSize?: FontSize;
  changeSummary?: ComposerChangeSummary | null;
  fastModeEnabled?: boolean;
  /** The "More details" popup: too narrow for the workspace-context cluster
      and file attach, so the toolbar keeps only model, mode, and send. */
  floating?: boolean;
  inputRef: MutableRefObject<ComposerField | null>;
  isFocused?: boolean;
  /** The user's messages in this chat, oldest first; ↑ in an empty draft
      steps back through them. */
  sentPrompts?: readonly string[];
  isQueueing: boolean;
  /** Settings → General: the first action for a mid-turn follow-up. */
  defaultFollowUpDelivery?: FollowUpDelivery;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onCancelQueuedMessage?: (sessionId: string, messageId: string) => Promise<void>;
  onSendQueuedMessageNow?: (
    sessionId: string,
    messageId: string,
    delivery?: QueuedMessageDelivery
  ) => Promise<void>;
  /** Dispatch a prompt as a multitask: a sibling chat in this checkout that
   *  runs alongside the current turn instead of waiting behind it. It inherits
   *  this chat's provider, which is why the call carries it. */
  onMultitask?: (
    sessionId: string,
    prompt: string,
    provider: ProviderId,
    pendingMessageId?: string
  ) => Promise<void>;
  /** For a chat that lives inside a panel (a multitask in the Agents dock):
   *  promote it to the pane it is docked beside. Absent in a pane, which is
   *  already the full chat. */
  onExpandToFullChat?: () => void;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[],
    agentReferences?: AgentReference[],
    delivery?: FollowUpDelivery
  ) => Promise<void>;
  /** Reports whether the composer is holding a draft. The question dock takes
   *  this slot, so it waits while there is typing here to preserve. */
  onDraftPresentChange?: (present: boolean) => void;
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
  setSelectedModel: (model: ModelPickerSelection) => void;
  setStatus: (status: ComposerStatus | null) => void;
  shouldRefocusInput: MutableRefObject<boolean>;
  status: ComposerStatus | null;
  workspace: WorkspaceSummary | null;
  /** Settings → Appearance: show context-window usage in the active composer. */
  contextIndicatorEnabled?: boolean;
  /** Settings → Agents → Conversation. Off removes `/goal` from the menu. */
  goalEnabled?: boolean;
  goalMaxTurns?: number;
  goalStatus?: ReactNode;
}): JSX.Element {
  const sessionId = session?.id ?? null;
  const [cloudDraft, setCloudDraft] = useState<{
    sessionId: string;
    provider: HostedCloudProvider;
    initialBrief?: string;
    draftInput: string;
  } | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [sendingSessionId, setSendingSessionId] = useState<string | null>(null);
  const isSending = sendingSessionId !== null;
  const persistCurrentDraft = sendingSessionId === null || sendingSessionId !== sessionId;
  // Unsent text belongs to the session, not to this component: it survives
  // switching to another session and comes back when this one does.
  const [input, setInput] = useComposerDraft(sessionId, { persist: persistCurrentDraft });
  const [sendingQueuedMessageId, setSendingQueuedMessageId] = useState<string | null>(null);
  // Touch surfaces (the phone companion) have no Enter key sitting under the
  // hands, so the keyboard shortcuts this composer leans on need a button.
  const [isCoarsePointer] = useState(
    () => window.matchMedia?.("(pointer: coarse)").matches ?? false
  );
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // A pick that changes provider is held here until the user confirms: the new
  // agent can't resume this one's conversation, so the swap is worth a beat.
  // Cancelling drops the pick and the composer keeps the current provider. The
  // session id rides along because this pane outlives the session it shows: a
  // held pick must not land on whatever session the pane retargets to.
  const [pendingProviderSwitch, setPendingProviderSwitch] = useState<
    { sessionId: string; model: ModelPickerSelection } | null
  >(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const { availability: providerAvailability } = useProviderAvailability();
  // The placeholder answers the agent's last message instead of repeating the
  // same generic hint at every turn. Not gated on an empty draft: the
  // placeholder is invisible once there is text, and re-running on every keypress
  // would spend a CLI call each time the draft went back to empty.
  const followUpSuggestion = useFollowUpSuggestion(session, canSend && !isQueueing);
  // Dismissing the open-files chip skips those paths until the set of open
  // tabs changes, at which point the new set rides along again.
  const [dismissedOpenFilesKey, setDismissedOpenFilesKey] = useState<string | null>(null);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  // Below the toolbar's compact breakpoint the branch and the changed-file
  // count fold behind a "…" instead of vanishing: the count is the way into
  // the review panel, and model + effort keep the width it gives up.
  const [compactContextOpen, setCompactContextOpen] = useState(false);
  const compactContextRef = useRef<HTMLDivElement | null>(null);
  const openFilesKey = openFilePaths.join("\n");
  const openFilesAttached = openFilePaths.length > 0 && dismissedOpenFilesKey !== openFilesKey;
  const inputFormRef = useRef<HTMLFormElement | null>(null);
  const {
    pendingAttachments,
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
    clearAttachments,
    restoreAttachments,
    attachSavedAttachment,
    attachmentLabels
  } = useComposerAttachments({
    draftKey: sessionId,
    workspacePath: workspace?.path ?? null,
    setInput,
    fieldRef: inputRef,
    persist: persistCurrentDraft
  });

  useEffect(() => {
    onDraftPresentChange?.(input.trim() !== "" || pendingAttachments.length > 0);
  }, [input, pendingAttachments, onDraftPresentChange]);

  // A window capture goes to the composer the user is working in: this pane is
  // focused, can take input and is not mid-send. It lands like a pasted image,
  // in the draft that outlives this mount, and the field takes focus so the
  // next thing typed describes it.
  useWindowSnapshotAttach(
    isFocused && sessionId !== null && canSend && !isSending,
    (snapshot) => {
      attachSavedAttachment(snapshot.attachment, windowSnapshotLabel(snapshot));
      inputRef.current?.focus();
    },
    floating
  );

  // ⌘⇧M and ⌘⇧E open the model and effort pickers. Document-level like the
  // pane's ⌘B / ⌘G, and gated on focus the same way, so the chord works while
  // the draft has the caret and only the focused pane answers it.
  const hasSession = Boolean(session);
  const supportsEffort = selectedModel.reasoningEffort != null;
  // A routed chat names its tier and the model the router chose. Picking a
  // different model pins the chat, so the chip reads plainly from then on.
  const autoChipLabel =
    session &&
    selectedModel.provider === session.provider &&
    selectedModel.modelId === successorModelId(session.provider, session.modelId)
      ? (autoSessionChipLabel(session) ?? undefined)
      : undefined;
  const autoChipTitle = autoChipLabel ? (session?.autoRoute ?? undefined) : undefined;
  // When the router moves the chat to another model or effort, the chip plays
  // the switch, and the router's reason borrows the placeholder line for a
  // moment: a reroute lands on send, when the draft has just emptied.
  const routeSwitch = useRouteSwitch(session);
  const chipRouteSwitch: ChipRouteSwitch | null =
    routeSwitch && session && autoChipLabel
      ? {
          ...routeSwitch,
          // A launch unfolds from the launcher's tier-only chip ("Balance").
          fromChipLabel: routeSwitch.from
            ? (autoSessionChipLabel({ ...session, ...routeSwitch.from }) ?? "")
            : isAutoTier(session.autoTier)
              ? AUTO_TIER_SHORT_LABELS[session.autoTier]
              : ""
        }
      : null;
  const captionPace = chipRouteSwitch ? routeSwitchPace(chipRouteSwitch) : null;
  const captionElapsed = useRouteSwitchElapsed(
    chipRouteSwitch,
    captionPace ? captionPace.delayMs + captionPace.captionMs : 0
  );
  const [endedCaptionId, setEndedCaptionId] = useState<number | null>(null);
  const routeCaption =
    chipRouteSwitch?.reason && captionElapsed !== null && endedCaptionId !== chipRouteSwitch.id && input === ""
      ? chipRouteSwitch
      : null;
  useEffect(() => {
    if (!isFocused || !hasSession) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
      if (event.isComposing || event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === "m") {
        event.preventDefault();
        setEffortPickerOpen(false);
        setModelPickerOpen((open) => !open);
        return;
      }
      if (key === "e" && supportsEffort) {
        event.preventDefault();
        setModelPickerOpen(false);
        setEffortPickerOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [hasSession, isFocused, supportsEffort]);

  // Composer actions offered above the skills in the `/` menu. Every entry is
  // a control that already exists in this toolbar — the menu is a keyboard
  // route to them, not a second set of features. Entries that would be a
  // no-op right now (no changes to review, nothing running) are left out
  // rather than shown disabled: a menu you can only reach by typing should
  // never answer with a dead row.
  const composerCommands = useMemo<ComposerCommand[]>(() => {
    const commands: ComposerCommand[] = [];
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
        run: () => void onClearSession(session.id).catch((error: unknown) => {
          showErrorToast(errorMessage(error) || "Could not clear the chat.");
        })
      });
      commands.push({
        name: "mcp",
        label: "Connections",
        hint: "Show MCP servers, plugins, and connectors",
        icon: PlugZap,
        run: () => setConnectionsOpen(true)
      });
    }
    if (session && workspace?.kind === "git" && isHostedCloudProvider(selectedModel.provider)) {
      commands.push({
        name: "cloud",
        label: "Cloud",
        hint: `Send a task to ${cloudProviderName(selectedModel.provider)}`,
        icon: Cloud,
        writesDraft: true,
        run: () => setInput("/cloud ")
      });
    }
    // `/compact` is sent as ordinary prompt text. Claude and Grok run it
    // themselves; Codex and OpenCode have no such command, so the Rust adapter
    // turns the exact prompt into their compact call. Cursor has no
    // equivalent, so it gets no entry.
    if (session && session.provider !== "cursor") {
      commands.push({
        name: "compact",
        label: "Compact",
        hint: "Summarize the conversation to free up context",
        icon: FoldVertical,
        writesDraft: true,
        run: () => setInput("/compact ")
      });
    }
    if (session && onMultitask) {
      commands.push({
        name: "multitask",
        label: "Multitask",
        hint: "Run something alongside this chat's turn",
        icon: Columns2,
        writesDraft: true,
        run: () => setInput("/multitask ")
      });
    }
    if (session && goalEnabled) {
      commands.push({
        name: "goal",
        label: "Goal",
        hint: "Keep working until a condition holds",
        icon: Target,
        writesDraft: true,
        run: () => setInput("/goal ")
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
          void window.argmax?.system.openPath({ path: workspace.path }).catch((error: unknown) => {
            showErrorToast(error instanceof Error ? error.message : "Could not open the worktree folder.");
          });
        }
      });
    }
    return commands;
  }, [
    changeSummary,
    goalEnabled,
    onClearSession,
    onMultitask,
    onTerminateSession,
    openFilePicker,
    session,
    selectedModel.provider,
    setInput,
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

  const chatDirectory = useChatDirectory();
  const fileAutocomplete = useFileAutocomplete({
    input,
    setInput,
    inputRef,
    source: workspace ? { kind: "workspace", id: workspace.id } : null,
    chats: chatDirectory,
    ownSessionId: sessionId
  });
  const chatChips = useMemo(
    () => chatChipEnvironmentFor(chatDirectory, openChat),
    [chatDirectory]
  );

  const dispatchedNames = useMemo(
    () =>
      dispatchedCommandNames({
        hasSession: session !== null,
        canMultitask: onMultitask !== undefined,
        canCloud: workspace?.kind === "git",
        goalEnabled
      }),
    [goalEnabled, onMultitask, session, workspace?.kind]
  );
  // Tint every `/command` token that maps to a real skill or one of those
  // commands, leading or mid-message, in the accent colour.
  const isSkillToken = useCallback(
    (name: string): boolean => slashAutocomplete.skillNames.has(name) || dispatchedNames.has(name),
    [dispatchedNames, slashAutocomplete.skillNames]
  );
  const changeSummaryText = changeSummary
    ? `${changeSummary.fileCount} ${changeSummary.fileCount === 1 ? "file" : "files"} changed`
    : null;
  const changeSummaryAriaLabel = changeSummary
    ? `Open changed files in review panel: ${changeSummaryText}, ${changeSummary.additions} ` +
      `${changeSummary.additions === 1 ? "addition" : "additions"}, ${changeSummary.deletions} ` +
      `${changeSummary.deletions === 1 ? "deletion" : "deletions"}`
    : undefined;
  const branchLabel = workspace?.kind === "git" ? workspace.branch : null;
  // Nothing to fold means no trigger: a non-git workspace with a clean tree
  // would otherwise put a "…" on the row that opens an empty panel.
  const hasWorkspaceContext = !floating && (branchLabel !== null || changeSummary !== null);
  const workspaceContextSummary = `Workspace context: ${[branchLabel, changeSummaryText]
    .filter((part) => part !== null)
    .join(" · ")}`;
  useDismissOnOutsideOrEscape(compactContextRef, compactContextOpen, () =>
    setCompactContextOpen(false)
  );
  // Where the caret goes once text is put into the prompt for the user to
  // work on — set by the queued chip's Edit action. It has to wait for the
  // render that carries the new text: seeking on the old value would land in
  // the wrong place, or out of range.
  const caretAfterInput = useRef<number | null>(null);
  // Which sent prompt ↑/↓ last put in the draft. It only counts while the
  // draft still holds that prompt verbatim: an edit makes it the user's text,
  // and the arrows go back to moving the caret.
  const recalledPrompt = useRef<{ sessionId: string | null; index: number } | null>(null);
  useEffect(() => {
    const caret = caretAfterInput.current;
    if (caret === null) return;
    caretAfterInput.current = null;
    const field = inputRef.current;
    if (!field) return;
    if (isFocused) field.focus();
    field.setSelectionRange(caret, caret);
  }, [input, inputRef, isFocused]);

  const wasFocused = useRef(false);
  useEffect(() => {
    const becameFocused = isFocused && !wasFocused.current;
    wasFocused.current = isFocused;
    if (!isFocused || isSending || !canSend) return;
    const refocusRequested = shouldRefocusInput.current;
    shouldRefocusInput.current = false;
    // Touch devices (the phone companion) get no programmatic focus: it pops
    // the on-screen keyboard over half the viewport the moment a session
    // opens. Refocusing after an explicit send is still allowed.
    if (!refocusRequested && (reviewPanelOpen || isCoarsePointer)) return;
    // Sending can finish after the reader has moved to another pane or
    // control. Only activating this pane gets to claim focus from outside here.
    const active = document.activeElement;
    // Keyboard navigation can activate a pane through another control. Keep
    // that control focused instead of redirecting its first keystroke.
    if (becameFocused && !inputRef.current?.contains(active) && inputRef.current?.closest('[role="region"]')?.contains(active)) return;
    if (!becameFocused && active !== document.body && !inputFormRef.current?.contains(active)) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [reviewPanelOpen, canSend, inputRef, isCoarsePointer, isFocused, isSending, shouldRefocusInput]);

  // What the field holds right now. React's copy of it can be a render behind
  // a keystroke that has just landed in the editor, and a submit that read the
  // old copy would send (or refuse to send) the prompt as it was a moment ago.
  const liveInput = (): string => inputRef.current?.value ?? input;

  const onSessionInputKeyDown = (event: KeyboardEvent): void => {
    slashAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    fileAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    if (
      event.key === "Tab" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.isComposing
    ) {
      if (!event.shiftKey && followUpSuggestion && liveInput().length === 0) {
        event.preventDefault();
        setInput(followUpSuggestion);
      }
      if (event.defaultPrevented) return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      inputFormRef.current?.requestSubmit();
      return;
    }
    // ↑ in an empty draft recalls the last sent message for editing, the
    // chat-app reflex for a typo or an afterthought; more ↑ steps further
    // back and ↓ comes forward again, past the newest to an empty draft.
    // A draft the user wrote keeps the keys' native meaning, and so does a
    // caret inside a recalled prompt, so arrows still move between its lines.
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.isComposing
    ) {
      const step = event.key === "ArrowUp" ? -1 : 1;
      const recalled = recalledPrompt.current;
      const current = liveInput();
      const recalledIndex =
        recalled?.sessionId === sessionId && sentPrompts[recalled.index] === current
          ? recalled.index
          : null;
      const selectionStart = inputRef.current?.selectionStart ?? 0;
      const selectionEnd = inputRef.current?.selectionEnd ?? selectionStart;
      // ↑ leaves a recalled prompt only from its first line and ↓ only from
      // its last, so the caret still walks a multiline prompt's lines.
      const caretAtEdge =
        selectionStart === selectionEnd &&
        (step === -1
          ? !current.slice(0, selectionStart).includes("\n")
          : !current.slice(selectionEnd).includes("\n"));
      let nextIndex: number | null = null;
      if (recalledIndex !== null && caretAtEdge) nextIndex = recalledIndex + step;
      else if (recalledIndex === null && current.length === 0 && step === -1) {
        nextIndex = sentPrompts.length - 1;
      }
      if (nextIndex === null || nextIndex < 0) return;
      event.preventDefault();
      const nextPrompt = sentPrompts[nextIndex];
      if (nextPrompt === undefined) {
        recalledPrompt.current = null;
        setInput("");
        return;
      }
      recalledPrompt.current = { sessionId, index: nextIndex };
      caretAfterInput.current = nextPrompt.length;
      setInput(nextPrompt);
    }
  };

  // Images, conversation excerpts, and diff notes can be the whole message.
  // Their references or quoted context become the prompt at delivery time.
  const hasSendableContent =
    input.trim().length > 0 || pendingAttachments.length > 0 || pendingAnnotations.length > 0;

  /**
   * Build the prompt from the draft plus attachments and hand it to `deliver`.
   * Storage and the on-screen text are cleared as soon as send starts. A failed
   * delivery restores both so the user can retry.
   */
  const deliverDraft = async (
    deliver: (
      sessionId: string,
      prompt: string,
      attachments: ComposerAttachment[] | undefined
    ) => Promise<void>
  ): Promise<void> => {
    const draftInput = liveInput();
    const trimmedInput = draftInput.trim();
    const hasContent =
      trimmedInput.length > 0 || pendingAttachments.length > 0 || pendingAnnotations.length > 0;
    if (!session || !hasContent || isSending || sendingQueuedMessageId) {
      return;
    }

    const cloudPrompt = cloudCommandPrompt(trimmedInput);
    if (cloudPrompt !== null) {
      if (workspace?.kind !== "git") {
        setStatus({ kind: "error", message: "Cloud tasks need a chat in a git workspace." });
        return;
      }
      if (!isHostedCloudProvider(selectedModel.provider)) {
        setStatus({ kind: "error", message: `${PROVIDER_DISPLAY_NAMES[selectedModel.provider]} can’t run cloud tasks.` });
        return;
      }
      if (pendingAttachments.length > 0) {
        setStatus({ kind: "error", message: "Cloud tasks support text only. Remove attachments before launching." });
        return;
      }
      if (pendingAnnotations.length > 0 || openFilesAttached) {
        setStatus({
          kind: "error",
          message: "Cloud tasks can’t include local annotations or open files. Remove them before launching."
        });
        return;
      }
      setStatus(null);
      setCloudDraft({
        sessionId: session.id,
        provider: selectedModel.provider,
        ...(cloudPrompt ? { initialBrief: cloudPrompt } : {}),
        draftInput
      });
      return;
    }

    if (isMcpCommand(trimmedInput)) {
      setInput("");
      clearDraft(session.id);
      setConnectionsOpen(true);
      return;
    }

    if (isClearCommand(trimmedInput)) {
      setSendingSessionId(session.id);
      setStatus(null);
      shouldRefocusInput.current = true;
      clearDraft(session.id);
      try {
        await onClearSession(session.id);
        setInput("");
        clearAttachments();
        onClearAnnotations?.();
      } catch (error) {
        showErrorToast(errorMessage(error) || "Could not clear the conversation.");
      } finally {
        setSendingSessionId((current) => (current === session.id ? null : current));
      }
      return;
    }

    // `/goal <condition>` configures the session rather than sending a message.
    // Setting one starts its own first turn when the chat is idle, so this
    // composer only clears the draft and gets out of the way.
    const goalCommand = goalEnabled ? parseGoalCommand(trimmedInput) : null;
    if (goalCommand && workspace) {
      setSendingSessionId(session.id);
      setStatus(null);
      shouldRefocusInput.current = true;
      try {
        if (goalCommand.kind === "clear") {
          await window.argmax!.goals.clear({ sessionId: session.id });
        } else {
          await window.argmax!.goals.set({
            workspaceId: workspace.id,
            sessionId: session.id,
            condition: goalCommand.condition,
            maxTurns: goalMaxTurns ?? null
          });
        }
        setInput("");
        clearDraft(session.id);
      } catch (error) {
        showErrorToast(error instanceof Error ? error.message : "Could not set the goal.");
      } finally {
        setSendingSessionId((current) => (current === session.id ? null : current));
      }
      return;
    }

    // `/multitask <prompt>` dispatches instead of sending: the prompt goes to a
    // sibling chat in this checkout, and this composer's turn is left alone.
    const multitaskPrompt = multitaskCommandPrompt(trimmedInput);
    if (multitaskPrompt && onMultitask) {
      setSendingSessionId(session.id);
      setStatus(null);
      shouldRefocusInput.current = true;
      try {
        await onMultitask(session.id, multitaskPrompt, session.provider);
        setInput("");
        clearDraft(session.id);
      } catch (error) {
        showErrorToast(error instanceof Error ? error.message : "Could not start the multitask.");
      } finally {
        setSendingSessionId((current) => (current === session.id ? null : current));
      }
      return;
    }

    const attachmentsToSend = pendingAttachments;
    const refs = attachmentsToSend.map((a) => imageAttachmentReference(a.filePath));
    const withRefs = refs.length > 0 ? appendReferencesToPrompt(trimmedInput, refs) : trimmedInput;
    const withAnnotations = prependAnnotationsToPrompt(withRefs, pendingAnnotations);
    const prompt = openFilesAttached ? appendOpenFilesToPrompt(withAnnotations, openFilePaths) : withAnnotations;

    setSendingSessionId(session.id);
    setStatus(null);
    shouldRefocusInput.current = true;
    clearDraft(session.id);
    setInput("");
    try {
      await deliver(session.id, prompt, attachmentsToSend.length > 0 ? attachmentsToSend : undefined);
      if (sessionIdRef.current === session.id) {
        clearAttachments();
        onClearAnnotations?.();
      }
    } catch (error) {
      writeDraftText(session.id, draftInput);
      writeDraftAttachments(session.id, attachmentsToSend);
      if (sessionIdRef.current === session.id) {
        setInput(draftInput);
        restoreAttachments(attachmentsToSend);
      }
      showErrorToast(error instanceof Error ? error.message : "Could not send input.");
    } finally {
      setSendingSessionId((current) => (current === session.id ? null : current));
    }
  };

  const submitInput = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    // Queue is the default, but a user may choose to send immediate guidance
    // into the active turn. A near-full Codex context stays queued because an
    // automatic compaction can otherwise forget the first response to the
    // steer and answer it again. Idle sends retain the ordinary follow-up path.
    const delivery =
      isQueueing &&
      defaultFollowUpDelivery === "steer" &&
      session &&
      selectedModel.provider === session.provider &&
      hasSteeringContextHeadroom(session)
        ? "steer"
        : "queue";
    await deliverDraft((sessionId, prompt, attachments) =>
      onSendSessionInput(
        sessionId,
        prompt,
        selectedModel,
        "auto",
        attachments,
        undefined,
        delivery
      )
    );
  };

  return (
    <form
      className="session-composer-stack"
      data-font-size={chatFontSize === undefined ? undefined : String(chatFontSize)}
      data-type-scale={chatFontSize === undefined ? "composer" : undefined}
      ref={inputFormRef}
      onSubmit={(event) => void submitInput(event)}
      onDragEnter={onComposerDragEnter}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
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
      {goalStatus}
      {pendingMessages.length > 0 ? (
        <div className="composer-queued-lane" role="list" aria-label="Queued follow-ups">
          {pendingMessages.map((entry) => {
            const sessionIsRunning = session?.state === "running";
            // A chat reference reads as its title here; the raw link stays in
            // `entry.content`, which is what edit and send hand back.
            const shownContent = chatReferencesAsTitles(entry.content);
            const canSteer = session !== null && canSteerQueuedMessage(session, entry);
            const cancel = (): void => {
              if (!session || !onCancelQueuedMessage) return;
              void onCancelQueuedMessage(session.id, entry.id).catch((error: unknown) => {
                showErrorToast(error instanceof Error ? error.message : "Could not cancel this follow-up.");
              });
            };
            const sendQueuedNow = async (
              delivery: QueuedMessageDelivery = "interrupt"
            ): Promise<void> => {
              if (!session || !onSendQueuedMessageNow || sendingQueuedMessageId) return;
              setSendingQueuedMessageId(entry.id);
              setStatus(null);
              try {
                await onSendQueuedMessageNow(session.id, entry.id, delivery);
              } catch (error) {
                showErrorToast(error instanceof Error ? error.message : "Could not send queued follow-up.");
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
                await onMultitask(session.id, content, session.provider, id);
              } catch (error) {
                showErrorToast(error instanceof Error ? error.message : "Could not start the multitask.");
              } finally {
                setSendingQueuedMessageId(null);
              }
            };
            // Taking a queued follow-up back into the prompt to reword it. It
            // leaves the queue first: a dequeue that failed after the text was
            // restored would leave the same prompt in two places, and the
            // queued copy would still be delivered as written.
            const editQueued = async (id: string, content: string): Promise<void> => {
              if (!session || !onCancelQueuedMessage || sendingQueuedMessageId) return;
              setSendingQueuedMessageId(id);
              setStatus(null);
              try {
                await onCancelQueuedMessage(session.id, id);
              } catch (error) {
                showErrorToast(error instanceof Error
                  ? error.message
                  : "Could not take the queued follow-up back.");
                return;
              } finally {
                setSendingQueuedMessageId(null);
              }
              // A half-written draft is not thrown away for this. The queued
              // message would have been delivered before it, so it goes above
              // it, and the caret lands at the end of the restored text — the
              // part the user came here to change.
              const attachments = entry.attachments ?? [];
              const references = attachments.map((attachment) => imageAttachmentReference(attachment.filePath)).join(" ");
              const referenceStart = references ? content.lastIndexOf(references) : -1;
              const referenceEnd = referenceStart + references.length;
              const hasGeneratedReferences = referenceStart >= 0 &&
                (referenceStart === 0 || /\s/.test(content[referenceStart - 1] ?? "")) &&
                (referenceEnd === content.length || /\s/.test(content[referenceEnd] ?? ""));
              const restoredContent = hasGeneratedReferences
                ? `${content.slice(0, content[referenceStart - 1] === " " ? referenceStart - 1 : referenceStart)}${content.slice(referenceEnd)}`.trim()
                : content;
              // The follow-up comes back with the settings it was queued under:
              // its provider, model and effort. A row from before a provider
              // could be chosen names none, and leaves the picker alone.
              const queuedSelection = selectionOfQueuedMessage(entry, session);
              if (queuedSelection) setSelectedModel(queuedSelection);
              caretAfterInput.current = restoredContent.length;
              setInput((draft) =>
                restoredContent === "" ? draft : draft.trim() === "" ? restoredContent : `${restoredContent}\n\n${draft}`
              );
              restoreAttachments((current) => {
                const paths = new Set(current.map((attachment) => attachment.filePath));
                return [...current, ...attachments.filter((attachment) => !paths.has(attachment.filePath))];
              });
            };
            return (
              <div
                key={entry.id}
                className="composer-queued-chip"
                role="listitem"
                tabIndex={0}
                title={shownContent}
                aria-label={`Queued follow-up: ${shownContent}`}
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
                <span className="composer-queued-chip-copy">
                  <span className="composer-queued-chip-label">{shownContent}</span>
                  {entry.provider && session && entry.provider !== session.provider ? (
                    <span className="composer-queued-chip-provider" data-provider={entry.provider}>
                      {`Then ${PROVIDER_DISPLAY_NAMES[entry.provider]}`}
                    </span>
                  ) : null}
                  {entry.recoveryStatus ? (
                    <span
                      className="composer-queued-chip-recovery"
                      data-recovery-status={entry.recoveryStatus}
                    >
                      {entry.recoveryStatus === "delivery-unknown"
                        ? "Delivery uncertain • check the chat before sending again"
                        : "Paused • not sent"}
                    </span>
                  ) : null}
                </span>
                {canSteer ? (
                  <button
                    type="button"
                    className="composer-queued-chip-action"
                    aria-label={`Steer queued follow-up: ${shownContent}`}
                    title="Steer the current turn without stopping it"
                    disabled={sendingQueuedMessageId !== null}
                    onClick={() => void sendQueuedNow("steer")}
                  >
                    <CornerUpRight size={13} aria-hidden="true" />
                    <span>Steer</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="composer-queued-chip-action"
                  aria-label={`Send queued follow-up: ${shownContent}`}
                  title={
                    sessionIsRunning
                      ? "Stop the current turn and send this follow-up"
                      : "Send this follow-up"
                  }
                  disabled={sendingQueuedMessageId !== null}
                  onClick={() => void sendQueuedNow("interrupt")}
                >
                  <Send size={13} aria-hidden="true" />
                  <span>Send</span>
                </button>
                {onMultitask ? (
                  <button
                    type="button"
                    className="composer-queued-chip-action"
                    aria-label={`Multitask queued follow-up: ${shownContent}`}
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
                  className="composer-queued-chip-remove composer-queued-chip-edit"
                  aria-label={`Edit queued follow-up: ${shownContent}`}
                  title="Put it back in the prompt to reword"
                  disabled={sendingQueuedMessageId !== null}
                  onClick={() => void editQueued(entry.id, entry.content)}
                >
                  <Pencil size={13} aria-hidden="true" />
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
      <div className="session-input" data-drag-active={isDraggingFiles ? "true" : undefined}>
        <div className="composer-drop-overlay" aria-hidden="true">
          <Paperclip size={20} />
          <span>Drop to attach</span>
          <small>Images and files</small>
        </div>
      {pendingAnnotations.length > 0 || openFilesAttached ? (
        <div className="composer-annotations" role="list" aria-label="Annotations">
          {openFilesAttached ? (
            <div
              className="composer-annotation-chip"
              role="listitem"
              title={openFilePaths.join("\n")}
              aria-label={`Attached context: ${openFilesChipLabel(openFilePaths)}`}
            >
              <FolderOpen size={14} className="composer-annotation-icon" aria-hidden="true" />
              <span className="composer-annotation-chip-label">{openFilesChipLabel(openFilePaths)}</span>
              <button
                type="button"
                className="composer-annotation-remove"
                aria-label="Don't attach open files"
                title="Don't attach open files"
                onClick={() => setDismissedOpenFilesKey(openFilesKey)}
              >
                <X size={13} aria-hidden="true" />
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
              {annotation.kind === "excerpt" ? (
                <Quote size={14} className="composer-annotation-icon" aria-hidden="true" />
              ) : (
                <FileDiff size={14} className="composer-annotation-icon" aria-hidden="true" />
              )}
              <span className="composer-annotation-chip-label">{annotationChipLabel(annotation)}</span>
              <button
                type="button"
                className="composer-annotation-remove"
                aria-label="Remove annotation"
                title="Remove annotation"
                onClick={() => onRemoveAnnotation?.(annotation.id)}
              >
                <X size={13} aria-hidden="true" />
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
                aria-label={
                  attachmentLabels[attachment.filePath]
                    ? `View window capture: ${attachmentLabels[attachment.filePath]}`
                    : "View attachment"
                }
                title={attachmentLabels[attachment.filePath] ?? "View attachment"}
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
        {routeCaption ? (
          <div
            key={routeCaption.id}
            className="route-switch-caption"
            role="status"
            style={{
              animationDelay: `${(captionPace?.delayMs ?? 0) - (captionElapsed ?? 0)}ms`,
              animationDuration: `${captionPace?.captionMs ?? 0}ms`
            }}
            onAnimationEnd={() => setEndedCaptionId(routeCaption.id)}
          >
            <span className="route-switch-caption-direction" aria-hidden="true">
              {routeCaption.from === null ? "→" : routeCaption.direction === "up" ? "↑" : "↓"}
            </span>
            {routeCaption.reason}
          </div>
        ) : null}
        <ComposerEditor
          ariaLabel="Chat prompt"
          documentKey={sessionId}
          dataRouteCaption={routeCaption !== null}
          dataPlaceholderKind={
            followUpSuggestion !== null && !isQueueing ? "suggested-follow-up" : undefined
          }
          expanded={slashAutocomplete.popoverOpen || fileAutocomplete.popoverOpen}
          controls={
            slashAutocomplete.popoverOpen
              ? "slash-menu"
              : fileAutocomplete.popoverOpen
                ? "file-popover"
                : undefined
          }
          disabled={!canSend || isSending}
          onChange={setInput}
          onCaretChange={fileAutocomplete.onSelectionChange}
          onKeyDown={onSessionInputKeyDown}
          onPaste={onComposerPaste}
          placeholder={
            canSend
              ? isQueueing
                ? "Queue a follow-up"
                : (followUpSuggestion ?? "Reply to your agent, or @-mention files and chats")
              : ""
          }
          fieldRef={inputRef}
          value={input}
          isSkill={isSkillToken}
          chats={chatChips}
        />
        <SlashCommandMenu state={slashAutocomplete} />
        <FilePopover state={fileAutocomplete} inputRef={inputRef} />
      </div>
      <div className="session-input-toolbar">
        {isRemoteBridge() || floating ? null : (
          <button
            type="button"
            className="composer-tool"
            title="Attach file"
            aria-label="Attach file"
            disabled={!canSend || isSending}
            onClick={openFilePicker}
          >
            <Plus size={14} />
          </button>
        )}
        {session ? (
          <div className="composer-chips-group composer-chips-model">
            {/* Idle or mid-turn, the picker offers every provider. Idle, a different
                provider relaunches the agent on the next send, carrying context
                through the transcript. Mid-turn, the follow-up queues with that
                provider and takes it once the current turn ends. Same-provider
                model changes commit straight away; a different provider goes
                through the confirmation below first. */}
            <LaunchModelSelector
              value={selectedModel}
              chipLabel={autoChipLabel}
              chipTitle={autoChipTitle}
              routeSwitch={chipRouteSwitch}
              availability={providerAvailability}
              onChange={(model) => {
                // `session.provider` only catches up when the backend
                // relaunches on the next send, so after a confirmed switch
                // the staged selection is the truth about what was already
                // confirmed. Without it, a reasoning-effort nudge would
                // re-raise the dialog and drop the change.
                // A chat with no native conversation (a fork child before its
                // first send, a cleared chat) has nothing to lose, so it
                // switches without asking.
                if (
                  session.providerConversationId !== null &&
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
              open={modelPickerOpen}
              onOpenChange={setModelPickerOpen}
              withEffortSlider
              effortOpen={effortPickerOpen}
              onEffortOpenChange={setEffortPickerOpen}
              ariaLabel="Chat model"
            />
            {floating || selectedModel.autoTier ? null : (
              <ComposerUsageSlot provider={selectedModel.provider} />
            )}
          </div>
        ) : null}
        {session && !floating && contextIndicatorEnabled ? <ContextRing session={session} /> : null}
        {hasWorkspaceContext ? (
          // Wide, the wrapper is `display: contents` and both chips sit on the
          // chip floor directly; compact, it becomes the anchor for the "…".
          <div
            className="composer-chips-context-group"
            data-compact-open={compactContextOpen ? "true" : undefined}
            ref={compactContextRef}
          >
            <button
              type="button"
              className="composer-compact-context-trigger"
              // The dot is the only trace a folded dirty tree leaves on the
              // row, so the trigger carries it rather than the panel inside.
              data-dirty={changeSummary ? "true" : undefined}
              title={workspaceContextSummary}
              aria-label={workspaceContextSummary}
              aria-haspopup="dialog"
              aria-expanded={compactContextOpen}
              onClick={() => setCompactContextOpen((open) => !open)}
            >
              <MoreHorizontal size={14} aria-hidden="true" />
            </button>
            <div
              className="composer-footer composer-chips-group composer-chips-context"
              role={compactContextOpen ? "dialog" : undefined}
              aria-label="Workspace context"
            >
              {branchLabel !== null ? (
                <span className="composer-context-chip branch-chip" title={`Branch: ${branchLabel}`}>
                  <GitBranch size={14} aria-hidden="true" />
                  <span className="composer-context-chip-label">{branchLabel}</span>
                </span>
              ) : null}
              {changeSummary ? (
                <button
                  type="button"
                  className="composer-footer-chip composer-footer-chip--changes"
                  title={changeSummaryText ?? undefined}
                  aria-label={changeSummaryAriaLabel}
                  aria-pressed={changeSummary.isOpen}
                  onClick={() => {
                    setCompactContextOpen(false);
                    changeSummary.onOpen();
                  }}
                >
                  <ChangeCount additions={changeSummary.additions} deletions={changeSummary.deletions} />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {isRemoteBridge() && !floating ? (
          // On the phone an image is the usual way in — a screenshot of the
          // thing you are asking about — so attaching is a primary action
          // rather than one of the workspace's secondary ones. The "…" keeps
          // that role everywhere else.
          <button
            type="button"
            className="composer-footer-chip composer-attach-chip"
            title="Attach file"
            aria-label="Attach file"
            disabled={!canSend || isSending}
            onClick={openFilePicker}
          >
            <Paperclip size={15} aria-hidden="true" />
          </button>
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
        {session && session.state === "running" ? (
          // One control while running: Stop. Enter queues the follow-up, and
          // interrupting is the queued chip's explicit "Send now" — a second
          // send button here made the running state read as a puzzle.
          //
          // A thumb has no Enter key, so on touch the queue button is the only
          // way to line a follow-up up — but it arrives with the text it would
          // queue, so a running turn nobody is typing into still shows Stop
          // alone. The slot wraps both: the compact toolbar is a grid, and two
          // bare buttons would land on the same `send` cell.
          <div className="session-send-slot">
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
            {isCoarsePointer && hasSendableContent ? (
              <button
                className="session-send-button"
                type="submit"
                title="Queue follow-up — sent when the current turn finishes"
                aria-label="Queue follow-up"
                disabled={!canSend || isSending || sendingQueuedMessageId !== null}
              >
                <Play size={13} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              </button>
            ) : null}
          </div>
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
      {session && cloudDraft?.sessionId === session.id ? (
        <CloudTaskDialog
          open
          sessionId={session.id}
          provider={cloudDraft.provider}
          initialBrief={cloudDraft.initialBrief}
          onClose={() => setCloudDraft(null)}
          onLaunched={() => {
            if (sessionIdRef.current === cloudDraft.sessionId && input === cloudDraft.draftInput) {
              setInput("");
              clearDraft(cloudDraft.sessionId);
            }
          }}
        />
      ) : null}
      {session && connectionsOpen ? (
        <ConnectionDialog
          anchorRef={inputFormRef}
          provider={session.provider}
          workspaceId={workspace?.id ?? null}
          onClose={() => {
            setConnectionsOpen(false);
            if (isFocused) inputRef.current?.focus();
          }}
        />
      ) : null}
      {/* Only while the pick still applies: the session it was made on. A turn
          starting mid-dialog queues the follow-up with the picked provider, and
          the dialog then says it takes effect after that turn. */}
      {session && pendingProviderSwitch?.sessionId === session.id ? (
        <ProviderSwitchDialog
          to={pendingProviderSwitch.model.provider}
          afterTurn={session.state === "running"}
          onCancel={() => setPendingProviderSwitch(null)}
          onSwitch={() => {
            setSelectedModel(pendingProviderSwitch.model);
            setPendingProviderSwitch(null);
            if (isFocused) inputRef.current?.focus();
          }}
          onStartNewSession={
            onStartNewSession
              ? () => {
                  // The draft moves to the launcher rather than being copied:
                  // leaving it here too would offer the same text twice, in two
                  // composers that send to different agents.
                  onStartNewSession({
                    model: pendingProviderSwitch.model,
                    prompt: input,
                    attachments: pendingAttachments
                  });
                  clearDraft(session.id);
                  setInput("");
                  clearAttachments();
                  setPendingProviderSwitch(null);
                }
              : undefined
          }
        />
      ) : null}
    </form>
  );
}
