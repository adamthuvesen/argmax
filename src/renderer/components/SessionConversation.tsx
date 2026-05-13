import { Bug, ChevronRight, Folder, GitCommit, Mic, Plus, Square } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { appendReferencesToPrompt, buildAttachmentReferences } from "../lib/composerAttachments.js";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import type {
  CheckRun,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useFreshSet } from "../hooks/useFreshSet.js";
import { useNow } from "../hooks/useNow.js";
import type { ReviewState } from "../hooks/useReviewState.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import { modelSelectionFromSession, thinkingModelSlug } from "../lib/models.js";
import { providerLabel, repoNameFromPath } from "../lib/projects.js";
import { buildTerminalTranscript } from "../lib/rawProvider.js";
import {
  buildToolCallGroup,
  detectToolError,
  extractToolError,
  extractToolInput,
  extractToolInputPreview,
  extractToolName,
  extractToolOutput,
  extractToolUseId,
  type ConversationItem,
  type ToolCall
} from "../lib/toolCalls.js";
import { ChangedFilesCard } from "./ChangedFilesCard.js";
import { ChatBubble } from "./ChatBubble.js";
import { CostPanel } from "./CostPanel.js";
import { ModelSelector } from "./ModelSelector.js";
import { SkillPopover } from "./SkillPopover.js";
import { ToolCallBubble } from "./ToolCallBubble.js";
import { ToolCallGroupBubble } from "./ToolCallGroupBubble.js";

const PROMPT_MAX_HEIGHT_PX = 140;

