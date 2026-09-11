import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import type { ActivityResolution, ActivitySeriesPoint } from "./activityContract.js";
import { formatBucketLabel, formatBucketTitle, formatCompact, formatCount } from "./activityFormat.js";
import type { ActivityChartSeries } from "./activityPresentation.js";

/**
 * The window's commits (or lines) as a stacked area, one band per repository —
 * a sibling of `UsageAreaChart` rather than a reuse of it: that chart's series
 * are `ProviderId`s with a fixed palette and its bands are *overlaid*, because
 * four providers' costs are four independent quantities. Repositories add up
 * to the day's work, so the bands stack and the top edge is the total.
 *
 * Same construction rules as its sibling: geometry in SVG attributes only,
 * measured with a `ResizeObserver` rather than scaled with
 * `preserveAspectRatio` so text stays crisp and stroke weight honest, and the
 * numbers published as a clipped table because `role="img"` takes the SVG's
 * own contents out of the accessibility tree.
 */

const AXIS_HEIGHT = 24;
const PAD_LEFT = 44;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
/** Used until the ResizeObserver reports; also the size the tests measure at. */
const FALLBACK_WIDTH = 1052;
const FALLBACK_HEIGHT = 236;
const MIN_HEIGHT = 190;
const MAX_HEIGHT = 420;
/** Interval counts a "nice" axis may use; the tightest headroom wins. */
const TICK_COUNTS = [4, 5, 6];
const TOOLTIP_WIDTH = 196;
const TOOLTIP_ROW = 17;

/** A "nice" axis step: 1, 2, 2.5, or 5 times a power of ten. */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const scaled = rough / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

function niceTicks(max: number): { top: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, ticks: [0, 1] };
  let best: { top: number; step: number } | null = null;
  for (const count of TICK_COUNTS) {
    const step = niceStep(max / count);
    const top = Math.ceil(max / step) * step;
    if (!best || top < best.top) best = { top, step };
  }
  const { top, step } = best ?? { top: max, step: max };
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return { top, ticks };
}

/**
 * Fritsch–Carlson monotone cubic tangents. Shape-preserving, which a stacked
 * chart needs rather than merely likes: a Catmull-Rom spline overshoots on the
 * way out of a spike, and an overshooting upper band crosses the one under it
 * — drawing a repository as having done negative work.
 */
