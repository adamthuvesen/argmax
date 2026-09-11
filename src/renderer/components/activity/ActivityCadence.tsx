import type { JSX } from "react";
import type { ActivityCadence as Cadence } from "./activityContract.js";
import { formatCount } from "./activityFormat.js";
import {
  ACTIVITY_WEEKDAYS,
  cadenceReading,
  peakHour,
  peakWeekday,
  type ActivityPeak
} from "./activityPresentation.js";

/**
 * When the work landed: two small multiples on one card, then one sentence
 * saying what they mean together. The charts are the evidence and the sentence
 * is the reading — a reader who wants the pattern gets it in a line, and a
 * reader who doubts it can check the bars beside it.
 *
 * Both are drawn in one shared bar routine, so the weekday chart and the hour
 * chart cannot drift apart in weight, gap, or peak treatment.
 */

const CHART_HEIGHT = 132;
const CHART_TOP = 18;
const CHART_BOTTOM = 22;
/** The 24-hour chart is too dense for a figure over every bar. */
const HOUR_LABELS = ["0", "", "", "", "", "", "6", "", "", "", "", "", "12", "", "", "", "", "", "18", "", "", "", "", "23"];

interface BarChartProps {
  values: readonly number[];
  labels: readonly string[];
  /** The chart's own width in its viewBox; bars are laid out inside it. */
  width: number;
  /** Pixels of air between two bars, in the same space. */
  gap: number;
  /** Print every bar's figure, or only the peak's. */
  showEveryValue: boolean;
  peak: ActivityPeak | null;
  title: string;
}

function BarChart({
  values,
  labels,
  width,
  gap,
  showEveryValue,
  peak,
  title
}: BarChartProps): JSX.Element {
  const plotHeight = CHART_HEIGHT - CHART_TOP - CHART_BOTTOM;
  const base = CHART_TOP + plotHeight;
  const max = values.reduce((best, value) => Math.max(best, value), 0);
  const slot = width / Math.max(1, values.length);
  const barWidth = Math.max(2, slot - gap);

  return (
    <svg
      className="activity-bars"
      viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
      role="img"
      aria-label={
        peak
          ? `${title}. Peak ${peak.label}, ${formatCount(peak.value)} commits.`
          : `${title}. Nothing recorded.`
      }
    >
      <line className="activity-bars-base" x1="0" x2={width} y1={base + 0.5} y2={base + 0.5} />
      {values.map((value, index) => {
        const height = max > 0 ? (value / max) * plotHeight : 0;
        const x = index * slot + (slot - barWidth) / 2;
        const isPeak = peak?.index === index;
        const label = labels[index];
        return (
          <g key={index} data-peak={isPeak ? "true" : undefined}>
            <rect
              className="activity-bars-bar"
              x={Math.round(x * 10) / 10}
              y={Math.round((base - height) * 10) / 10}
              width={Math.round(barWidth * 10) / 10}
              height={Math.round(height * 10) / 10}
              rx={Math.min(2, barWidth / 2)}
            />
            {showEveryValue || isPeak ? (
              <text
                className="activity-bars-value"
                x={Math.round((x + barWidth / 2) * 10) / 10}
                y={Math.round((base - height - 5) * 10) / 10}
                textAnchor="middle"
              >
                {formatCount(value)}
              </text>
            ) : null}
            {label ? (
              <text
                className="activity-bars-label"
                x={Math.round((x + barWidth / 2) * 10) / 10}
                y={CHART_HEIGHT - 6}
                textAnchor="middle"
              >
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function ActivityCadence({
  cadence,
  commits
}: {
  cadence: Cadence;
  /** The window's commit count, so the card can name what it is describing. */
  commits: number;
}): JSX.Element {
  const weekday = peakWeekday(cadence);
  const hour = peakHour(cadence);
  const reading = cadenceReading(cadence);

  return (
    <section className="activity-card" aria-label="Cadence">
      <div className="activity-card-head">
        <h2 className="activity-card-title">Cadence</h2>
        <p className="activity-card-note">
          When the {formatCount(commits)} {commits === 1 ? "commit" : "commits"} landed · local time
        </p>
      </div>
      <div className="activity-cadence-body">
        <div className="activity-multiple">
          <p className="activity-multiple-head">
            <span className="activity-multiple-title">By weekday</span>
            {weekday ? (
              <span className="activity-multiple-peak">
                Peak <strong>{weekday.label}</strong> · {formatCount(weekday.value)} commits
              </span>
            ) : null}
          </p>
          <BarChart
            values={cadence.byWeekday}
            labels={ACTIVITY_WEEKDAYS}
            width={502}
            gap={22}
            showEveryValue
            peak={weekday}
            title="Commits by weekday"
          />
        </div>
        <div className="activity-multiple">
          <p className="activity-multiple-head">
            <span className="activity-multiple-title">By hour of day</span>
            {hour ? (
              <span className="activity-multiple-peak">
                Peak <strong>{hour.label}</strong> · {formatCount(hour.value)} commits
              </span>
            ) : null}
          </p>
          <BarChart
            values={cadence.byHour}
            labels={HOUR_LABELS}
            width={478}
            gap={6}
            showEveryValue={false}
            peak={hour}
            title="Commits by hour of day"
          />
        </div>
      </div>
      {reading ? <p className="activity-cadence-reading">{reading}</p> : null}
    </section>
  );
}
