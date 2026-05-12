import { PanelRightClose } from "lucide-react";
import { useEffect, useMemo, useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import type { RawProviderOutput, TimelineEvent } from "../../shared/types.js";

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
    void navigator.clipboard?.writeText(content);
  };
  return (
    <div className="log-output-list">
      {sorted.map((output) => (
        <div className="log-output-row" data-stream={output.stream} key={output.id}>
          <span className="log-stream-badge">{output.stream}</span>
          <pre className="log-output-content">{output.content}</pre>
          <button
            type="button"
            className="log-output-copy"
            aria-label="Copy output block"
            onClick={() => copyBlock(output.content)}
          >
            Copy
          </button>
        </div>
      ))}
    </div>
  );
}
