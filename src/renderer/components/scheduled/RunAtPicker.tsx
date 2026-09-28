import { useId, useState, type JSX, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useAnchoredPopover } from "../../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../../hooks/useDismissOnOutsideOrEscape.js";

/**
 * The one-off run time: a calendar and a time field in one popover, in place of
 * WebKit's `datetime-local` popup, which no stylesheet can reach. The value
 * stays the input's own format ("YYYY-MM-DDTHH:MM", local time), so the
 * schedule code that reads it is unchanged.
 */

const DEFAULT_TIME = "09:00";
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Monday-first cells for the month holding `month`; null pads the leading week. */
function monthCells(month: Date): Array<Date | null> {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  const length = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: Array<Date | null> = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= length; day += 1) cells.push(new Date(month.getFullYear(), month.getMonth(), day));
  return cells;
}

function triggerLabel(date: Date | null, time: string): string | null {
  if (!date) return null;
  const day = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const [hour, minute] = time.split(":").map(Number);
  const clock = new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} · ${clock}`;
}

export function RunAtPicker({
  id,
  value,
  onChange
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const [datePart = "", timePart = ""] = value.split("T");
  const selected = parseDateKey(datePart);
  const time = timePart || DEFAULT_TIME;
  const today = new Date();
  const todayKey = dateKey(today);
  const [open, setOpen] = useState(false);
  const timeId = useId();
  const [month, setMonth] = useState(() => selected ?? today);
  const [focusKey, setFocusKey] = useState(() => (selected ? datePart : todayKey));

  const popover = useAnchoredPopover({ open, placement: "bottom-end", strategy: "fixed" });
  useDismissOnOutsideOrEscape(popover.anchorRef, open, () => setOpen(false), popover.popoverRef);

  const openPicker = (): void => {
    const start = selected ?? today;
    setMonth(start);
    setFocusKey(dateKey(start));
    setOpen(!open);
  };
  const choose = (date: Date): void => onChange(`${dateKey(date)}T${time}`);
  const shiftMonth = (by: number): void => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));

  // Arrow keys walk the days and carry the view across month edges.
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    const current = parseDateKey(focusKey);
    if (step === undefined || !current) return;
    event.preventDefault();
    const next = addDays(current, step);
    if (dateKey(next) < todayKey) return;
    setFocusKey(dateKey(next));
    setMonth(next);
    requestAnimationFrame(() => {
      popover.popoverRef.current?.querySelector<HTMLButtonElement>(`[data-day="${dateKey(next)}"]`)?.focus();
    });
  };

  const label = triggerLabel(selected, time);
  const isCurrentMonth = month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();

  const panel = open ? (
    <div
      className="project-picker-popover picker-popover-portaled run-at-popover"
      role="dialog"
      aria-label="Run at"
      ref={popover.setPopover}
      style={popover.floatingStyles}
    >
      <div className="run-at-header">
        <span className="run-at-month" aria-live="polite">
          {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </span>
        <button
          type="button"
          className="run-at-nav"
          aria-label="Previous month"
          disabled={isCurrentMonth}
          onClick={() => shiftMonth(-1)}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <button type="button" className="run-at-nav" aria-label="Next month" onClick={() => shiftMonth(1)}>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="run-at-grid" role="group" aria-label="Day" onKeyDown={onGridKeyDown}>
        {WEEKDAYS.map((weekday) => (
          <span key={weekday} className="run-at-weekday" aria-hidden="true">
            {weekday}
          </span>
        ))}
        {monthCells(month).map((date, index) => {
          if (!date) return <span key={`pad-${index}`} aria-hidden="true" />;
          const key = dateKey(date);
          return (
            <button
              key={key}
              type="button"
              className="run-at-day"
              data-day={key}
              data-today={key === todayKey || undefined}
              aria-pressed={key === datePart}
              aria-label={date.toLocaleDateString(undefined, { dateStyle: "full" })}
              disabled={key < todayKey}
              tabIndex={key === focusKey ? 0 : -1}
              onClick={() => {
                setFocusKey(key);
                choose(date);
              }}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
      <div className="run-at-footer">
        <label className="run-at-time-label" htmlFor={timeId}>
          Time
        </label>
        <input
          id={timeId}
          type="time"
          className="sched-input run-at-time"
          value={time}
          onChange={(event) => {
            if (!event.target.value) return;
            onChange(`${datePart || todayKey}T${event.target.value}`);
          }}
        />
        <button type="button" className="sched-button sched-button-primary run-at-done" onClick={() => setOpen(false)}>
          Done
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div className="sched-picker" ref={popover.setAnchor}>
      <button
        type="button"
        id={id}
        className="settings-picker-trigger run-at-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openPicker}
      >
        <CalendarDays size={14} aria-hidden="true" />
        <span className="settings-picker-trigger-label" data-empty={label ? undefined : true}>
          {label ?? "Pick a date"}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </div>
  );
}
