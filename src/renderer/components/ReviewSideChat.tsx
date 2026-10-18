import { useEffect, useId, useRef, useState, type ComponentProps, type FormEvent, type JSX } from "react";
import { ArrowUp, MessageSquarePlus } from "lucide-react";
import { errorMessage } from "../../shared/error.js";
import type { PendingMessage, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
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
  launch: (prompt: string) => Promise<ReviewSideChatSession>;
  sessionsById: ReadonlyMap<string, SessionSummary>;
  workspacesById: ReadonlyMap<string, WorkspaceSummary>;
  pendingMessages?: Record<string, PendingMessage[]>;
};

export function ReviewSideChat({
  context,
  sessionId,
  workspaceId,
  isFocused = true,
  formState: controlledFormState,
  onFormStateChange,
  onLaunched
}: {
  context: ReviewSideChatContext;
  sessionId?: string;
  workspaceId?: string;
  isFocused?: boolean;
  formState?: ReviewSideChatFormState;
  onFormStateChange?: (patch: Partial<ReviewSideChatFormState>) => void;
  onLaunched: (session: ReviewSideChatSession) => void;
}): JSX.Element {
  const promptId = useId();
  const [localFormState, setLocalFormState] = useState<ReviewSideChatFormState>({ prompt: "", launching: false, error: null });
  const { prompt, launching, error } = controlledFormState ?? localFormState;
  const updateForm = (patch: Partial<ReviewSideChatFormState>): void => {
    if (onFormStateChange) onFormStateChange(patch);
    else setLocalFormState((current) => ({ ...current, ...patch }));
  };
  const launchPending = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isFocused && !sessionId) promptRef.current?.focus();
  }, [isFocused, sessionId]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || launching || launchPending.current) return;
    launchPending.current = true;
    updateForm({ launching: true, error: null });
    try {
      const launched = await context.launch(trimmed);
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
    <div className="review-side-chat-empty">
      <div className="review-side-chat-intro">
        <MessageSquarePlus size={24} strokeWidth={1.5} aria-hidden="true" />
        <h2>Side chat</h2>
        <p>Ask a separate question while your main chat stays open.</p>
      </div>
      <form className="review-side-chat-form" onSubmit={(event) => { void submit(event); }}>
        <label className="sr-only" htmlFor={promptId}>Side chat message</label>
        <textarea
          ref={promptRef}
          id={promptId}
          aria-label="Side chat message"
          placeholder="What would you like to explore?"
          value={prompt}
          disabled={launching}
          rows={4}
          onChange={(event) => updateForm({ prompt: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              void submit(event);
            }
          }}
        />
        <div className="review-side-chat-form-footer">
          <span>{launching ? "Starting chat…" : "A fresh chat, without a repository."}</span>
          <button
            type="submit"
            className="review-side-chat-submit"
            aria-label="Start side chat"
            title="Start side chat (⌘Enter)"
            disabled={!prompt.trim() || launching}
          >
            <ArrowUp size={17} aria-hidden="true" />
          </button>
        </div>
      </form>
      {error ? <p className="review-side-chat-error" role="alert">{error}</p> : null}
    </div>
  );
}
