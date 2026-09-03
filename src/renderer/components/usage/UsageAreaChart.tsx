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
import type { ProviderId, UsageResolution, UsageSeriesPoint } from "../../../shared/types.js";
import { formatBucketLabel, formatBucketTitle, formatMetric, formatUsdCompact, formatTokens } from "./usageFormat.js";
import { providerLabel, type UsageMetric } from "./usagePresentation.js";

/**
 * A hand-rolled overlaid area chart — one curve per provider, drawn straight
 * into SVG because Argmax ships no chart library (docs/styling.md).
 *
 * The geometry lives in SVG attributes rather than inline styles, so the
 * stylesheet still owns every colour, weight, and radius on screen. The
 * element is measured rather than scaled with `preserveAspectRatio`, which
 * keeps text crisp and stroke weight honest at any window width.
 */

const AXIS_HEIGHT = 24;
const PAD_LEFT = 52;
const PAD_RIGHT = 14;
const PAD_TOP = 14;
/** Used until the ResizeObserver reports; also the size tests measure at. */
const FALLBACK_WIDTH = 760;
const FALLBACK_HEIGHT = 232;
/** The plot takes the height its card has left over, inside these bounds. */
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 420;
/** Interval counts a "nice" axis is allowed to use, tightest headroom wins. */
const TICK_COUNTS = [4, 5, 6];
const TOOLTIP_WIDTH = 184;
const TOOLTIP_ROW = 17;

/** A "nice" axis step: 1, 2, 2.5, or 5 times a power of ten. */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const scaled = rough / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Round the axis up to a readable step, choosing the interval count that
 * wastes the least headroom. A single fixed count regularly rounded a $110
 * peak up to a $150 ceiling and left a quarter of the plot empty.
 */
function niceTicks(max: number): { top: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, ticks: [0, 1] };
  let best: { top: number; step: number } | null = null;
  for (const count of TICK_COUNTS) {
    const step = niceStep(max / count);
    const top = Math.ceil(max / step) * step;
    if (!best || top < best.top) best = { top, step };
  }
  const { top, step } = best as { top: number; step: number };
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return { top, ticks };
}

