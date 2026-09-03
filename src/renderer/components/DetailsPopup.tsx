import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import type {
  AgentMode,
  ComposerAttachment,
  PendingMessage,
  ProjectSummary,
  RawProviderOutput,
  SessionSummary,
  TimelineEvent,
  WorkspaceSummary
} from "../../shared/types.js";
import type { ModelPickerSelection } from "../lib/models.js";
import { readBoundedNumberPreference } from "../lib/uiPreferences.js";
import { useReviewState } from "../hooks/useReviewState.js";
import { useStableFilter } from "../hooks/useStableFilter.js";
import { SessionConversation } from "./SessionConversation.js";
import type { TerminateSessionOptions } from "../hooks/useSessionCommands.js";

const WIDTH_KEY = "argmax.detailsPopup.width";
const HEIGHT_KEY = "argmax.detailsPopup.height";
const MIN_WIDTH = 340;
const MIN_HEIGHT = 320;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 1000;
const DEFAULT_WIDTH = 440;
const DEFAULT_HEIGHT = 520;

/**
 * "More details" explainer: a floating, resizable panel pinned to the bottom-
 * right corner, hosting a full conversation against an ephemeral popup-kind
 * scratch session. It reuses SessionConversation wholesale, so streaming,
 * queued follow-ups, and the composer behave exactly like a pane — only the
 * frame (fixed position, corner resize, close-and-discard) is popup-specific.
 */
export function DetailsPopup({
  events,
  onAttachToChat,
  onCancelQueuedMessage,
  onClose,
  onLoadSessionEvents,
  onSendQueuedMessageNow,
  onMultitask,
  onOpenSession,
  onSendSessionInput,
  onTerminateSession,
  onClearSession,
  pendingMessages,
  project,
  rawOutputs,
  session,
  workspace
}: {
  events: TimelineEvent[];
  /** Adds the explained excerpt to the originating session's composer. */
  onAttachToChat?: () => void;
  onCancelQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
  onClose: () => void;
  onLoadSessionEvents: (sessionId: string) => Promise<void>;
  onSendQueuedMessageNow: (sessionId: string, messageId: string) => Promise<void>;
  onMultitask?: (sessionId: string, prompt: string) => Promise<void>;
  /** The popup has no dock, so a multitask dispatched from it opens as a full
   *  chat — the same fallback the phone uses. Without it the row is a button
   *  that goes nowhere, and the chat has no sidebar row either. */
  onOpenSession?: (sessionId: string) => void;
  onSendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  onTerminateSession: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
  onClearSession: (sessionId: string) => Promise<void>;
  pendingMessages?: Record<string, PendingMessage[]>;
  project: ProjectSummary | null;
  rawOutputs: RawProviderOutput[];
  session: SessionSummary;
  workspace: WorkspaceSummary;
}): JSX.Element {
  const sessionId = session.id;
  const sessionEvents = useStableFilter(events, sessionId, (event) => event.sessionId === sessionId);
  // The seed prompt restates the excerpt the user just selected, so it only
  // eats panel space. Hide it (the oldest user message — events run newest
  // first) and give the whole panel to the answer; typed follow-ups still show.
  const visibleEvents = useMemo(() => {
    let seedId: string | null = null;
    for (const event of sessionEvents) {
      if (event.type === "user.message") seedId = event.id;
    }
    if (seedId === null) return sessionEvents;
    return sessionEvents.filter((event) => event.id !== seedId);
  }, [sessionEvents]);
  const visibleRawOutputs = useStableFilter(
    rawOutputs,
    sessionId,
    (output) => output.sessionId === sessionId
  );
  // The popup never shows a review panel; a null source keeps the state inert.
  const review = useReviewState(null);

  // Backfill the transcript once; streaming updates ride dashboard:delta.
  useEffect(() => {
    void onLoadSessionEvents(sessionId);
  }, [sessionId, onLoadSessionEvents]);

  const [size, setSize] = useState(() => ({
    width: readBoundedNumberPreference(WIDTH_KEY, {
      min: MIN_WIDTH,
      max: MAX_WIDTH,
      fallback: DEFAULT_WIDTH
    }),
    height: readBoundedNumberPreference(HEIGHT_KEY, {
      min: MIN_HEIGHT,
      max: MAX_HEIGHT,
      fallback: DEFAULT_HEIGHT
    })
  }));
  useEffect(() => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(size.width));
      window.localStorage.setItem(HEIGHT_KEY, String(size.height));
    } catch {
      // A quota or private-mode write failure just loses the remembered size.
    }
  }, [size]);

  // Corner resize: the panel is anchored bottom-right, so dragging the
  // top-left handle grows it up and to the left. Document-level listeners so
  // the drag survives leaving the handle; cleanup replays on unmount.
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    },
    []
  );
  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = size.width;
    const startHeight = size.height;
    const onMove = (move: globalThis.PointerEvent): void => {
      setSize({
        width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - move.clientX))),
        height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + (startY - move.clientY)))
      });
    };
    const stop = (): void => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", stop);
    document.body.style.cursor = "nwse-resize";
  };

  const sessionPendingMessages = useMemo(
    () => pendingMessages?.[sessionId] ?? [],
    [pendingMessages, sessionId]
  );

  // Blank the prompt as well: foldConversation synthesizes a user bubble from
  // `session.prompt` whenever no user.message event is visible, which would
  // resurrect the seed the event filter above just hid.
  const popupSession = useMemo(() => ({ ...session, prompt: "" }), [session]);

  return (
    <section
      className="details-popup"
      role="dialog"
      aria-label="More details"
      style={{ width: `${size.width}px`, height: `${size.height}px` }}
    >
      <div
        className="details-popup-resize"
        role="presentation"
        title="Drag to resize"
        onPointerDown={startResize}
      />
      <SessionConversation
        events={visibleEvents}
        floating
        headingLabel="More details"
        isLogOpen={false}
        onAttachToChat={onAttachToChat}
        onClose={onClose}
        onSendSessionInput={onSendSessionInput}
        onTerminateSession={onTerminateSession}
        onClearSession={onClearSession}
        onCancelQueuedMessage={onCancelQueuedMessage}
        onSendQueuedMessageNow={onSendQueuedMessageNow}
        onMultitask={onMultitask}
        onOpenSession={onOpenSession}
        pendingMessages={sessionPendingMessages}
        onToggleLog={() => {}}
        project={project}
        rawOutputs={visibleRawOutputs}
        review={review}
        session={popupSession}
        workspaceCardEnabled={false}
        workspace={workspace}
      />
    </section>
  );
}
