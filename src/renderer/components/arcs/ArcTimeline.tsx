import {
  Bot,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Compass,
  FilePen,
  Flag,
  GitMerge,
  GitPullRequest,
  NotebookPen,
  Pause,
  Play,
  SquareCheck,
  UserPlus,
  type LucideIcon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ArcTimelineCursor, ArcTimelineEvent } from "../../../shared/types.js";
import {
  ARC_TIMELINE_FILTERS,
  formatArcEventTime,
  groupArcTimelineByDay,
  matchesArcTimelineFilter,
  presentArcEvent,
  type ArcEventGlyph,
  type ArcTimelineFilter
} from "../../lib/arcTimeline.js";
import { openWebUrl } from "../../lib/openWebUrl.js";
import { SegmentedControl } from "../settings/settingsPrimitives.js";

const PAGE_SIZE = 60;
/** A detail longer than this starts clamped with a way to read the rest. */
const DETAIL_CLAMP_CHARS = 240;

const GLYPHS: Record<ArcEventGlyph, LucideIcon> = {
  flag: Flag,
  compass: Compass,
  launch: Bot,
  joined: UserPlus,
  finished: CircleCheck,
  failed: CircleX,
  stopped: CircleSlash,
  pr: GitPullRequest,
  merged: GitMerge,
  notes: NotebookPen,
  brief: FilePen,
  paused: Pause,
  resumed: Play,
  done: SquareCheck,
  schedule: Clock
};

/**
 * The Arc's story, newest first, grouped by day. It loads a page at a time
 * and refetches the newest page whenever `refreshKey` moves, keeping as many
 * rows as the person has already scrolled through.
 */
export function ArcTimeline({
  arcId,
  refreshKey,
  canOpenSession,
  onOpenSession
}: {
  arcId: string;
  refreshKey: string;
  canOpenSession: (sessionId: string) => boolean;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const [events, setEvents] = useState<ArcTimelineEvent[] | null>(null);
  const [cursor, setCursor] = useState<ArcTimelineCursor | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ArcTimelineFilter>("all");
  const loadedCount = useRef(0);

  useEffect(() => {
    loadedCount.current = 0;
    setEvents(null);
    setCursor(null);
    setFilter("all");
  }, [arcId]);

  useEffect(() => {
    if (!window.argmax) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    void window.argmax.arcs
      .timeline({ arcId, before: null, limit: Math.max(PAGE_SIZE, loadedCount.current) })
      .then((page) => {
        if (cancelled) return;
        loadedCount.current = page.events.length;
        setEvents(page.events);
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load the timeline.");
      });
    return () => {
      cancelled = true;
    };
  }, [arcId, refreshKey]);

  const loadEarlier = useCallback(async (): Promise<void> => {
    if (!window.argmax || !cursor) return;
    setLoadingEarlier(true);
    try {
      const page = await window.argmax.arcs.timeline({ arcId, before: cursor, limit: PAGE_SIZE });
      setEvents((current) => {
        const next = [...(current ?? []), ...page.events];
        loadedCount.current = next.length;
        return next;
      });
      setCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load earlier events.");
    } finally {
      setLoadingEarlier(false);
    }
  }, [arcId, cursor]);

  const days = useMemo(
    () => groupArcTimelineByDay((events ?? []).filter((event) => matchesArcTimelineFilter(event, filter))),
    [events, filter]
  );

  return (
    <section className="arc-timeline" aria-label="Timeline">
      <header className="arc-timeline-header">
        <h2 className="arc-section-title">Timeline</h2>
        <SegmentedControl
          ariaLabel="Show events"
          name={`arc-timeline-filter-${arcId}`}
          value={filter}
          onChange={(next) => setFilter(ARC_TIMELINE_FILTERS.find((option) => option.value === next)?.value ?? "all")}
          options={ARC_TIMELINE_FILTERS}
        />
      </header>

      {error ? (
        <p className="arc-inline-error" role="alert">
          {error}
        </p>
      ) : null}

      {events === null ? (
        <p className="arc-timeline-empty">Loading…</p>
      ) : days.length === 0 ? (
        <p className="arc-timeline-empty">
          {filter === "all"
            ? "Nothing has happened yet. Members, pull requests, and notes show up here as the coordinator works."
            : cursor
              ? "Nothing of this kind in the loaded events."
              : "Nothing of this kind yet."}
        </p>
      ) : (
        days.map((day) => (
          <div key={day.key} className="arc-timeline-day">
            <h3 className="arc-timeline-day-label">{day.label}</h3>
            <ol className="arc-timeline-list">
              {day.events.map((event) => (
                <ArcTimelineRow
                  key={event.id}
                  event={event}
                  canOpenSession={canOpenSession}
                  onOpenSession={onOpenSession}
                />
              ))}
            </ol>
          </div>
        ))
      )}

      {cursor ? (
        <div className="arc-timeline-more">
          <button
            type="button"
            className="settings-button"
            disabled={loadingEarlier}
            onClick={() => void loadEarlier()}
          >
            {loadingEarlier ? "Loading…" : "Show earlier"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function ArcTimelineRow({
  event,
  canOpenSession,
  onOpenSession
}: {
  event: ArcTimelineEvent;
  canOpenSession: (sessionId: string) => boolean;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const presentation = presentArcEvent(event);
  const Glyph = GLYPHS[presentation.glyph];
  const [expanded, setExpanded] = useState(false);
  const detail = event.detail?.trim() || null;
  const clampable = detail !== null && detail.length > DETAIL_CLAMP_CHARS;

  // A PR row opens the PR; any other row with a live chat opens the chat.
  const openTarget =
    event.prUrl !== null
      ? { label: `Open pull request #${event.prNumber ?? ""}`, open: () => openWebUrl(event.prUrl as string) }
      : event.sessionId !== null && event.sessionAvailable && canOpenSession(event.sessionId)
        ? { label: "Open chat", open: () => onOpenSession(event.sessionId as string) }
        : null;
  const staleChat = event.sessionId !== null && event.prUrl === null && openTarget === null;

  const meta = [event.projectName, staleChat ? "chat no longer available" : null].filter(Boolean).join(" · ");

  return (
    <li className="arc-event" data-tone={presentation.tone}>
      <span className="arc-event-glyph" aria-hidden="true">
        <Glyph size={14} strokeWidth={1.75} />
      </span>
      <div className="arc-event-body">
        <div className="arc-event-line">
          <span className="arc-event-verb">{presentation.verb}</span>
          {presentation.subject ? (
            openTarget ? (
              <button
                type="button"
                className="arc-event-subject"
                title={openTarget.label}
                onClick={openTarget.open}
              >
                {presentation.subject}
              </button>
            ) : (
              <span className="arc-event-subject">{presentation.subject}</span>
            )
          ) : null}
          <time className="arc-event-time" dateTime={event.occurredAt}>
            {formatArcEventTime(event.occurredAt)}
          </time>
        </div>
        {meta || presentation.badge ? (
          <div className="arc-event-meta">
            {meta ? <span>{meta}</span> : null}
            {presentation.badge ? <span className="arc-event-badge">{presentation.badge}</span> : null}
          </div>
        ) : null}
        {detail ? (
          presentation.detailIsQuote ? (
            <blockquote className="arc-event-quote" data-clamped={clampable && !expanded ? "true" : undefined}>
              <p>{detail}</p>
              {clampable ? (
                <button
                  type="button"
                  className="arc-event-expand"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((open) => !open)}
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              ) : null}
            </blockquote>
          ) : (
            <p className="arc-event-fact">{detail}</p>
          )
        ) : null}
      </div>
    </li>
  );
}