export function SessionConversation({
  checks,
  defaultToolCallsExpanded,
  events,
  isLogOpen,
  onSendSessionInput,
  onTerminateSession,
  onCreateCheckpoint,
  onRunCheck,
  onToggleLog,
  project,
  rawOutputs,
  review,
  session,
  workspace
}: {
  checks?: CheckRun[];
  defaultToolCallsExpanded?: boolean;
  events: TimelineEvent[];
  isLogOpen: boolean;
  onSendSessionInput: (sessionId: string, input: string, model: ProviderModelSelection) => Promise<void>;
  onTerminateSession: (sessionId: string) => Promise<void>;
  onCreateCheckpoint: (workspaceId: string) => Promise<void>;
  onRunCheck?: (workspaceId: string, command: string) => Promise<void>;
  onToggleLog: () => void;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  review: ReviewState;
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
}): JSX.Element {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ProviderModelSelection>(() => modelSelectionFromSession(session));
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputFormRef = useRef<HTMLFormElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const shouldRefocusInput = useRef(false);
  // `events` is sorted descending upstream (mergeDashboardDelta), so a reverse
  // gives ascending order for free without a per-tick string comparator pass.
  const conversationEvents = useMemo(
    () => {
      const ascending = events
        .filter(
          (event) =>
            event.payload.raw !== true &&
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
        const toolUseId =
          typeof event.payload.tool_use_id === "string" ? event.payload.tool_use_id :
          typeof event.payload.id === "string" ? event.payload.id : null;
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
  const now = useNow(anyToolRunning, 250);
  const isFreshTool = useFreshSet(toolCalls, (tool) => tool.id, session?.id ?? "");

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
  const lastIsAssistantMessage =
    lastSignificantEvent?.type === "message.delta" ||
    lastSignificantEvent?.type === "message.completed";
  const isThinking =
    session?.state === "running" && !anyToolRunning && !lastIsAssistantMessage;

  const conversationListRef = useRef<HTMLDivElement | null>(null);
  const metaCardsRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef<boolean>(true);

  const handleConversationScroll = useCallback((): void => {
    const el = conversationListRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasNearBottomRef.current = distanceFromBottom < 80;
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
  const sessionDetails = [
    session ? providerLabel(session.provider) : null,
    selectedModel.label,
    workspace?.branch ?? null
  ].filter((detail): detail is string => Boolean(detail));

  // Depend on session.id rather than the session object: the parent rebuilds
  // SessionSummary references on every dashboard delta, which would otherwise
  // overwrite the user's per-session model pick on every streaming event.
  useEffect(() => {
    setSelectedModel(modelSelectionFromSession(session));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session.id is the identity gate; `session` mutates per-tick by design
  }, [session?.id]);

  useEffect(() => {
    if (!shouldRefocusInput.current || isSending || !canSend) {
      return;
    }

    shouldRefocusInput.current = false;
    inputRef.current?.focus();
  }, [canSend, isSending]);

  const slashAutocomplete = useSlashAutocomplete({
    input,
    setInput,
    provider: session?.provider ?? null,
    workspaceId: workspace?.id ?? null
  });

  useAutoGrowTextArea(inputRef, input, PROMPT_MAX_HEIGHT_PX);

  const onSessionInputKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    slashAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
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

  const onComposerDragOver = (event: ReactDragEvent<HTMLFormElement>): void => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
  };

  const onComposerDrop = (event: ReactDragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer.files || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    attachFiles(event.dataTransfer.files);
  };

  const onAttachmentInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files && event.target.files.length > 0) {
      attachFiles(event.target.files);
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

    setIsSending(true);
    setStatus(null);
    shouldRefocusInput.current = true;
    try {
      await onSendSessionInput(session.id, trimmedInput, selectedModel);
      setInput("");
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
          <div className="conversation-meta" aria-label="Session details">
            {sessionDetails.map((detail) => (
              <span key={detail}>{detail}</span>
            ))}
          </div>
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
        </div>
      </div>
      <div className="conversation-list" ref={conversationListRef} onScroll={handleConversationScroll}>
        {conversationItems.length > 0 ? (
          conversationItems.map((item) =>
            item.kind === "tool" ? (
              <ToolCallBubble
                key={item.tool.id}
                tool={item.tool}
                now={now}
                fresh={isFreshTool(item.tool)}
                defaultExpanded={defaultToolCallsExpanded}
                workspaceCwd={workspace?.path ?? null}
              />
            ) : item.kind === "tool-group" ? (
              <ToolCallGroupBubble
                key={item.group.id}
                group={item.group}
                now={now}
                isFreshTool={isFreshTool}
                defaultExpanded={defaultToolCallsExpanded}
                workspaceCwd={workspace?.path ?? null}
              />
            ) : item.event.type === "user.message" ? (
              <ChatBubble
                key={item.event.id}
                kind="user"
                createdAt={item.event.createdAt}
                rawMarkdown={item.event.message}
              >
                <p>{item.event.message}</p>
              </ChatBubble>
            ) : (
              <ChatBubble
                key={item.event.id}
                kind="assistant"
                createdAt={item.event.createdAt}
                rawMarkdown={item.event.message}
              >
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.event.message}</ReactMarkdown>
                </div>
              </ChatBubble>
            )
          )
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
        {isThinking ? (
          <article className="chat-bubble assistant thinking-indicator" aria-live="polite" aria-label="Thinking">
            <div className="command-stream" data-testid="command-stream" aria-hidden="true">
              <span className="command-stream-glyph" />
              <span className="command-stream-line">
                <span className="command-stream-prompt">$</span>
                <span className="command-stream-text">argmax run --model {thinkingModelSlug(selectedModel)}</span>
                <span className="command-stream-caret" />
              </span>
              <span className="command-stream-ticks">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span className="command-stream-trace" />
            </div>
          </article>
        ) : null}
      </div>
      <div className="session-meta-cards" ref={metaCardsRef}>
        <ChangedFilesCard
          review={review}
          workspaceId={workspace?.id}
          checkCommands={project?.settings.checkCommands ?? []}
          checks={checks ?? []}
          onRunCheck={onRunCheck}
        />
        {session ? <CostPanel session={session} /> : null}
      </div>
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
        <div className="session-input-field">
          <textarea
            aria-label="Session prompt"
            aria-autocomplete="list"
            aria-expanded={slashAutocomplete.popoverOpen}
            aria-controls={slashAutocomplete.popoverOpen ? "skill-popover" : undefined}
            disabled={!canSend || isSending}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onSessionInputKeyDown}
            placeholder=""
            ref={inputRef}
            value={input}
            rows={1}
          />
          <SkillPopover state={slashAutocomplete} inputRef={inputRef} />
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
            <button
              className="session-send-button"
              disabled={!canSend || isSending || !input.trim()}
              type="submit"
              title="Send follow-up"
              aria-label="Send follow-up"
            >
              <ChevronRight size={18} />
            </button>
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
