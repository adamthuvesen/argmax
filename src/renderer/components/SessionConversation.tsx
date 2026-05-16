import { Bug, ChevronDown, Folder, GitBranch, GitCommit, Mic, Plus, Square, X } from "lucide-react";
import {
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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  appendReferencesToPrompt,
  buildAttachmentReferences,
  imageAttachmentReference,
  isSupportedImageMime,
  readBlobAsBase64
} from "../lib/composerAttachments.js";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import type {
  AgentMode,
  AttachmentMimeType,
  CheckRun,
  ComposerAttachment,
  GhPrRecord,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useFileAutocomplete } from "../hooks/useFileAutocomplete.js";
import { useFreshSet } from "../hooks/useFreshSet.js";
import type { ReviewState } from "../hooks/useReviewState.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import { modelSelectionFromSession, thinkingModelSlug } from "../lib/models.js";
import { providerLabel, repoNameFromPath } from "../lib/projects.js";
import { arrayValue, objectValue, stringValue } from "../../shared/typeGuards.js";
import { buildTerminalTranscript } from "../lib/rawProvider.js";
import { DEFAULT_THINKING_STYLE, type ThinkingStyle } from "../lib/thinkingStyle.js";
import {
  AGENT_MODE_LABELS,
  readStoredAgentMode,
  sessionAgentModeKey,
  toggleAgentMode,
  writeStoredAgentMode
} from "../lib/agentMode.js";
import {
  buildToolCallGroup,
  detectToolError,
  extractCompletionCorrelationId,
  extractToolError,
  extractToolInput,
  extractToolInputPreview,
  extractToolName,
  extractToolOutput,
  extractToolUseId,
  isBashLikeTool,
  type ConversationItem,
  type ToolCall
} from "../lib/toolCalls.js";
import { ChangedFilesCard } from "./ChangedFilesCard.js";
import { GitActionsDropdown } from "./GitActionsDropdown.js";
import { ChatBubble } from "./ChatBubble.js";
import { CodeBlock } from "./CodeBlock.js";
import { CostPanel } from "./CostPanel.js";
import { matchFileChip } from "../lib/fileChipPath.js";
import { FileChip } from "./FileChip.js";
import { FilePopover } from "./FilePopover.js";
import { Mascot } from "./Mascot.js";
import { ModelSelector } from "./ModelSelector.js";
import { NowProvider } from "./NowProvider.js";
import { SkillPopover } from "./SkillPopover.js";
import { ThinkingTranscript } from "./ThinkingTranscript.js";
import { ThinkingVerbs } from "./ThinkingVerbs.js";
import { ToolCallBubble } from "./ToolCallBubble.js";
import { ToolCallGroupBubble } from "./ToolCallGroupBubble.js";
import { TurnBlock, type TurnToolItem } from "./TurnBlock.js";

const PROMPT_MAX_HEIGHT_PX = 140;

function cursorAssistantSnapshot(event: TimelineEvent): string | null {
  if (event.type !== "message.delta" || event.payload.type !== "assistant") {
    return null;
  }
  const message = objectValue(event.payload.message);
  const content = arrayValue(message?.content);
  if (!content) {
    return null;
  }
  const text = content
    .map((entry) => stringValue(objectValue(entry)?.text))
    .filter((value): value is string => Boolean(value))
    .join("");
  return text || null;
}

function deltaTextForBuffer(event: TimelineEvent, currentText: string): string {
  const snapshot = cursorAssistantSnapshot(event);
  if (snapshot === null) {
    return event.message;
  }
  if (snapshot.startsWith(currentText)) {
    return snapshot.slice(currentText.length);
  }
  if (currentText.startsWith(snapshot)) {
    return "";
  }
  return event.message;
}

