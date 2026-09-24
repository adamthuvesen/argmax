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
  ListFilter,
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
  formatArcEventStamp,
  formatArcEventTime,
  matchesArcTimelineFilter,
  presentArcEvent,
  showsProject,
  splitInlineCode,
  type ArcEventGlyph,
  type ArcTimelineFilter
} from "../../lib/arcTimeline.js";
import { openWebUrl } from "../../lib/openWebUrl.js";
import { SettingsListPicker } from "../settings/settingsPrimitives.js";

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
 * The Arc's story, newest first. It loads a page at a time
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
  // Bumped by an arc switch and by every refresh, so an earlier-page load that
  // started under the old arc or window cannot append into the new one.
  const requestGeneration = useRef(0);

  useEffect(() => {
    requestGeneration.current += 1;
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
    requestGeneration.current += 1;
    // An earlier-page load from the old generation no longer owns the button.
    setLoadingEarlier(false);
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
    const generation = requestGeneration.current;
    setLoadingEarlier(true);
    try {
      const page = await window.argmax.arcs.timeline({ arcId, before: cursor, limit: PAGE_SIZE });
      if (generation !== requestGeneration.current) return;
      setEvents((current) => {
        const next = [...(current ?? []), ...page.events];
        loadedCount.current = next.length;
        return next;
      });
      setCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      setError(cause instanceof Error ? cause.message : "Could not load earlier events.");
    } finally {
      if (generation === requestGeneration.current) setLoadingEarlier(false);
    }
  }, [arcId, cursor]);

  const shown = useMemo(
    () => (events ?? []).filter((event) => matchesArcTimelineFilter(event, filter)),
    [events, filter]
  );

  return (
    <section className="arc-timeline" aria-label="Timeline">
      <header className="arc-timeline-header arc-chips">
        <h2 className="arc-section-title">Timeline</h2>
        <SettingsListPicker
          ariaLabel="Show events"
          icon={<ListFilter size={14} aria-hidden="true" />}
          value={filter}
          onChange={setFilter}
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
      ) : shown.length === 0 ? (
        <p className="arc-timeline-empty">
          {filter === "all"
            ? "Nothing has happened yet. Members, pull requests, and notes show up here as the coordinator works."
            : cursor
              ? "Nothing of this kind in the loaded events."
              : "Nothing of this kind yet."}
        </p>
      ) : (
        <ol className="arc-timeline-list">
          {shown.map((event) => (
            <ArcTimelineRow
              key={event.id}
              event={event}
              canOpenSession={canOpenSession}
              onOpenSession={onOpenSession}
            />
          ))}
        </ol>
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
  const { prUrl, sessionId } = event;
  const openTarget =
    prUrl !== null
      ? { label: `Open pull request #${event.prNumber ?? ""}`, open: () => openWebUrl(prUrl) }
      : sessionId !== null && event.sessionAvailable && canOpenSession(sessionId)
        ? { label: "Open chat", open: () => onOpenSession(sessionId) }
        : null;
  const meta = showsProject(event) ? event.projectName : null;

  // One sentence per row: verb, subject, then the project and any badge as
  // quiet trailing words. The time sits in its own column on the left so
  // every row starts at the same edge and the eye reads down one line.
  return (
    <li className="arc-event" data-tone={presentation.tone}>
      <time className="arc-event-time" dateTime={event.occurredAt} title={formatArcEventStamp(event.occurredAt)}>
        {formatArcEventTime(event.occurredAt)}
      </time>
      <span className="arc-event-glyph" aria-hidden="true">
        <Glyph size={14} strokeWidth={1.75} />
      </span>
      <div className="arc-event-body">
        <p className="arc-event-line">
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
          {meta ? <span className="arc-event-meta">{meta}</span> : null}
          {presentation.badge ? <span className="arc-event-badge">{presentation.badge}</span> : null}
        </p>
        {detail ? (
          presentation.detailIsQuote ? (
            <blockquote className="arc-event-quote" data-clamped={clampable && !expanded ? "true" : undefined}>
              <p>
                {splitInlineCode(detail).map((part, index) =>
                  part.code ? <code key={index}>{part.text}</code> : <span key={index}>{part.text}</span>
                )}
              </p>
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