function monotoneTangents(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  if (n < 2) return new Array<number>(n).fill(0);
  const secants: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = xs[i + 1] - xs[i];
    secants.push(dx === 0 ? 0 : (ys[i + 1] - ys[i]) / dx);
  }
  const m = new Array<number>(n);
  m[0] = secants[0];
  m[n - 1] = secants[n - 2];
  for (let i = 1; i < n - 1; i += 1) m[i] = (secants[i - 1] + secants[i]) / 2;
  for (let i = 0; i < n - 1; i += 1) {
    if (secants[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / secants[i];
    const b = m[i + 1] / secants[i];
    if (a < 0) m[i] = 0;
    if (b < 0) m[i + 1] = 0;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * secants[i];
      m[i + 1] = t * b * secants[i];
    }
  }
  return m;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function monotonePath(xs: number[], ys: number[]): string {
  if (xs.length === 0) return "";
  if (xs.length === 1) return `M ${round(xs[0])} ${round(ys[0])}`;
  const m = monotoneTangents(xs, ys);
  let d = `M ${round(xs[0])} ${round(ys[0])}`;
  for (let i = 0; i < xs.length - 1; i += 1) {
    const dx = xs[i + 1] - xs[i];
    d += ` C ${round(xs[i] + dx / 3)} ${round(ys[i] + (m[i] * dx) / 3)} ${round(xs[i + 1] - dx / 3)} ${round(ys[i + 1] - (m[i + 1] * dx) / 3)} ${round(xs[i + 1])} ${round(ys[i + 1])}`;
  }
  return d;
}

/** How many x labels fit: three at any usable width, one when there is one bucket. */
function labelIndices(count: number): number[] {
  if (count <= 1) return [0];
  if (count === 2) return [0, 1];
  return [0, Math.floor((count - 1) / 2), count - 1];
}

export function ActivityChart({
  points,
  series,
  resolution,
  timeZone,
  title
}: {
  points: readonly ActivitySeriesPoint[];
  series: readonly ActivityChartSeries[];
  resolution: ActivityResolution;
  timeZone: string;
  /** The chart's own heading, reused as the opening of its `aria-label`. */
  title: string;
}): JSX.Element {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT });
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const tableId = useId();
  const gradientId = useId();

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      // A zero read happens while the page is still laying out; keeping the
      // previous size avoids a frame of collapsed geometry.
      if (!rect || rect.width <= 0) return;
      setSize((current) => {
        const height =
          rect.height > 0
            ? Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, rect.height)))
            : current.height;
        return current.width === rect.width && current.height === height
          ? current
          : { width: rect.width, height };
      });
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  /**
   * Cumulative bands, smallest first, so the largest repository ends up on top
   * of the stack. Each band's upper edge is the running total under it plus
   * its own value; the band below it is the fill boundary.
   */
  const bands = useMemo(() => {
    const running = new Array<number>(points.length).fill(0);
    // Reversed: the tail and the small repositories carry the floor.
    return [...series]
      .reverse()
      .map((entry) => {
        const lower = [...running];
        entry.values.forEach((value, index) => {
          running[index] += value;
        });
        return { entry, lower, upper: [...running] };
      })
      .reverse();
  }, [points.length, series]);

  const totals = useMemo(
    () => points.map((_, index) => series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0)),
    [points, series]
  );
  const { top, ticks } = niceTicks(Math.max(...totals, 0));

  const { width, height } = size;
  const plotWidth = Math.max(80, width - PAD_LEFT - PAD_RIGHT);
  const plotBottom = height - AXIS_HEIGHT;
  const plotTop = PAD_TOP;
  const xAt = useCallback(
    (index: number): number =>
      points.length <= 1
        ? PAD_LEFT + plotWidth / 2
        : PAD_LEFT + (plotWidth * index) / (points.length - 1),
    [points.length, plotWidth]
  );
  const yAt = useCallback(
    (value: number): number => plotBottom - (plotBottom - plotTop) * (top === 0 ? 0 : value / top),
    [plotBottom, plotTop, top]
  );

  const indexFromClientX = useCallback(
    (clientX: number): number | null => {
      const frame = frameRef.current;
      if (!frame || points.length === 0) return null;
      const rect = frame.getBoundingClientRect();
      if (rect.width === 0) return null;
      if (points.length === 1) return 0;
      const ratio = (clientX - rect.left - PAD_LEFT) / plotWidth;
      return Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
    },
    [plotWidth, points.length]
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>): void => {
      if (points.length === 0) return;
      const last = points.length - 1;
      const current = activeIndex ?? 0;
      if (event.key === "ArrowRight") setActiveIndex(Math.min(last, current + 1));
      else if (event.key === "ArrowLeft") setActiveIndex(Math.max(0, current - 1));
      else if (event.key === "Home") setActiveIndex(0);
      else if (event.key === "End") setActiveIndex(last);
      else if (event.key === "Escape") {
        if (activeIndex === null) return;
        setActiveIndex(null);
      } else return;
      event.preventDefault();
    },
    [activeIndex, points.length]
  );

  // A window change can shorten the series under a held crosshair.
  useEffect(() => {
    setActiveIndex((current) => (current !== null && current > points.length - 1 ? null : current));
  }, [points.length]);

  const bucketNoun = resolution === "hour" ? "hours" : resolution === "week" ? "weeks" : "days";
  const peakIndex = totals.reduce(
    (best, value, index) => (value > (totals[best] ?? -1) ? index : best),
    -1
  );
  const ariaLabel = [
    `${title} by repository, ${formatCount(points.length)} ${bucketNoun}.`,
    ...series.map((entry) => {
      const sum = entry.values.reduce((total, value) => total + value, 0);
      return `${entry.label} ${formatCount(sum)}.`;
    }),
    peakIndex >= 0 && totals[peakIndex] > 0
      ? `Busiest ${bucketNoun.slice(0, -1)} ${formatBucketTitle(points[peakIndex].bucketStart, resolution, timeZone)} at ${formatCount(totals[peakIndex])}.`
      : ""
  ]
    .filter(Boolean)
    .join(" ");

  if (points.length === 0 || series.length === 0) {
    return (
      <div className="activity-chart" ref={frameRef}>
        <p className="activity-empty-note">Nothing landed in this window.</p>
      </div>
    );
  }

  const xs = points.map((_, index) => xAt(index));
  const cursorIndex = activeIndex;
  const activeRows =
    cursorIndex === null
      ? []
      : series
          .map((entry) => ({ key: entry.key, label: entry.label, slot: entry.slot, value: entry.values[cursorIndex] ?? 0 }))
          .filter((row) => row.value > 0);
  const activeTotal = cursorIndex === null ? 0 : totals[cursorIndex];
  const showTotal = activeRows.length > 1;
  const tooltipHeight =
    26 + (Math.max(1, activeRows.length) + (showTotal ? 1 : 0)) * TOOLTIP_ROW + (showTotal ? 6 : 0);
  const anchorX = cursorIndex === null ? 0 : xAt(cursorIndex);
  const flip = anchorX + 12 + TOOLTIP_WIDTH > PAD_LEFT + plotWidth;
  const tooltipX = flip ? anchorX - 12 - TOOLTIP_WIDTH : anchorX + 12;
  const tooltipY = Math.min(plotBottom - tooltipHeight, plotTop + 6);

  return (
    <div className="activity-chart" ref={frameRef}>
      <svg
        className="activity-chart-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        aria-describedby={tableId}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={(event) => setActiveIndex(indexFromClientX(event.clientX))}
        onPointerLeave={() => setActiveIndex(null)}
        onBlur={() => setActiveIndex(null)}
      >
        <g className="activity-chart-grid">
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                className="activity-chart-gridline"
                x1={PAD_LEFT}
                x2={PAD_LEFT + plotWidth}
                y1={round(yAt(tick))}
                y2={round(yAt(tick))}
                data-baseline={tick === 0 ? "true" : undefined}
              />
              <text
                className="activity-chart-tick"
                x={PAD_LEFT - 10}
                y={round(yAt(tick)) + 3.5}
                textAnchor="end"
              >
                {formatCompact(tick)}
              </text>
            </g>
          ))}
        </g>

        {/* Fills first, top band down, then every stroke, so no fill is ever
            painted over the line it belongs to. */}
        {bands.map((band) => {
          const upper = band.upper.map((value) => yAt(value));
          const lower = band.lower.map((value) => yAt(value));
          const upperPath = monotonePath(xs, upper);
          // The lower edge walked back the other way, so the two joins close a
          // ribbon rather than crossing through it.
          const lowerPath = monotonePath([...xs].reverse(), [...lower].reverse());
          const area = points.length === 1 ? "" : `${upperPath} L ${lowerPath.slice(2)} Z`;
          return (
            <g
              className="activity-chart-band activity-series"
              key={band.entry.key}
              data-slot={band.entry.slot}
            >
              {/* The gradient sits inside the band's group so its stops inherit
                  that group's `--activity-series`; one shared <defs> block
                  would resolve every band to the same colour. */}
              {area ? (
                <defs>
                  <linearGradient id={`${gradientId}-${band.entry.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop className="activity-chart-area-stop" offset="0%" data-stop="top" />
                    <stop className="activity-chart-area-stop" offset="100%" data-stop="bottom" />
                  </linearGradient>
                </defs>
              ) : null}
              {area ? (
                <path
                  className="activity-chart-area"
                  d={area}
                  fill={`url(#${gradientId}-${band.entry.key})`}
                />
              ) : null}
            </g>
          );
        })}
        {bands.map((band) => (
          <g
            className="activity-chart-band activity-series"
            key={`${band.entry.key}-line`}
            data-slot={band.entry.slot}
          >
            <path
              className="activity-chart-line"
              d={monotonePath(xs, band.upper.map((value) => yAt(value)))}
            />
            {points.length === 1 ? (
              <circle
                className="activity-chart-point"
                cx={round(xs[0])}
                cy={round(yAt(band.upper[0]))}
                r="3.5"
              />
            ) : null}
          </g>
        ))}

        <g className="activity-chart-axis">
          {labelIndices(points.length).map((index) => (
            <text
              className="activity-chart-xlabel"
              key={index}
              x={round(xAt(index))}
              y={plotBottom + 17}
              textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
            >
              {formatBucketLabel(points[index].bucketStart, resolution, timeZone)}
            </text>
          ))}
        </g>

        {cursorIndex === null ? null : (
          <g className="activity-chart-cursor">
            <line
              className="activity-chart-crosshair"
              x1={round(anchorX)}
              x2={round(anchorX)}
              y1={plotTop}
              y2={round(plotBottom)}
            />
            <circle
              className="activity-chart-marker"
              cx={round(anchorX)}
              cy={round(yAt(activeTotal))}
              r="3"
            />
            <g
              className="activity-chart-tooltip"
              transform={`translate(${round(tooltipX)} ${round(tooltipY)})`}
            >
              <rect
                className="activity-chart-tooltip-box"
                x="0"
                y="0"
                width={TOOLTIP_WIDTH}
                height={tooltipHeight}
                rx="8"
              />
              <text className="activity-chart-tooltip-title" x="12" y="17">
                {formatBucketTitle(points[cursorIndex].bucketStart, resolution, timeZone)}
              </text>
              {activeRows.length === 0 ? (
                <text className="activity-chart-tooltip-empty" x="12" y={17 + TOOLTIP_ROW}>
                  Nothing landed
                </text>
              ) : (
                activeRows.map((row, rowIndex) => (
                  <g
                    className="activity-series"
                    key={row.key}
                    data-slot={row.slot}
                    transform={`translate(0 ${20 + rowIndex * TOOLTIP_ROW})`}
                  >
                    <circle className="activity-chart-tooltip-dot" cx="16" cy="8" r="3" />
                    <text className="activity-chart-tooltip-name" x="26" y="11">
                      {row.label}
                    </text>
                    <text
                      className="activity-chart-tooltip-value"
                      x={TOOLTIP_WIDTH - 12}
                      y="11"
                      textAnchor="end"
                    >
                      {formatCount(row.value)}
                    </text>
                  </g>
                ))
              )}
              {showTotal ? (
                <g transform={`translate(0 ${20 + activeRows.length * TOOLTIP_ROW + 6})`}>
                  <line
                    className="activity-chart-tooltip-rule"
                    x1="12"
                    x2={TOOLTIP_WIDTH - 12}
                    y1="0"
                    y2="0"
                  />
                  <text className="activity-chart-tooltip-name" x="12" y="13">
                    Total
                  </text>
                  <text
                    className="activity-chart-tooltip-value"
                    x={TOOLTIP_WIDTH - 12}
                    y="13"
                    textAnchor="end"
                  >
                    {formatCount(activeTotal)}
                  </text>
                </g>
              ) : null}
            </g>
          </g>
        )}
      </svg>

      {/* The same numbers, reachable by screen reader and by copy-paste. */}
      <table className="activity-visually-hidden" id={tableId} aria-label={`${title} by repository`}>
        <caption>{title} by repository</caption>
        <thead>
          <tr>
            <th scope="col">
              {resolution === "hour" ? "Hour" : resolution === "week" ? "Week" : "Day"}
            </th>
            {series.map((entry) => (
              <th scope="col" key={entry.key}>
                {entry.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={point.bucketStart}>
              <th scope="row">{formatBucketTitle(point.bucketStart, resolution, timeZone)}</th>
              {series.map((entry) => (
                <td key={entry.key}>{formatCount(entry.values[index] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
