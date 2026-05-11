import { Bug, ChevronRight, Mic, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import ReactMarkdown from "react-markdown";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import type {
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
import { CostPanel } from "./CostPanel.js";
import { ModelSelector } from "./ModelSelector.js";
import { SkillPopover } from "./SkillPopover.js";
import { ToolCallBubble } from "./ToolCallBubble.js";
import { ToolCallGroupBubble } from "./ToolCallGroupBubble.js";

const PROMPT_MAX_HEIGHT_PX = 140;

export function SessionConversation({
  defaultToolCallsExpanded,
  events,
  isLogOpen,
  onSendSessionInput,
  onToggleLog,
  project,
  rawOutputs,
  review,
  session,
  workspace
}: {
  defaultToolCallsExpanded?: boolean;
  events: TimelineEvent[];
  isLogOpen: boolean;
  onSendSessionInput: (sessionId: string, input: string, model: ProviderModelSelection) => Promise<void>;
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
    const items: ConversationItem[] = [
      ...conversationEvents.map((event) => ({ kind: "message" as const, event })),
      ...toolCalls.map((tool) => ({ kind: "tool" as const, tool }))
    ];
    const itemTime = (item: ConversationItem): string =>
      item.kind === "message"
        ? item.event.createdAt
        : item.kind === "tool"
          ? item.tool.createdAt
          : item.group.tools[0]?.createdAt ?? "";
    const sorted = items.sort((a, b) => itemTime(a).localeCompare(itemTime(b)));
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
              <article className="chat-bubble user" key={item.event.id}>
                <p>{item.event.message}</p>
              </article>
            ) : (
              <article className="chat-bubble assistant" key={item.event.id}>
                <div className="markdown">
                  <ReactMarkdown>{item.event.message}</ReactMarkdown>
                </div>
              </article>
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
      <ChangedFilesCard review={review} />
      {session ? <CostPanel session={session} events={events} /> : null}
      <form className="session-input" ref={inputFormRef} onSubmit={(event) => void submitInput(event)}>
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
          <button className="composer-tool" type="button" title="Add context" disabled={!canSend || isSending}>
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
          <button className="session-send-button" disabled={!canSend || isSending || !input.trim()} type="submit" title="Send follow-up">
            <ChevronRight size={18} />
          </button>
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
