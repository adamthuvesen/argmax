// Friendly schedule controls ↔ stored schedule shape for scheduled tasks.
//
// Storage keeps exactly one of `cronExpr` (6-field cron: sec min hour dom
// month dow [year], the `cron` crate dialect) or `runOnceAt` (RFC 3339). The
// panel renders five friendly kinds — Once, Hourly, Daily, Weekly, Custom —
// and this module is the only place that maps between them, so the cron
// dialect quirks live in one file.

import type { Routine } from "../../shared/types.js";

export type ScheduleKind = "once" | "hourly" | "daily" | "weekly" | "custom";

export interface ScheduleControls {
  /** datetime-local value ("YYYY-MM-DDTHH:MM"); Rust interprets it as local time. */
  onceAt: string;
  /** Minute of the hour (0-59) for recurring kinds. */
  minute: number;
  /** Hour of the day (0-23) for daily/weekly. */
  hour: number;
  /** cron day-of-week number for weekly; 1 = Sunday per the `cron` crate. */
  weekday: number;
  custom: string;
}

/** cron dow numbers follow the `cron` crate: 1 = Sunday. Display runs
 *  Monday-first to match how people read calendars. */
export const WEEKDAY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 2, label: "Mon" },
  { value: 3, label: "Tue" },
  { value: 4, label: "Wed" },
  { value: 5, label: "Thu" },
  { value: 6, label: "Fri" },
  { value: 7, label: "Sat" },
  { value: 1, label: "Sun" }
];

const WEEKDAY_NAME_BY_VALUE = new Map([
  [1, "Sun"],
  [2, "Mon"],
  [3, "Tue"],
  [4, "Wed"],
  [5, "Thu"],
  [6, "Fri"],
  [7, "Sat"]
]);

/** Reverse of {@link WEEKDAY_NAME_BY_VALUE}; accepts the full and abbreviated
 *  English names the `cron` crate parses, any case. */
function weekdayValue(name: string): number | null {
  const normalized = name.trim().toLowerCase();
  const short = normalized.slice(0, 3);
  for (const [value, label] of WEEKDAY_NAME_BY_VALUE) {
    if (label.toLowerCase() === short) return value;
  }
  return null;
}

export const DEFAULT_SCHEDULE_CONTROLS: ScheduleControls = {
  onceAt: "",
  minute: 0,
  hour: 9,
  weekday: 2,
  custom: ""
};

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Produces the stored schedule pair for a kind. `onceAt` stays a naive
 *  local value; the Rust upsert normalizes it to UTC. Returns null fields
 *  when the inputs are incomplete so Save can treat the form as unfinished. */
export function buildSchedule(
  kind: ScheduleKind,
  controls: ScheduleControls
): { cronExpr: string | null; runOnceAt: string | null } {
  switch (kind) {
    case "once":
      return { cronExpr: null, runOnceAt: controls.onceAt || null };
    case "hourly":
      return { cronExpr: `0 ${controls.minute} * * * *`, runOnceAt: null };
    case "daily":
      return { cronExpr: `0 ${controls.minute} ${controls.hour} * * *`, runOnceAt: null };
    case "weekly":
      return {
        cronExpr: `0 ${controls.minute} ${controls.hour} * * ${WEEKDAY_NAME_BY_VALUE.get(controls.weekday) ?? "Mon"}`,
        runOnceAt: null
      };
    case "custom":
      return { cronExpr: controls.custom.trim() || null, runOnceAt: null };
  }
}

/** Recovers the friendly kind + controls from a stored schedule, so editing
 *  a routine prefills the same controls that built it. `custom` is the
 *  fallback for cron expressions the friendly kinds cannot express. */
