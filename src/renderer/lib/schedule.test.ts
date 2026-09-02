import { describe, expect, it } from "vitest";
import {
  buildSchedule,
  describeCadence,
  describeSchedule,
  formatRelative,
  parseSchedule,
  type ScheduleControls
} from "./schedule.js";

const controls: ScheduleControls = {
  onceAt: "2026-09-01T09:30",
  minute: 30,
  hour: 9,
  weekday: 3,
  custom: "0 0 12 * * *"
};

describe("buildSchedule", () => {
  it("generates the six-field cron dialect from friendly controls", () => {
    expect(buildSchedule("daily", controls)).toEqual({
      cronExpr: "0 30 9 * * *",
      runOnceAt: null
    });
    expect(buildSchedule("hourly", controls)).toEqual({
      cronExpr: "0 30 * * * *",
      runOnceAt: null
    });
    // cron dow: 1 = Sunday, so weekday 3 = Tuesday.
    expect(buildSchedule("weekly", controls)).toEqual({
      cronExpr: "0 30 9 * * Tue",
      runOnceAt: null
    });
  });

  it("passes the naive local once-time through for Rust to normalize", () => {
    expect(buildSchedule("once", controls)).toEqual({
      cronExpr: null,
      runOnceAt: "2026-09-01T09:30"
    });
  });

  it("keeps an unfinished schedule null so Save can catch it", () => {
    expect(buildSchedule("once", { ...controls, onceAt: "" }).runOnceAt).toBeNull();
    expect(buildSchedule("custom", { ...controls, custom: "  " }).cronExpr).toBeNull();
  });
});

describe("parseSchedule", () => {
  it("round-trips generated schedules back to the same kind and controls", () => {
    for (const kind of ["hourly", "daily", "weekly"] as const) {
      const stored = buildSchedule(kind, controls);
      const parsed = parseSchedule(stored);
      expect(parsed.kind).toBe(kind);
      expect(parsed.controls.minute).toBe(30);
      if (kind !== "hourly") expect(parsed.controls.hour).toBe(9);
      if (kind === "weekly") expect(parsed.controls.weekday).toBe(3);
    }
  });

  it("parses both weekday names and cron dow numbers", () => {
    expect(parseSchedule({ cronExpr: "0 0 9 * * Wed", runOnceAt: null }).controls.weekday).toBe(4);
    expect(parseSchedule({ cronExpr: "0 0 9 * * 2", runOnceAt: null }).controls.weekday).toBe(2);
  });

  it("falls back to custom for expressions the friendly kinds cannot express", () => {
    const parsed = parseSchedule({ cronExpr: "*/15 * * * * *", runOnceAt: null });
    expect(parsed.kind).toBe("custom");
    expect(parsed.controls.custom).toBe("*/15 * * * * *");
  });

  // The editor re-serializes whatever kind it parsed on every save, so a
  // cadence the friendly kinds cannot hold has to come back as `custom` —
  // otherwise renaming a task quietly rewrites when it runs.
  it("survives a parse → build round trip for cadences only custom can hold", () => {
    for (const cronExpr of ["0 */15 9 * * *", "0 0,30 9 * * *", "0 30 * * * Mon"]) {
      const { kind, controls: parsed } = parseSchedule({ cronExpr, runOnceAt: null });
      expect(kind).toBe("custom");
      expect(buildSchedule(kind, parsed).cronExpr).toBe(cronExpr);
    }
  });

  it("treats a stored once-time as the once kind", () => {
    const parsed = parseSchedule({ cronExpr: null, runOnceAt: "2026-09-01T09:30:00.000Z" });
    expect(parsed.kind).toBe("once");
    expect(parsed.controls.onceAt).not.toBe("");
  });
});

describe("describeSchedule", () => {
  it("renders friendly text for generated schedules", () => {
    expect(describeSchedule(buildSchedule("daily", controls))).toBe("Daily at 09:30");
    expect(describeSchedule(buildSchedule("weekly", controls))).toBe("Weekly on Tue at 09:30");
    expect(describeSchedule(buildSchedule("hourly", controls))).toBe("Hourly at :30");
  });

  it("shows the raw cron string for custom expressions", () => {
    expect(describeSchedule({ cronExpr: "*/15 * * * * *", runOnceAt: null })).toBe("*/15 * * * * *");
    // A quarter-hourly run must not read as "Daily at 09:00": the row would
    // then describe a cadence the task does not have.
    expect(describeSchedule({ cronExpr: "0 */15 9 * * *", runOnceAt: null })).toBe("0 */15 9 * * *");
  });
});

describe("describeCadence", () => {
  it("reads the schedule back as a sentence fragment", () => {
    expect(describeCadence("daily", controls)).toBe("every day at 09:30");
    expect(describeCadence("hourly", controls)).toBe("every hour at :30");
    expect(describeCadence("weekly", controls)).toBe("every Tuesday at 09:30");
  });

  // A cron expression has no honest plain-English form, and an unfinished
  // one-shot has no time yet — both must say so rather than invent a sentence.
  it("returns null when there is nothing truthful to say", () => {
    expect(describeCadence("custom", controls)).toBeNull();
    expect(describeCadence("once", { ...controls, onceAt: "" })).toBeNull();
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-09-01T09:00:00.000Z");

  it("counts down in the largest unit that still reads precisely", () => {
    expect(formatRelative("2026-09-01T09:30:00.000Z", now)).toBe("in 30m");
    expect(formatRelative("2026-09-01T20:00:00.000Z", now)).toBe("in 11h");
    expect(formatRelative("2026-09-04T09:00:00.000Z", now)).toBe("in 3d");
    expect(formatRelative("2026-09-22T09:00:00.000Z", now)).toBe("in 3w");
  });

  // The scheduler fires overdue rows on its next tick rather than skipping
  // them, so a past time is pending work, not a negative countdown.
  it("shows an overdue run as due", () => {
    expect(formatRelative("2026-09-01T08:00:00.000Z", now)).toBe("due");
  });
});