function foldTurnToolItems(toolItems: TurnToolItem[]): TurnToolItem[] {
  const folded: TurnToolItem[] = [];
  let commandRun: ToolCall[] = [];

  const flushCommandRun = (): void => {
    if (commandRun.length === 0) return;
    if (commandRun.length === 1) {
      const [tool] = commandRun;
      if (tool) folded.push({ kind: "tool", tool });
    } else {
      folded.push({ kind: "tool-group", group: buildToolCallGroup(commandRun) });
    }
    commandRun = [];
  };

  for (const item of toolItems) {
    const tools = item.kind === "tool" ? [item.tool] : item.group.tools;
    if (tools.every((tool) => isBashLikeTool(tool.name))) {
      commandRun.push(...tools);
      continue;
    }
    flushCommandRun();
    folded.push(item);
  }

  flushCommandRun();
  return folded;
}

function isPayloadTruncationMarker(event: TimelineEvent): boolean {
  return event.type === "error" && event.message === "event payload truncated" && "truncatedEventId" in event.payload;
}

export function SessionConversation({
  checks,
  defaultToolCallsExpanded,
  events,
  isLogOpen,
  onClose,
  onOpenCommitDialog,
  onSendSessionInput,
  onTerminateSession,
  onCreateCheckpoint,
  onRunCheck,
  onToggleLog,
  pendingApprovalCount = 0,
  project,
  rawOutputs,
  review,
  session,
  thinkingStyle = DEFAULT_THINKING_STYLE,
  workspace
}: {
  checks?: CheckRun[];
  defaultToolCallsExpanded?: boolean;
  events: TimelineEvent[];
  isLogOpen: boolean;
  /** When provided, a close (×) button is rendered in the header — used by the multi-pane grid. */
  onClose?: () => void;
  onOpenCommitDialog?: () => void;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ProviderModelSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onTerminateSession: (sessionId: string) => Promise<void>;
  onCreateCheckpoint: (workspaceId: string) => Promise<void>;
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
  onToggleLog: () => void;
  pendingApprovalCount?: number;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  review: ReviewState;
  session: SessionSummary | null;
  thinkingStyle?: ThinkingStyle;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<ComposerAttachment & { id: string; thumbnailDataUrl: string }>
  >([]);
  const [prs, setPrs] = useState<GhPrRecord[]>([]);
  const [selectedModel, setSelectedModel] = useState<ProviderModelSelection>(() => modelSelectionFromSession(session));
  const [agentMode, setAgentMode] = useState<AgentMode>(() =>
    session ? readStoredAgentMode(sessionAgentModeKey(session.id), session.agentMode ?? "edit") : "edit"
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputFormRef = useRef<HTMLFormElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const shouldRefocusInput = useRef(false);
  const sessionId = session?.id ?? null;
  // `events` is sorted descending upstream (mergeDashboardDelta), so a reverse
  // gives ascending order for free without a per-tick string comparator pass.
  const conversationEvents = useMemo(
    () => {
      const ascending = events
        .filter(
          (event) =>
            event.payload.raw !== true &&
            !isPayloadTruncationMarker(event) &&
            ["user.message", "message.delta", "message.completed", "error"].includes(event.type) &&
            event.message !== "turn.completed"
        )
        .reverse();
      // Providers stream message.delta fragments and then a final message.completed
      // with the accumulated text. Once a turn has a completed event, the deltas
      // are stale duplicates — keep them only while streaming (before completion).
      return ascending.filter((event, index) => {
        if (event.type !== "message.delta") return true;
        for (let next = index + 1; next < ascending.length; next++) {
          const nextEvent = ascending[next];
          if (!nextEvent) break;
          if (nextEvent.type === "user.message") return true;
          if (nextEvent.type === "message.completed") return false;
        }
        return true;
      });
    },
    [events]
  );
  const hasAssistantEvents = conversationEvents.some((event) => event.type !== "user.message");
  const terminalTranscript = useMemo(
    () => (hasAssistantEvents ? "" : buildTerminalTranscript(rawOutputs, session?.id ?? null)),
    [rawOutputs, session?.id, hasAssistantEvents]
  );

  const toolCalls = useMemo((): ToolCall[] => {
    const starts = new Map<string, { event: TimelineEvent; toolUseId: string }>();
    const completions = new Map<string, TimelineEvent>();
    for (const event of events) {
      if (event.type === "command.started") {
        const toolUseId = extractToolUseId(event.payload) ?? event.id;
        starts.set(toolUseId, { event, toolUseId });
      } else if (event.type === "command.completed") {
        const toolUseId = extractCompletionCorrelationId(event.payload);
        if (toolUseId) completions.set(toolUseId, event);
      }
    }
    return [...starts.values()]
      .map(({ event, toolUseId }) => {
        const name = extractToolName(event.payload);
        const completion = completions.get(toolUseId);
        const startInput = extractToolInput(event.payload);
        const completionInput = completion ? extractToolInput(completion.payload) : {};
        const input = Object.keys(startInput).length > 0 ? startInput : completionInput;
        const isError = completion ? detectToolError(completion.payload) : false;
        const status: ToolCall["status"] = !completion ? "running" : isError ? "error" : "done";
        return {
          id: event.id,
          toolUseId,
          name,
          inputPreview: extractToolInputPreview(name, input),
          inputFull: input,
          output: completion ? extractToolOutput(completion.payload) : null,
          status,
          createdAt: event.createdAt,
          completedAt: completion ? completion.createdAt : null,
          error: completion && isError ? extractToolError(completion.payload) : null
        };
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [events]);

  const conversationItems = useMemo((): ConversationItem[] => {
    // Pre-fold items hold only message/tool kinds — `tool-group` is built by
    // the folding pass below. Narrowing the array type lets `itemTime` drop
    // its previously-unreachable `tool-group` branch.
    type PreFoldItem = Extract<ConversationItem, { kind: "message" } | { kind: "tool" }>;
    const items: PreFoldItem[] = [
      ...conversationEvents.map((event) => ({ kind: "message" as const, event })),
      ...toolCalls.map((tool) => ({ kind: "tool" as const, tool }))
    ];
    const itemTime = (item: PreFoldItem): string =>
      item.kind === "message" ? item.event.createdAt : item.tool.createdAt;
    const sorted: ConversationItem[] = items.sort((a, b) => itemTime(a).localeCompare(itemTime(b)));
    const folded: ConversationItem[] = [];
    let i = 0;
    while (i < sorted.length) {
      const item = sorted[i];
      if (!item) {
        i++;
        continue;
      }
      if (item.kind !== "tool") {
        folded.push(item);
        i++;
        continue;
      }
      const run: ToolCall[] = [item.tool];
      let j = i + 1;
      while (j < sorted.length) {
        const next = sorted[j];
        if (!next || next.kind !== "tool") break;
        run.push(next.tool);
        j++;
      }
      if (run.length === 1) {
        folded.push(item);
      } else {
        folded.push({ kind: "tool-group", group: buildToolCallGroup(run) });
      }
      i = j;
    }
    return folded;
  }, [conversationEvents, toolCalls]);

  const anyToolRunning = toolCalls.some((tool) => tool.status === "running");
  const isFreshTool = useFreshSet(toolCalls, (tool) => tool.id, session?.id ?? "");

  // Second-level fold: group user→assistant→tools into a single "turn" so the
  // chat has Codex-style rhythm. User messages stay standalone; everything
  // between two user messages folds under one "Worked for Xs" chip header.
  type RenderItem =
    | { kind: "user-message"; event: TimelineEvent }
    | {
        kind: "turn";
        id: string;
        assistantEvents: TimelineEvent[];
        toolItems: TurnToolItem[];
        assistantTimestamps: number[];
      };
  const renderItems = useMemo((): RenderItem[] => {
    const out: RenderItem[] = [];
    let pending:
      | { assistantEvents: TimelineEvent[]; toolItems: TurnToolItem[]; firstId: string | null }
      | null = null;
    const flush = (): void => {
      if (!pending) return;
      if (pending.assistantEvents.length === 0 && pending.toolItems.length === 0) {
        pending = null;
        return;
      }
      out.push({
        kind: "turn",
        id: pending.firstId ?? `turn-${out.length}`,
        assistantEvents: pending.assistantEvents,
        toolItems: foldTurnToolItems(pending.toolItems),
        assistantTimestamps: pending.assistantEvents.map((e) => Date.parse(e.createdAt))
      });
      pending = null;
    };
    for (const item of conversationItems) {
      if (item.kind === "message" && item.event.type === "user.message") {
        flush();
        out.push({ kind: "user-message", event: item.event });
        continue;
      }
      if (!pending) pending = { assistantEvents: [], toolItems: [], firstId: null };
      if (item.kind === "message") {
        pending.assistantEvents.push(item.event);
        if (!pending.firstId) pending.firstId = `turn-${item.event.id}`;
      } else if (item.kind === "tool") {
        pending.toolItems.push({ kind: "tool", tool: item.tool });
        if (!pending.firstId) pending.firstId = `turn-${item.tool.id}`;
      } else {
        pending.toolItems.push({ kind: "tool-group", group: item.group });
        if (!pending.firstId) pending.firstId = `turn-${item.group.id}`;
      }
    }
    flush();
    // Bridge the brief window between launch and the first user.message event
    // arriving over dashboard:delta. `session.prompt` is set synchronously on
    // launch, so we can show it as a placeholder bubble until the real event
    // lands and naturally takes its place.
    const hasUserMessage = out.some((item) => item.kind === "user-message");
    const prompt = session?.prompt?.trim();
    if (!hasUserMessage && session && prompt) {
      out.unshift({
        kind: "user-message",
        event: {
          id: `synth-user-${session.id}`,
          sessionId: session.id,
          type: "user.message",
          message: session.prompt,
          payload: { source: "composer" },
          createdAt: session.startedAt
        }
      });
    }
    return out;
  }, [conversationItems, session]);

  const canSend = Boolean(
    session &&
      ["complete", "waiting"].includes(session.state)
  );
  const lastSignificantEvent = events.find(
    (event) =>
      event.payload.raw !== true &&
      (event.type === "user.message" ||
        event.type === "message.delta" ||
        event.type === "message.completed" ||
        event.type === "command.completed")
  );
  // Keep the "Thinking" affordance visible alongside tool rows so the user
  // always has a live signal that the agent is working. Only suppress it
  // once an assistant message is on screen — at that point the streaming
  // reply bubble is the activity indicator and a parallel "Thinking" row
  // below it would be redundant.
  const lastIsAssistantMessage =
    lastSignificantEvent?.type === "message.delta" ||
    lastSignificantEvent?.type === "message.completed";
  const isThinking = session?.state === "running" && !lastIsAssistantMessage;

  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const metaCardsRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef<boolean>(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const handleConversationScroll = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasNearBottomRef.current = distanceFromBottom < 80;
    setShowScrollToBottom(distanceFromBottom > 120);
  }, []);

  const scrollConversationToBottom = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // Snap to the latest content when the session changes — the previous
  // session's scroll position would otherwise leave the new conversation
  // mid-scroll.
  useEffect(() => {
    const el = conversationListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    wasNearBottomRef.current = true;
  }, [session?.id]);

  // Smart follow: if the user is already at (or near) the bottom, keep them
  // pinned as new messages / tool rows arrive. If they've scrolled up to read,
  // don't yank them back down. `now` is intentionally excluded — re-scrolling
  // every 250ms while a tool is running would be jittery.
  useEffect(() => {
    const el = conversationListRef.current;
    if (!el || !wasNearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [conversationItems, isThinking]);

  // The meta-cards row (changed files + cost) shares vertical space with the
  // conversation list via grid 1fr. When it grows or shrinks, the list's
  // viewport changes height without any of the smart-follow deps changing, so
  // the latest content can slip behind the cards. Re-pin to bottom whenever
  // the cards resize and the user was already near the bottom.
  useEffect(() => {
    const cards = metaCardsRef.current;
    if (!cards || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!wasNearBottomRef.current) return;
      const el = conversationListRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(cards);
    return () => observer.disconnect();
  }, []);
  const repositoryName = project?.name ?? repoNameFromPath(workspace?.path) ?? "Repository";

  // Depend on session.id rather than the session object: the parent rebuilds
  // SessionSummary references on every dashboard delta, which would otherwise
  // overwrite the user's per-session model pick on every streaming event.
  useEffect(() => {
    setSelectedModel(modelSelectionFromSession(session));
    setAgentMode(session ? readStoredAgentMode(sessionAgentModeKey(session.id), session.agentMode ?? "edit") : "edit");
    setPendingAttachments([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session.id is the identity gate; `session` mutates per-tick by design
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    writeStoredAgentMode(sessionAgentModeKey(sessionId), agentMode);
  }, [agentMode, sessionId]);

  const toggleMode = useCallback((): void => {
    setAgentMode((mode) => toggleAgentMode(mode));
  }, []);

  // Cached PR rows for the git-actions dropdown. Cheap (DB-backed), so we just
  // reload on session change. The dropdown's "view PR" action calls back via
  // refreshPrs after creating a PR so the next click opens the existing one.
  useEffect(() => {
    if (!sessionId || !window.argmax) {
      setPrs([]);
      return;
    }
    let cancelled = false;
    void window.argmax.prs
      .listForSession({ sessionId })
      .then((rows) => {
        if (!cancelled) setPrs(rows);
      })
      .catch((error) => {
        if (cancelled) return;
        setPrs([]);
        setStatus(error instanceof Error ? error.message : "Could not load pull requests.");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const refreshPrs = useCallback((): void => {
    if (!sessionId || !window.argmax) return;
    void window.argmax.prs
      .listForSession({ sessionId })
      .then(setPrs)
      .catch((error) => {
        setPrs([]);
        setStatus(error instanceof Error ? error.message : "Could not refresh pull requests.");
      });
  }, [sessionId]);

  useEffect(() => {
    if (!shouldRefocusInput.current || isSending || !canSend) {
      return;
    }

    shouldRefocusInput.current = false;
    inputRef.current?.focus();
  }, [canSend, isSending]);

  // Auto-focus the chat input when the session view is the active surface —
  // on mount, when the session becomes sendable, and again whenever the
  // right-side review panel closes, so typing resumes without a click.
  useEffect(() => {
    if (review.isPanelOpen || isSending || !canSend) return;
    inputRef.current?.focus();
  }, [review.isPanelOpen, canSend, isSending]);

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

  const attachFiles = useCallback(
    (files: Iterable<File> | Iterable<{ path?: string }>): void => {
      const refs = buildAttachmentReferences(files, workspace?.path ?? null);
      if (refs.length === 0) return;
      setInput((prev) => appendReferencesToPrompt(prev, refs));
    },
    [workspace?.path]
  );

  const attachImageBlobs = useCallback(
    async (blobs: Blob[]): Promise<void> => {
      if (!session || blobs.length === 0) return;
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
            sessionId: session.id,
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
    },
    [session]
  );

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
    // Split: files with a disk path use the existing @-mention flow; files
    // without a path (browser drags, Slack drags) but with an image MIME get
    // persisted via the AttachmentStore so the agent can still read them.
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
      // Honor the same split rule as drop: path-based files use @-reference,
      // path-less images get persisted. File-picker selections normally have
      // a path, but a packaged distribution path may differ across Electron
      // versions — keep the fallback so a missing path doesn't silently drop.
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
    }
    // Clear the value so the same file can be selected again next time.
    event.target.value = "";
  };

  const openFilePicker = (): void => {
    attachmentInputRef.current?.click();
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
      setPendingAttachments([]);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send input.");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <section className="conversation-surface" aria-label="Session conversation">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Repository</p>
          <h2>{repositoryName}</h2>
        </div>
        <div className="conversation-header-actions">
          <button
            className="small-icon"
            type="button"
            title="Browse workspace files"
            aria-label="Browse workspace files"
            disabled={!workspace}
            onClick={review.openPanelInFilesMode}
          >
            <Folder size={16} />
          </button>
          <button
            className="small-icon"
            type="button"
            title={workspace?.dirty ? "Save checkpoint of the current worktree" : "Worktree is clean — no checkpoint needed"}
            aria-label="Save checkpoint"
            disabled={!workspace?.dirty}
            onClick={() => {
              if (workspace) void onCreateCheckpoint(workspace.id);
            }}
          >
            <GitCommit size={16} />
          </button>
          <GitActionsDropdown
            prs={prs}
            session={session}
            workspace={workspace}
            onPrsRefresh={refreshPrs}
            onOpenCommitDialog={onOpenCommitDialog}
          />
          <button
            className="small-icon"
            type="button"
            title="Toggle debug log"
            aria-label="Toggle debug log"
            aria-pressed={isLogOpen}
            onClick={onToggleLog}
          >
            <Bug size={16} />
          </button>
          {onClose ? (
            <button
              className="small-icon session-pane-close"
              type="button"
              title="Close pane (⌘W)"
              aria-label="Close pane"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          ) : null}
        </div>
      </div>
      <div className="conversation-list" ref={conversationListRef} onScroll={handleConversationScroll}>
        <NowProvider active={anyToolRunning}>
        {renderItems.length > 0 ? (
          renderItems.map((item, index) => {
            if (item.kind === "user-message") {
              const rawAttachments = arrayValue(item.event.payload.attachments) ?? [];
              const attachments = rawAttachments
                .map((entry) => {
                  const obj = objectValue(entry);
                  const filePath = stringValue(obj?.filePath);
                  const mimeType = stringValue(obj?.mimeType);
                  if (!filePath || !mimeType) return null;
                  return { filePath, mimeType };
                })
                .filter((value): value is { filePath: string; mimeType: string } => Boolean(value));
              // Strip the `@/abs/path` refs we appended in submitInput so the
              // bubble shows the user's prose, not the synthetic filesystem
              // pointer that's only there for the provider's file tool.
              let displayMessage = item.event.message;
              for (const a of attachments) {
                displayMessage = displayMessage.split(`@${a.filePath}`).join("");
              }
              displayMessage = displayMessage.replace(/[ \t]+(?=\n|$)/g, "").trim();
              return (
                <ChatBubble
                  key={item.event.id}
                  kind="user"
                  createdAt={item.event.createdAt}
                  rawMarkdown={displayMessage}
                >
                  {attachments.length > 0 ? (
                    <div className="user-message-attachments" aria-label="Attached images">
                      {attachments.map((a) => {
                        const filename = a.filePath.split("/").pop() || a.filePath;
                        return (
                          <span
                            key={a.filePath}
                            className="user-message-attachment-chip"
                            title={a.filePath}
                          >
                            {filename}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  {displayMessage ? <p>{displayMessage}</p> : null}
                </ChatBubble>
              );
            }
            // Coalesce consecutive `message.delta` events into a single
            // running bubble. Without this, Cursor's --stream-partial-output
            // would render a separate bubble per token. The buffer flushes on
            // the next non-delta event (typically `message.completed`).
            const assistantGroups: Array<{ id: string; createdAt: string; text: string; streaming: boolean }> = [];
            let deltaBuffer: { id: string; createdAt: string; text: string } | null = null;
            for (const event of item.assistantEvents) {
              if (event.type === "message.delta") {
                if (!deltaBuffer) deltaBuffer = { id: event.id, createdAt: event.createdAt, text: "" };
                deltaBuffer.text += deltaTextForBuffer(event, deltaBuffer.text);
                continue;
              }
              if (deltaBuffer) {
                assistantGroups.push({
                  id: deltaBuffer.id,
                  createdAt: deltaBuffer.createdAt,
                  text: deltaBuffer.text,
                  streaming: true
                });
                deltaBuffer = null;
              }
              assistantGroups.push({
                id: event.id,
                createdAt: event.createdAt,
                text: event.message,
                streaming: false
              });
            }
            if (deltaBuffer) {
              assistantGroups.push({
                id: deltaBuffer.id,
                createdAt: deltaBuffer.createdAt,
                text: deltaBuffer.text,
                streaming: true
              });
            }
            const assistantNode = assistantGroups.map((group) => (
              <ChatBubble
                key={group.id}
                kind="assistant"
                createdAt={group.createdAt}
                rawMarkdown={group.text}
              >
                <div className={`markdown${group.streaming ? " markdown-streaming" : ""}`}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code: ({ className, children, ...rest }) => {
                        const isFenced = typeof className === "string" && className.includes("language-");
                        if (isFenced) {
                          return <CodeBlock className={className}>{children}</CodeBlock>;
                        }
                        const text = Array.isArray(children)
                          ? children.map((c) => (typeof c === "string" ? c : "")).join("")
                          : typeof children === "string"
                            ? children
                            : "";
                        const match = matchFileChip(text);
                        if (match) {
                          return (
                            <FileChip
                              path={match.path}
                              line={match.line}
                              workspaceId={workspace?.id ?? null}
                              workspaceCwd={workspace?.path ?? null}
                            />
                          );
                        }
                        return (
                          <code className={className} {...rest}>
                            {children}
                          </code>
                        );
                      },
                      pre: ({ children }) => <>{children}</>
                    }}
                  >
                    {group.text}
                  </ReactMarkdown>
                </div>
              </ChatBubble>
            ));
            // A turn's tool groups stay expanded only while that turn is
            // "active": a tool is still running, or it's the last turn in the
            // list and the session is still streaming. Past turns collapse
            // regardless of the global "Show expanded" setting; the active
            // turn falls back to the global setting.
            const isLatestTurn = index === renderItems.length - 1;
            const anyToolRunningInTurn = item.toolItems.some((tItem) =>
              tItem.kind === "tool"
                ? tItem.tool.status === "running"
                : tItem.group.tools.some((tool) => tool.status === "running")
            );
            const sessionIsLive = session?.state === "running";
            const turnIsActive = anyToolRunningInTurn || (isLatestTurn && sessionIsLive);
            const groupDefaultExpanded = turnIsActive ? defaultToolCallsExpanded : false;
            const toolsNode = item.toolItems.map((tItem) =>
              tItem.kind === "tool" ? (
                <ToolCallBubble
                  key={tItem.tool.id}
                  tool={tItem.tool}
                  fresh={isFreshTool(tItem.tool)}
                  defaultExpanded={groupDefaultExpanded}
                  workspaceCwd={workspace?.path ?? null}
                />
              ) : (
                <ToolCallGroupBubble
                  key={tItem.group.id}
                  group={tItem.group}
                  isFreshTool={isFreshTool}
                  defaultExpanded={groupDefaultExpanded}
                  workspaceCwd={workspace?.path ?? null}
                />
              )
            );
            return (
              <TurnBlock
                key={item.id}
                toolItems={item.toolItems}
                assistantTimestamps={item.assistantTimestamps}
                {...(session ? { providerLabel: providerLabel(session.provider) } : {})}
                modelLabel={selectedModel.label}
                {...(defaultToolCallsExpanded !== undefined ? { defaultExpanded: defaultToolCallsExpanded } : {})}
                assistantNode={assistantNode}
                toolsNode={toolsNode}
              />
            );
          })
        ) : terminalTranscript ? (
          <article className="chat-bubble assistant terminal-transcript">
            <pre>{terminalTranscript}</pre>
          </article>
        ) : isThinking ? null : (
          <p className="conversation-empty">Agent replies will appear here.</p>
        )}
        {terminalTranscript && !hasAssistantEvents && conversationItems.length > 0 ? (
          <article className="chat-bubble assistant terminal-transcript">
            <pre>{terminalTranscript}</pre>
          </article>
        ) : null}
        {showScrollToBottom ? (
          <button
            type="button"
            className="scroll-to-bottom-fab"
            aria-label="Scroll to latest"
            title="Scroll to latest"
            onClick={scrollConversationToBottom}
          >
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        ) : null}
        {isThinking ? (
          thinkingStyle === "verbs" ? (
            <ThinkingVerbs />
          ) : (
            <ThinkingTranscript command={`run --model ${thinkingModelSlug(selectedModel)}`} />
          )
        ) : null}
        </NowProvider>
      </div>
      <div
        className="session-meta-cards"
        data-cost-visible={session && showCostPanel ? "true" : "false"}
        ref={metaCardsRef}
      >
        <ChangedFilesCard
          review={review}
          workspaceId={workspace?.id}
          checkCommands={project?.settings.checkCommands ?? []}
          checks={checks ?? []}
          onRunCheck={onRunCheck}
        />
        {session ? <CostPanel session={session} /> : null}
      </div>
      {pendingApprovalCount > 0 ? (
        <div className="composer-approvals-banner" role="status" aria-live="polite">
          <span className="composer-approvals-banner-count" aria-hidden="true">{pendingApprovalCount}</span>
          <span>
            {pendingApprovalCount === 1 ? "approval needs review" : "approvals need review"}
          </span>
          <button
            type="button"
            className="composer-approvals-banner-cta"
            aria-label="Scroll to approvals"
            onClick={() => {
              const el = document.querySelector(".approval-surface");
              if (el instanceof HTMLElement) {
                el.scrollIntoView({ behavior: "smooth", block: "start" });
              }
            }}
          >
            Review
          </button>
        </div>
      ) : null}
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
        <div className="session-input-field">
          <textarea
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
            onSelect={fileAutocomplete.onSelectionChange}
            onClick={fileAutocomplete.onSelectionChange}
            placeholder={canSend ? "Reply to your agent, or @-mention files" : ""}
            ref={inputRef}
            value={input}
            rows={1}
          />
          <SkillPopover state={slashAutocomplete} inputRef={inputRef} />
          <FilePopover state={fileAutocomplete} inputRef={inputRef} />
        </div>
        <div className="session-input-toolbar">
          <button
            className="composer-tool"
            type="button"
            title="Attach file"
            aria-label="Attach file"
            disabled={!canSend || isSending}
            onClick={openFilePicker}
          >
            <Plus size={16} />
          </button>
          {session ? (
            <ModelSelector
              provider={session.provider}
              value={selectedModel}
              onChange={setSelectedModel}
              ariaLabel="Session model"
            />
          ) : null}
          {session ? (
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
          ) : null}
          {workspace ? (
            <div className="composer-footer" aria-label="Workspace context">
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
                  <span>Worktree</span>
                </button>
              )}
              <button
                type="button"
                className="composer-footer-chip"
                title={`Branch: ${workspace.branch}`}
                aria-label={`Branch ${workspace.branch}`}
              >
                <GitBranch size={11} aria-hidden="true" />
                <span>{workspace.branch}</span>
              </button>
            </div>
          ) : null}
          <span className="session-toolbar-spacer" />
          <button className="composer-tool" type="button" title="Voice input" disabled={!canSend || isSending}>
            <Mic size={16} />
          </button>
          {session && session.state === "running" ? (
            <button
              className="session-send-button session-stop-button"
              type="button"
              title="Stop session"
              aria-label="Stop session"
              onClick={() => void onTerminateSession(session.id)}
            >
              <Square size={16} />
            </button>
          ) : (
            (() => {
              const sendDisabled = !canSend || isSending || !input.trim();
              return (
                <Mascot
                  size={36}
                  mood={sendDisabled ? "sad" : "idle"}
                  type="submit"
                  disabled={sendDisabled}
                  title="Send follow-up"
                  label="Send follow-up"
                  buttonClassName="session-send-mascot"
                />
              );
            })()
          )}
        </div>
      </form>
      {status ? (
        <p className="composer-status" role="status">
          {status}
        </p>
      ) : null}
    </section>
  );
}
