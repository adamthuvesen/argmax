import { useId, type JSX } from "react";
import type { ActivityHeatmapDay } from "./activityContract.js";
import { formatCalendarDateLong, formatCount, parseCalendarDate } from "./activityFormat.js";

/**
 * A year of commits, one cell a day, drawn straight into SVG — Argmax ships no
 * chart library, and the geometry lives in SVG attributes so `activity-*.css`
 * keeps every colour and radius (docs/styling.md).
 *
 * The grid is laid out from the dates themselves rather than from the array
 * index: the 365 days ending today start on whatever weekday they start on,
 * and counting cells would slide the whole year one column sideways whenever
 * that changed.
 */

const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
/** Room for the Mon / Wed / Fri gutter. */
const LABEL_W = 30;
/** Room for the month strip above the grid. */
const MONTH_H = 17;
const ROWS = 7;
/** Fewest pixels between two month labels before the second is dropped. */
const MONTH_LABEL_GAP = 28;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The weekday rows worth naming: naming all seven turns the gutter into a wall. */
const ROW_LABELS: ReadonlyArray<[string, number]> = [
  ["Mon", 0],
  ["Wed", 2],
  ["Fri", 4]
];

/**
 * Four filled steps plus an empty one. The thresholds are absolute rather than
 * quantiles of the year: a reader compares this year's Augusts with each
 * other, and a quantile ramp repaints every cell when one busy week lands.
 */
function level(commits: number): number {
  if (commits <= 0) return 0;
  if (commits <= 3) return 1;
  if (commits <= 7) return 2;
  if (commits <= 12) return 3;
  return 4;
}

interface Cell {
  day: ActivityHeatmapDay;
  column: number;
  row: number;
  /** True on the 1st of a month — where a month label may go. */
  monthStart: boolean;
  month: number;
}

function layout(days: readonly ActivityHeatmapDay[]): { cells: Cell[]; columns: number } {
  const first = days.length > 0 ? parseCalendarDate(days[0].date) : null;
  if (!first) return { cells: [], columns: 0 };
  // Monday-first row index; JS puts Sunday at 0.
  const firstRow = (first.getDay() + 6) % 7;
  const cells: Cell[] = [];
  let columns = 0;
  days.forEach((day, index) => {
    const at = parseCalendarDate(day.date);
    if (!at) return;
    const slot = firstRow + index;
    const column = Math.floor(slot / ROWS);
    columns = Math.max(columns, column + 1);
    cells.push({
      day,
      column,
      row: slot % ROWS,
      monthStart: at.getDate() === 1,
      month: at.getMonth()
    });
  });
  return { cells, columns };
}

export function ActivityHeatmap({ days }: { days: readonly ActivityHeatmapDay[] }): JSX.Element {
  const tableId = useId();
  const { cells, columns } = layout(days);
  const width = LABEL_W + Math.max(1, columns) * STEP;
  const height = MONTH_H + ROWS * STEP;
  const total = days.reduce((sum, day) => sum + day.commits, 0);
  const active = days.filter((day) => day.commits > 0).length;

  // The month strip: one label per month, dropped when its neighbour is close
  // enough that the two would touch.
  const monthLabels: Array<{ key: string; x: number; label: string }> = [];
  let lastX = -Infinity;
  for (const cell of cells) {
    if (!cell.monthStart) continue;
    const x = LABEL_W + cell.column * STEP;
    if (x - lastX < MONTH_LABEL_GAP) continue;
    lastX = x;
    monthLabels.push({ key: cell.day.date, x, label: MONTHS[cell.month] });
  }

  const ariaLabel =
    days.length === 0
      ? "No commit history yet."
      : `${formatCount(total)} commits across ${formatCount(active)} active days in the ${formatCount(days.length)} days ending ${formatCalendarDateLong(days[days.length - 1].date)}.`;

  return (
    <div className="activity-heatmap">
      <svg
        className="activity-heatmap-svg"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        aria-describedby={tableId}
      >
        <g className="activity-heatmap-months">
          {monthLabels.map((label) => (
            <text key={label.key} x={label.x} y={10}>
              {label.label}
            </text>
          ))}
        </g>
        <g className="activity-heatmap-rows">
          {ROW_LABELS.map(([label, row]) => (
            <text key={label} x={0} y={MONTH_H + row * STEP + 9}>
              {label}
            </text>
          ))}
        </g>
        {cells.map((cell, index) => (
          <rect
            className="activity-heatmap-cell"
            key={cell.day.date}
            data-level={level(cell.day.commits)}
            data-today={index === cells.length - 1 ? "true" : undefined}
            x={LABEL_W + cell.column * STEP}
            y={MONTH_H + cell.row * STEP}
            width={CELL}
            height={CELL}
            rx="2"
          >
            {/* The cell's own name. `<title>` inside a shape is what a hover
                and a screen reader both read, so the figure never needs a
                tooltip layer of its own. */}
            <title>
              {cell.day.commits === 0
                ? `No commits on ${formatCalendarDateLong(cell.day.date)}`
                : `${formatCount(cell.day.commits)} ${cell.day.commits === 1 ? "commit" : "commits"} on ${formatCalendarDateLong(cell.day.date)}`}
            </title>
          </rect>
        ))}
      </svg>
      <p className="activity-heatmap-legend" aria-hidden="true">
        Less
        {[0, 1, 2, 3, 4].map((step) => (
          <span className="activity-heatmap-swatch" key={step} data-level={step} />
        ))}
        More
      </p>
      {/* The same year as text, clipped rather than hidden so it stays in the
          accessibility tree. `role="img"` means the SVG's own contents are not
          the accessible version of the data — this is. */}
      <table className="activity-visually-hidden" id={tableId} aria-label="Commits per day">
        <caption>Commits per day</caption>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <th scope="row">{formatCalendarDateLong(day.date)}</th>
              <td>{formatCount(day.commits)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
