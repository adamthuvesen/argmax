import { type JSX } from "react";
import {
  logBlockLabel,
  parseLogDump,
  type LogLevel,
  type LogRecord
} from "../lib/logDump.js";

function recordTone(level: LogLevel | null, fallbackError: boolean): "error" | "warn" | "info" {
  switch (level) {
    case "ERROR":
      return "error";
    case "WARN":
    case "WARNING":
      return "warn";
    case "INFO":
    case "DEBUG":
    case "TRACE":
      return "info";
    case null:
      return fallbackError ? "error" : "info";
    default: {
      const _never: never = level;
      return _never;
    }
  }
}

function blockTone(
  label: string
): "error" | "warn" | "log" {
  switch (label) {
    case "Error":
      return "error";
    case "Warning":
      return "warn";
    default:
      return "log";
  }
}

function LogRecordView({
  record,
  fallbackError
}: {
  record: LogRecord;
  fallbackError: boolean;
}): JSX.Element {
  const tone = recordTone(record.level, fallbackError);
  const hasHead = record.timestamp !== null || record.level !== null || record.target !== null;
  return (
    <li className="log-record" data-level={tone}>
      {hasHead ? (
        <p className="log-record-head">
          {record.timestamp ? <time dateTime={record.timestamp}>{record.timestamp}</time> : null}
          {record.level ? <span className="log-record-level">{record.level}</span> : null}
          {record.target ? <span className="log-record-target">{record.target}</span> : null}
        </p>
      ) : null}
      <pre className="log-record-message">{record.message}</pre>
    </li>
  );
}

export function LogBlock({
  text,
  tone = "auto"
}: {
  text: string;
  tone?: "auto" | "error";
}): JSX.Element | null {
  const records = parseLogDump(text);
  if (records.length === 0) return null;
  const label = logBlockLabel(records, tone);
  return (
    <section className="log-block" data-tone={blockTone(label)} aria-label={label} role="status">
      <p className="log-block-label">{label}</p>
      <ol className="log-block-records">
        {records.map((record, index) => (
          <LogRecordView
            key={`${record.timestamp ?? "line"}-${index}`}
            record={record}
            fallbackError={tone === "error"}
          />
        ))}
      </ol>
    </section>
  );
}
