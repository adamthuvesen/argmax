import type { ArcEventKind, ArcTimelineEvent } from "../../shared/types.js";

/** The filter a person picks above the timeline. `arc` is the Arc's own
 *  lifecycle: created, coordinator changes, brief edits, state, schedules. */
export type ArcTimelineFilter = "all" | "members" | "prs" | "notes" | "arc";

export const ARC_TIMELINE_FILTERS: ReadonlyArray<{ value: ArcTimelineFilter; label: string }> = [
  { value: "all", label: "All events" },
  { value: "members", label: "Members" },
  { value: "prs", label: "Pull requests" },
  { value: "notes", label: "Notes" },
  { value: "arc", label: "Arc" }
];

const FILTER_OF_KIND: Record<ArcEventKind, Exclude<ArcTimelineFilter, "all">> = {
  created: "arc",
  coordinator_started: "arc",
  member_launched: "members",
  member_finished: "members",
  pr_checks_failing: "prs",
  pr_checks_passing: "prs",
  pr_merged: "prs",
  notes_updated: "notes",
  brief_updated: "arc",
  state_changed: "arc",
  scheduled_run: "arc"
};

export function matchesArcTimelineFilter(event: ArcTimelineEvent, filter: ArcTimelineFilter): boolean {
  return filter === "all" || FILTER_OF_KIND[event.kind] === filter;
}

/** What a row's glyph and colour say. Tone maps to CSS, never to a literal
 *  colour, so both themes and the monochrome activity setting follow. */
export type ArcEventTone =
  | "accent"
  | "agent"
  | "success"
  | "danger"
  | "merged"
  | "notes"
  | "schedule"
  | "warning"
  | "quiet";

export type ArcEventGlyph =
  | "flag"
  | "compass"
  | "launch"
  | "joined"
  | "finished"
  | "failed"
  | "stopped"
  | "pr"
  | "merged"
  | "notes"
  | "brief"
  | "paused"
  | "resumed"
  | "done"
  | "schedule";

export interface ArcEventPresentation {
  /** The verb that leads the row: "Launched", "Checks failing". */
  verb: string;
  /** What the verb is about, when there is something to name. */
  subject: string | null;
  glyph: ArcEventGlyph;
  tone: ArcEventTone;
  /** Short mono-set facts after the meta line: a SHA, a line diff. */
  badge: string | null;
  /** Whether `detail` is someone's words (quoted) or a plain fact. */
  detailIsQuote: boolean;
}

export function presentArcEvent(event: ArcTimelineEvent): ArcEventPresentation {
  const base = { subject: null, badge: null, detailIsQuote: false };
  switch (event.kind) {
    case "created":
      return { ...base, verb: "Arc created", glyph: "flag", tone: "accent" };
    case "coordinator_started":
      return { ...base, verb: event.title, glyph: "compass", tone: "accent" };
    case "member_launched":
      return event.status === "adopted"
        ? { ...base, verb: "Joined", subject: event.title, glyph: "joined", tone: "agent" }
        : { ...base, verb: "Launched", subject: event.title, glyph: "launch", tone: "agent" };
    case "member_finished":
      return presentFinished(event);
    case "pr_checks_failing":
      return {
        ...base,
        verb: "Checks failing",
        subject: prSubject(event),
        glyph: "pr",
        tone: "danger",
        badge: event.status
      };
    case "pr_checks_passing":
      return {
        ...base,
        verb: "Checks passing",
        subject: prSubject(event),
        glyph: "pr",
        tone: "success",
        badge: event.status
      };
    case "pr_merged":
      return { ...base, verb: "Merged", subject: prSubject(event), glyph: "merged", tone: "merged" };
    case "notes_updated":
      return {
        ...base,
        verb: "Notes updated",
        // The title is the first new line of NOTES.md — the coordinator's own
        // heading — so it reads as a quotation, not as a member's name.
        subject: event.title === "Notes updated" ? null : `“${event.title}”`,
        glyph: "notes",
        tone: "notes",
        badge: event.status,
        detailIsQuote: true
      };
    case "brief_updated":
      return { ...base, verb: "Brief edited", glyph: "brief", tone: "quiet" };
    case "state_changed":
      return presentStateChange(event);
    case "scheduled_run":
      return { ...base, verb: "Scheduled run", subject: event.title, glyph: "schedule", tone: "schedule" };
  }
}

function presentFinished(event: ArcTimelineEvent): ArcEventPresentation {
  const shared = { subject: event.title, badge: null, detailIsQuote: true };
  switch (event.status) {
    case "failed":
      return { ...shared, verb: "Failed", glyph: "failed", tone: "danger" };
    case "cancelled":
      return { ...shared, verb: "Stopped", glyph: "stopped", tone: "quiet" };
    default:
      return { ...shared, verb: "Finished", glyph: "finished", tone: "success" };
  }
}

function presentStateChange(event: ArcTimelineEvent): ArcEventPresentation {
  const shared = { verb: event.title, subject: null, badge: null, detailIsQuote: false };
  switch (event.status) {
    case "paused":
      return { ...shared, glyph: "paused", tone: "warning" };
    case "done":
      return { ...shared, glyph: "done", tone: "quiet" };
    default:
      return { ...shared, glyph: "resumed", tone: "quiet" };
  }
}

function prSubject(event: ArcTimelineEvent): string {
  return event.prNumber === null ? event.title : `#${event.prNumber} ${event.title}`;
}

export interface ArcTimelineDay {
  key: string;
  label: string;
  events: ArcTimelineEvent[];
}

/** Newest-first events grouped by local calendar day: Today, Yesterday, then
 *  the weekday and date, with the year only when it is not this one. */
export function groupArcTimelineByDay(
  events: ReadonlyArray<ArcTimelineEvent>,
  now: Date = new Date()
): ArcTimelineDay[] {
  const days: ArcTimelineDay[] = [];
  for (const event of events) {
    const when = new Date(event.occurredAt);
    const key = Number.isNaN(when.getTime()) ? "unknown" : localDayKey(when);
    const last = days.at(-1);
    if (last?.key === key) {
      last.events.push(event);
    } else {
      days.push({ key, label: dayLabel(when, now), events: [event] });
    }
  }
  return days;
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(date: Date, now: Date): string {
  if (Number.isNaN(date.getTime())) return "Earlier";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const daysAgo = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" })
  });
}

/** "just now", "12 min ago", "3 h ago", then a date. For moments in the past;
 *  the schedule helpers phrase future times. */
export function formatTimeAgo(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Whether a row names its project. Member and PR rows can sit in any of the
 *  arc's projects, so they say which; the arc's own events never move. */
export function showsProject(event: ArcTimelineEvent): boolean {
  return FILTER_OF_KIND[event.kind] === "members" || FILTER_OF_KIND[event.kind] === "prs";
}

/** Splits agent prose on single backticks so code spans render as code
 *  rather than as literal backticks. Unpaired backticks stay text. */
export function splitInlineCode(text: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  const pattern = /`([^`\n]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ code: false, text: text.slice(last, start) });
    parts.push({ code: true, text: match[1] });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

export function formatArcEventTime(occurredAt: string): string {
  const when = new Date(occurredAt);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