/**
 * Fritsch–Carlson monotone cubic tangents. Shape-preserving: the curve stays
 * inside each pair of neighbouring values, so a quiet day between two busy
 * ones can never be drawn as a dip below zero.
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

function monotonePath(xs: number[], ys: number[]): string {
  if (xs.length === 0) return "";
  if (xs.length === 1) return `M ${round(xs[0])} ${round(ys[0])}`;
  const m = monotoneTangents(xs, ys);
  let d = `M ${round(xs[0])} ${round(ys[0])}`;
  for (let i = 0; i < xs.length - 1; i += 1) {
    const dx = xs[i + 1] - xs[i];
    const c1x = xs[i] + dx / 3;
    const c1y = ys[i] + (m[i] * dx) / 3;
    const c2x = xs[i + 1] - dx / 3;
    const c2y = ys[i + 1] - (m[i + 1] * dx) / 3;
    d += ` C ${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(xs[i + 1])} ${round(ys[i + 1])}`;
  }
  return d;
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function UsageAreaChart({
  points,
  providers,
  metric,
  resolution,
  timeZone,
  title
}: {
  points: readonly UsageSeriesPoint[];
  providers: readonly ProviderId[];
  metric: UsageMetric;
  resolution: UsageResolution;
  timeZone: string;
  /** The chart's own heading, reused as the opening of its `aria-label`. */
  title: string;
}): JSX.Element {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT });
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const tableId = useId();

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

  const series = useMemo(
    () =>
      providers.map((provider) => ({
        provider,
        values: points.map((point) => {
          const entry = point.values.find((value) => value.provider === provider);
          if (!entry) return 0;
          return metric === "cost" ? entry.costUsd : entry.tokens;
        })
      })),
    [providers, points, metric]
  );

  const maxValue = series.reduce(
    (max, entry) => entry.values.reduce((inner, value) => Math.max(inner, value), max),
    0
  );
  const { top, ticks } = niceTicks(maxValue);

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

  const xs = points.map((_, index) => xAt(index));

  const formatValue = useCallback(
    (value: number): string => formatMetric(value, metric),
    [metric]
  );
  const formatTick = useCallback(
    (value: number): string => (metric === "cost" ? formatUsdCompact(value) : formatTokens(value)),
    [metric]
  );

  const totals = series.map((entry) => ({
    provider: entry.provider,
    total: entry.values.reduce((sum, value) => sum + value, 0)
  }));
  const peak = points.reduce(
    (best, point, index) => {
      const sum = series.reduce((inner, entry) => inner + entry.values[index], 0);
      return sum > best.sum ? { sum, index } : best;
    },
    { sum: -1, index: -1 }
  );

  const ariaLabel = [
    `${title} by provider, ${points.length} ${resolution === "hour" ? "hours" : "days"}.`,
    ...totals.map((entry) => `${providerLabel(entry.provider)} ${formatValue(entry.total)}.`),
    peak.index >= 0
      ? `Busiest ${resolution === "hour" ? "hour" : "day"} ${formatBucketTitle(points[peak.index].bucketStart, resolution, timeZone)} at ${formatValue(peak.sum)}.`
      : ""
  ]
    .filter(Boolean)
    .join(" ");

  const indexFromClientX = useCallback(
    (clientX: number): number | null => {
      const frame = frameRef.current;
      if (!frame || points.length === 0) return null;
      const rect = frame.getBoundingClientRect();
      if (rect.width === 0) return null;
      const local = clientX - rect.left - PAD_LEFT;
      if (points.length === 1) return 0;
      const ratio = local / plotWidth;
      return Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
    },
    [plotWidth, points.length]
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<SVGSVGElement>): void => {
      if (points.length === 0) return;
      const last = points.length - 1;
      const current = activeIndex ?? 0;
      if (event.key === "ArrowRight") {
        setActiveIndex(Math.min(last, current + 1));
      } else if (event.key === "ArrowLeft") {
        setActiveIndex(Math.max(0, current - 1));
      } else if (event.key === "Home") {
        setActiveIndex(0);
      } else if (event.key === "End") {
        setActiveIndex(last);
      } else if (event.key === "Escape") {
        if (activeIndex === null) return;
        setActiveIndex(null);
      } else {
        return;
      }
      event.preventDefault();
    },
    [activeIndex, points.length]
  );

  // A window change can shorten the series under a held crosshair.
  useEffect(() => {
    setActiveIndex((current) =>
      current !== null && current > points.length - 1 ? null : current
    );
  }, [points.length]);

  if (points.length === 0 || providers.length === 0) {
    return (
      <div className="usage-chart" ref={frameRef}>
        <p className="usage-empty-note">No usage recorded in this window.</p>
      </div>
    );
  }

  const labelIndices = Array.from(
    new Set(
      points.length === 1
        ? [0]
        : points.length === 2
          ? [0, points.length - 1]
          : [0, Math.floor((points.length - 1) / 2), points.length - 1]
    )
  );

  const cursorIndex = activeIndex;
  const active = cursorIndex === null ? null : points[cursorIndex];
  const activeRows =
    cursorIndex === null
      ? []
      : series
          .map((entry) => ({ provider: entry.provider, value: entry.values[cursorIndex] }))
          .filter((row) => row.value > 0);
  const tooltipHeight = 26 + Math.max(1, activeRows.length) * TOOLTIP_ROW;
  const anchorX = cursorIndex === null ? 0 : xAt(cursorIndex);
  const flip = anchorX + 12 + TOOLTIP_WIDTH > PAD_LEFT + plotWidth;
  const tooltipX = flip ? anchorX - 12 - TOOLTIP_WIDTH : anchorX + 12;
  const tooltipY = Math.min(plotBottom - tooltipHeight, plotTop + 6);

  return (
    <div className="usage-chart" ref={frameRef}>
      <svg
        className="usage-chart-svg"
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
        <g className="usage-chart-grid">
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                className="usage-chart-gridline"
                x1={PAD_LEFT}
                x2={PAD_LEFT + plotWidth}
                y1={round(yAt(tick))}
                y2={round(yAt(tick))}
                data-baseline={tick === 0 ? "true" : undefined}
              />
              <text
                className="usage-chart-tick"
                x={PAD_LEFT - 10}
                y={round(yAt(tick)) + 3.5}
                textAnchor="end"
              >
                {formatTick(tick)}
              </text>
            </g>
          ))}
        </g>

        {series.map((entry) => {
          const ys = entry.values.map((value) => yAt(value));
          const line = monotonePath(xs, ys);
          const area =
            points.length === 1
              ? ""
              : `${line} L ${round(xs[xs.length - 1])} ${round(plotBottom)} L ${round(xs[0])} ${round(plotBottom)} Z`;
          return (
            <g
              className="usage-chart-series usage-series"
              key={entry.provider}
              data-provider={entry.provider}
            >
              {area ? <path className="usage-chart-area" d={area} /> : null}
              <path className="usage-chart-line" d={line} />
              {points.length === 1 ? (
                <circle className="usage-chart-point" cx={round(xs[0])} cy={round(ys[0])} r="3.5" />
              ) : null}
            </g>
          );
        })}

        <g className="usage-chart-axis">
          {labelIndices.map((index) => (
            <text
              className="usage-chart-xlabel"
              key={index}
              x={round(xAt(index))}
              y={plotBottom + 17}
              textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
            >
              {formatBucketLabel(points[index].bucketStart, resolution, timeZone)}
            </text>
          ))}
        </g>

        {active ? (
          <g className="usage-chart-cursor">
            <line
              className="usage-chart-crosshair"
              x1={round(anchorX)}
              x2={round(anchorX)}
              y1={plotTop}
              y2={round(plotBottom)}
            />
            {series.map((entry) => (
              <circle
                className="usage-chart-marker usage-series"
                key={entry.provider}
                data-provider={entry.provider}
                cx={round(anchorX)}
                cy={round(yAt(entry.values[cursorIndex as number]))}
                r="3"
              />
            ))}
            <g className="usage-chart-tooltip" transform={`translate(${round(tooltipX)} ${round(tooltipY)})`}>
              <rect
                className="usage-chart-tooltip-box"
                x="0"
                y="0"
                width={TOOLTIP_WIDTH}
                height={tooltipHeight}
                rx="8"
              />
              <text className="usage-chart-tooltip-title" x="12" y="17">
                {formatBucketTitle(active.bucketStart, resolution, timeZone)}
              </text>
              {activeRows.length === 0 ? (
                <text className="usage-chart-tooltip-empty" x="12" y={17 + TOOLTIP_ROW}>
                  No usage
                </text>
              ) : (
                activeRows.map((row, rowIndex) => (
                  <g
                    className="usage-series"
                    key={row.provider}
                    data-provider={row.provider}
                    transform={`translate(0 ${20 + rowIndex * TOOLTIP_ROW})`}
                  >
                    <circle className="usage-chart-tooltip-dot" cx="16" cy="8" r="3" />
                    <text className="usage-chart-tooltip-name" x="26" y="11">
                      {providerLabel(row.provider)}
                    </text>
                    <text
                      className="usage-chart-tooltip-value"
                      x={TOOLTIP_WIDTH - 12}
                      y="11"
                      textAnchor="end"
                    >
                      {formatValue(row.value)}
                    </text>
                  </g>
                ))
              )}
            </g>
          </g>
        ) : null}
      </svg>

      {/* The same numbers, reachable by screen reader and by copy-paste. The
          SVG is `role="img"`, so its own contents are not the accessible
          version of the data — this is. */}
      <table className="usage-visually-hidden" id={tableId}>
        <caption>{title} by provider</caption>
        <thead>
          <tr>
            <th scope="col">{resolution === "hour" ? "Hour" : "Day"}</th>
            {series.map((entry) => (
              <th scope="col" key={entry.provider}>
                {providerLabel(entry.provider)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={point.bucketStart}>
              <th scope="row">{formatBucketTitle(point.bucketStart, resolution, timeZone)}</th>
              {series.map((entry) => (
                <td key={entry.provider}>{formatValue(entry.values[index])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
