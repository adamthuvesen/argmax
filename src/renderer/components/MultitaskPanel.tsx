import { useEffect, type JSX } from "react";
import type {
  AgentMode,
  ComposerAttachment,
  PendingMessage,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import type { QueuedMessageDelivery } from "../../shared/types.js";
import { useReviewState } from "../hooks/useReviewState.js";
import { useSessionTimeline } from "../hooks/useSessionTimeline.js";
import type { ModelPickerSelection } from "../lib/models.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { SessionConversation } from "./SessionConversation.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";

/**
 * A multitask's own chat, shown inside the dock of the chat that dispatched it.
 *
 * It is a real session, so this is the ordinary chat surface rather than a
 * read-only transcript: the multitask can be answered and steered here without
 * leaving the chat you were watching. The panel's own heading and checks card
 * are hidden by the dock's stylesheet: the tab already names it, and the chat
 * that owns the checkout already runs the checks.
 */
export function MultitaskPanel({
  events = [],
  isFocused = true,
  pendingMessages,
  rawOutputs = [],
  session,
  taskLabel,
  workspace,
  onCancelQueuedMessage,
  onClearSession,
  onLoadSessionEvents,
  onOpenDiff,
  onOpenFile,
  onOpenReview,
  onOpenFullChat,
  onSendQueuedMessageNow,
  onSendSessionInput,
  onTerminateSession
}: {
  events?: TimelineEvent[];
  isFocused?: boolean;
  pendingMessages: PendingMessage[];
  rawOutputs?: RawProviderOutput[];
  session: SessionSummary;
  taskLabel: string;
  workspace: WorkspaceSummary | null;
  onCancelQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
  onClearSession: (sessionId: string) => Promise<void>;
  onLoadSessionEvents?: (sessionId: string) => Promise<void>;
  onOpenDiff?: (path: string) => void;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenReview?: () => void;
  onOpenFullChat?: (sessionId: string) => void;
  onSendQueuedMessageNow: (
    sessionId: string,
    messageId: string,
    delivery?: QueuedMessageDelivery
  ) => Promise<void>;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onTerminateSession: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
}): JSX.Element {
  // The dock *is* the review panel, so a chat inside it has no panel of its
  // own; a null source keeps that state inert. The "More details" popup runs
  // the same conversation component the same way.
  const review = useReviewState(null);
  // The dashboard snapshot carries recent rows for every session, but a
  // multitask that has been open a while may have scrolled out of it.
  useEffect(() => {
    void onLoadSessionEvents?.(session.id);
  }, [onLoadSessionEvents, session.id]);

  const { events: sessionEvents, rawOutputs: sessionRawOutputs } = useSessionTimeline(
    session.id,
    events,
    rawOutputs
  );

  return (
    <div className="multitask-panel">
      <SessionConversation
        isFocused={isFocused}
        events={sessionEvents}
        floating
        headingLabel={taskLabel}
        isLogOpen={false}
        onCancelQueuedMessage={onCancelQueuedMessage}
        onClearSession={onClearSession}
        onOpenFile={onOpenFile}
        onExpandToFullChat={onOpenFullChat ? () => onOpenFullChat(session.id) : undefined}
        onSendQueuedMessageNow={onSendQueuedMessageNow}
        onSendSessionInput={onSendSessionInput}
        onTerminateSession={onTerminateSession}
        onToggleLog={() => {}}
        pendingMessages={pendingMessages}
        // The chat that dispatched this one owns the checks card for their
        // shared checkout; a second copy in the dock would only run the same
        // commands against the same tree.
        project={null}
        rawOutputs={sessionRawOutputs}
        review={{
          ...review,
          openFile: onOpenDiff ?? review.openFile,
          openChangesPanel: onOpenReview ?? review.openChangesPanel
        }}
        session={session}
        workspaceCardEnabled={false}
        workspace={workspace}
      />
    </div>
  );
}
