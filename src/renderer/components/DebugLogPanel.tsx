import { PanelRightClose } from "lucide-react";
import { useEffect, useMemo, useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import { tryParseJsonObject } from "../../shared/safeJson.js";
import type { RawProviderOutput, TimelineEvent } from "../../shared/types.js";
import { arrayValue, objectValue, stringValue } from "../../shared/typeGuards.js";

export function DebugLogPanel({
  events,
  onResizePanelMouseDown,
  onClose,
  rawOutputs
}: {
  events: TimelineEvent[];
  onResizePanelMouseDown?: (event: ReactMouseEvent) => void;
  onClose: () => void;
  rawOutputs: RawProviderOutput[];
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<"events" | "output">("events");
  return (
    <aside className="log-panel" aria-label="Debug log">
      {onResizePanelMouseDown ? (
        <div className="panel-col-resize-handle" aria-hidden="true" onMouseDown={onResizePanelMouseDown} />
      ) : null}
      <div className="log-toolbar">
        <div>
          <p className="eyebrow">Debug</p>
          <h2>Session log</h2>
        </div>
        <button className="small-icon" type="button" title="Close debug log" aria-label="Close debug log" onClick={onClose}>
          <PanelRightClose size={18} />
        </button>
      </div>
      <div className="log-tab-bar" role="tablist">
        <button role="tab" aria-selected={activeTab === "events"} type="button" onClick={() => setActiveTab("events")}>
          Events
          <span>{events.length}</span>
        </button>
        <button role="tab" aria-selected={activeTab === "output"} type="button" onClick={() => setActiveTab("output")}>
          Raw output
          <span>{rawOutputs.length}</span>
        </button>
      </div>
      <div className="log-body">
        {activeTab === "events" ? <DebugEventList events={events} /> : <DebugOutputList outputs={rawOutputs} />}
      </div>
    </aside>
  );
}

function DebugEventList({ events }: { events: TimelineEvent[] }): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Prune the expanded set whenever the visible events change so ids for
  // pruned/replaced events don't linger forever in panel state.
  useEffect(() => {
    setExpanded((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(events.map((event) => event.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [events]);

  if (events.length === 0) {
    return <p className="log-empty">No events yet.</p>;
  }

  return (
    <div className="log-event-list">
      {events.map((event) => {
        const isExpanded = expanded.has(event.id);
        const hasPayload = Object.keys(event.payload).length > 0;
        const time = new Date(event.createdAt).toLocaleTimeString("en-US", { hour12: false });
        return (
          <div className="log-event-row" data-type={event.type} key={event.id}>
            <div className="log-event-header">
              <span className="log-type-badge">{event.type}</span>
              <span className="log-event-time">{time}</span>
              {hasPayload ? (
                <button
                  className="log-expand-btn"
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(event.id)) {
                        next.delete(event.id);
                      } else {
                        next.add(event.id);
                      }
                      return next;
                    })
                  }
                >
                  {isExpanded ? "▴" : "▾"}
                </button>
              ) : null}
            </div>
            {event.message ? <p className="log-event-message">{event.message}</p> : null}
            {isExpanded ? (
              <pre className="log-event-payload">{JSON.stringify(event.payload, null, 2)}</pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function DebugOutputList({ outputs }: { outputs: RawProviderOutput[] }): JSX.Element {
  const sorted = useMemo(() => [...outputs].reverse(), [outputs]);
  if (outputs.length === 0) {
    return <p className="log-empty">No raw output yet.</p>;
  }
  const copyBlock = (content: string): void => {
    // Swallow rejection: this is a power-user diagnostics panel; a clipboard
    // permission denial doesn't need to surface a toast.
    navigator.clipboard?.writeText(content).catch(() => undefined);
  };
  return (
    <div className="log-output-list">
      {sorted.map((output) => {
        const preview = summarizeRawOutput(output.content);
        return (
          <div className="log-output-row" data-stream={output.stream} key={output.id}>
            <span className="log-stream-badge">{output.stream}</span>
            <pre className="log-output-content">{preview}</pre>
            <button
              type="button"
              className="log-output-copy"
              aria-label="Copy output block"
              onClick={() => copyBlock(output.content)}
            >
              Copy
            </button>
          </div>
        );
      })}
    </div>
  );
}

function summarizeRawOutput(content: string): string {
  const lines = content.split(/\r?\n/);
  const summaries = lines.map((line) => {
    if (!line.trim()) return line;
    return summarizeProviderProtocolLine(line) ?? line;
  });
  return summaries.join("\n");
}

function summarizeProviderProtocolLine(line: string): string | null {
  const record = tryParseJsonObject(line.trim());
  const type = stringValue(record?.type);
  if (!record || !type) return null;

  const subtype = stringValue(record.subtype);
  const content = claudeContentSummary(record);
  const details = [subtype, content].filter(Boolean).join(" - ");
  return details ? `[provider json] ${type} - ${details}` : `[provider json] ${type}`;
}

function claudeContentSummary(record: Record<string, unknown>): string | null {
  const message = objectValue(record.message);
  const blocks = arrayValue(message?.content) ?? arrayValue(record.content);
  if (!blocks) return stringValue(record.message);

  const text = blocks
    .map((block) => stringValue(objectValue(block)?.text))
    .filter((value): value is string => Boolean(value))
    .join("")
    .trim();
  if (text) return truncateSummary(text);

  const toolNames = blocks
    .map((block) => {
      const obj = objectValue(block);
      if (stringValue(obj?.type) !== "tool_use") return null;
      return stringValue(obj?.name) ?? "tool_use";
    })
    .filter((value): value is string => Boolean(value));
  if (toolNames.length > 0) return `tool_use ${toolNames.join(", ")}`;

  if (blocks.some((block) => stringValue(objectValue(block)?.type) === "thinking")) {
    return "thinking block hidden";
  }
  return null;
}

function truncateSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ");
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}