export function parseSchedule(
  routine: Pick<Routine, "cronExpr" | "runOnceAt">
): { kind: ScheduleKind; controls: ScheduleControls } {
  const controls: ScheduleControls = { ...DEFAULT_SCHEDULE_CONTROLS };
  if (routine.runOnceAt) {
    controls.onceAt = toLocalInputValue(routine.runOnceAt);
    return { kind: "once", controls };
  }
  const fields = routine.cronExpr?.trim().split(/\s+/) ?? [];
  const [sec, minute, hour, dom, month, dow] = fields;
  if (fields.length !== 6 || sec !== "0" || dom !== "*" || month !== "*") {
    controls.custom = routine.cronExpr ?? "";
    return { kind: "custom", controls };
  }
  const minuteValue = Number(minute);
  const hourValue = Number(hour);
  if (Number.isInteger(minuteValue) && minuteValue >= 0 && minuteValue <= 59) {
    controls.minute = minuteValue;
  }
  if (hour === "*") {
    return { kind: "hourly", controls };
  }
  if (!Number.isInteger(hourValue) || hourValue < 0 || hourValue > 23) {
    controls.custom = routine.cronExpr ?? "";
    return { kind: "custom", controls };
  }
  controls.hour = hourValue;
  if (dow === "*") {
    return { kind: "daily", controls };
  }
  const weekday = /^\d+$/.test(dow) ? Number(dow) : weekdayValue(dow);
  if (weekday !== null && WEEKDAY_NAME_BY_VALUE.has(weekday)) {
    controls.weekday = weekday;
    return { kind: "weekly", controls };
  }
  controls.custom = routine.cronExpr ?? "";
  return { kind: "custom", controls };
}

/** One-line description for list rows. Friendly when the expression matches
 *  a generated shape, the raw cron string otherwise. */
export function describeSchedule(routine: Pick<Routine, "cronExpr" | "runOnceAt">): string {
  // A one-shot's date is already the next run, which the row states beside
  // this. Repeating it here would say the same thing twice.
  if (routine.runOnceAt) {
    return "Once";
  }
  const { kind, controls } = parseSchedule(routine);
  const time = `${pad2(controls.hour)}:${pad2(controls.minute)}`;
  switch (kind) {
    case "hourly":
      return `Hourly at :${pad2(controls.minute)}`;
    case "daily":
      return `Daily at ${time}`;
    case "weekly": {
      const label = WEEKDAY_OPTIONS.find((option) => option.value === controls.weekday)?.label;
      return `Weekly on ${label ?? "?"} at ${time}`;
    }
    default:
      return routine.cronExpr ?? "";
  }
}

const WEEKDAY_FULL_NAME = new Map([
  [1, "Sunday"],
  [2, "Monday"],
  [3, "Tuesday"],
  [4, "Wednesday"],
  [5, "Thursday"],
  [6, "Friday"],
  [7, "Saturday"]
]);

/** Full weekday names in the Monday-first display order of
 *  {@link WEEKDAY_OPTIONS}, keyed by the cron dow number as a string — the
 *  editor's day picker speaks strings. */
export const WEEKDAY_PICKER_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  WEEKDAY_OPTIONS.map((option) => ({
    value: String(option.value),
    label: WEEKDAY_FULL_NAME.get(option.value) ?? option.label
  }));

/** The cadence as a sentence fragment — "every day at 09:00". The editor reads
 *  it back to the user while they build the schedule, so the six cron fields
 *  never have to be decoded by eye. Returns null for a custom expression,
 *  which has no honest plain-English form. */
export function describeCadence(kind: ScheduleKind, controls: ScheduleControls): string | null {
  const time = `${pad2(controls.hour)}:${pad2(controls.minute)}`;
  switch (kind) {
    case "once":
      return controls.onceAt ? `once on ${formatOnceInput(controls.onceAt)}` : null;
    case "hourly":
      return `every hour at :${pad2(controls.minute)}`;
    case "daily":
      return `every day at ${time}`;
    case "weekly":
      return `every ${WEEKDAY_FULL_NAME.get(controls.weekday) ?? "Monday"} at ${time}`;
    case "custom":
      return null;
  }
}

/** Compact relative time for the list's "next run" column — "in 14h", "in 3d".
 *  Past times read as "due" rather than a negative, because the scheduler
 *  fires overdue rows on its next tick instead of skipping them. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "—";
  const deltaMs = target - now;
  if (deltaMs <= 0) return "due";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `in ${days}d`;
  return `in ${Math.round(days / 7)}w`;
}

function formatOnceInput(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** RFC 3339 UTC → datetime-local input value in the user's timezone. */
function toLocalInputValue(runOnceAt: string): string {
  const parsed = new Date(runOnceAt);
  if (Number.isNaN(parsed.getTime())) return "";
  const offsetMs = parsed.getTime() - parsed.getTimezoneOffset() * 60_000;
  return new Date(offsetMs).toISOString().slice(0, 16);
}
