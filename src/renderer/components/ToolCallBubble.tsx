import { Check, ChevronRight, ExternalLink, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { formatElapsed } from "../formatElapsed.js";
import {
  extractOpenablePath,
  getToolIcon,
  getToolTypeBucket,
  isBashLikeTool,
  type ParallelPosition,
  type ToolCall
} from "../lib/toolCalls.js";

export function ToolCallBubble({
  tool,
  now,
  fresh,
  parallelPosition,
  parallelGroupId,
  nested,
  defaultExpanded,
  workspaceCwd
}: {
  tool: ToolCall;
  now: number;
  fresh: boolean;
  parallelPosition?: ParallelPosition;
  parallelGroupId?: string;
  nested?: boolean;
  defaultExpanded?: boolean;
  workspaceCwd?: string | null;
}): JSX.Element {
  // Standalone errors expand themselves so the message is visible without a
  // click. When nested in a group the group is the entry point — let the user
  // open individual error rows on demand so a bursty turn doesn't unfold into
  // a wall of stack traces.
  const shouldAutoExpandOnError = !nested;
  const [expanded, setExpanded] = useState<boolean>(
    (shouldAutoExpandOnError && tool.status === "error") || (defaultExpanded ?? false)
  );
  const autoExpandedOnErrorRef = useRef<boolean>(shouldAutoExpandOnError && tool.status === "error");
  const [didFlash, setDidFlash] = useState<boolean>(false);

  useEffect(() => {
    if (!shouldAutoExpandOnError) return;
    if (tool.status === "error" && !autoExpandedOnErrorRef.current) {
      autoExpandedOnErrorRef.current = true;
      setExpanded(true);
    }
  }, [tool.status, shouldAutoExpandOnError]);

  const startedMs = Date.parse(tool.createdAt);
  const endedMs = tool.completedAt ? Date.parse(tool.completedAt) : now;
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, endedMs - startedMs) : 0;
  const elapsedText = formatElapsed(elapsedMs);
  const statusWord = tool.status === "running" ? "running" : tool.status === "error" ? "failed" : "done";
  const chipLabel = elapsedText ? `${statusWord}, ${elapsedText}` : statusWord;

  const showFlash = fresh && !didFlash;
  const rootClass = [
    "tool-call-item",
    `tool-call-${tool.status}`,
    nested ? "tool-call-item--nested" : null
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rootClass}
      data-status={tool.status}
      data-tool-type={getToolTypeBucket(tool.name)}
      {...(parallelPosition ? { "data-parallel-position": parallelPosition } : {})}
      {...(parallelGroupId ? { "data-parallel-group": parallelGroupId } : {})}
    >
      {showFlash ? (
        <span
          className="tool-call-flash"
          aria-hidden="true"
          onAnimationEnd={() => setDidFlash(true)}
        />
      ) : null}
      <button
        className="tool-call-header"
        type="button"
        aria-expanded={expanded}
        aria-label={`${tool.name}${tool.inputPreview ? ": " + tool.inputPreview : ""}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="tool-call-icon" aria-hidden="true">{getToolIcon(tool.name)}</span>
        <span className="tool-call-name">{tool.name}</span>
        {tool.inputPreview ? <code className="tool-call-preview">{tool.inputPreview}</code> : null}
        <span className="tool-call-status-chip" aria-label={chipLabel} title={chipLabel}>
          <span className="tool-call-status-glyph" aria-hidden="true">
            {tool.status === "running" ? (
              <Loader2 size={11} className="tool-call-spinner" />
            ) : tool.status === "error" ? (
              <X size={11} />
            ) : (
              <Check size={11} />
            )}
          </span>
          {elapsedText ? (
            <span className="tool-call-status-time" aria-hidden="true">
              {tool.status === "error" && elapsedMs < 100 ? "failed" : elapsedText}
            </span>
          ) : null}
        </span>
        <ChevronRight size={11} className={`tool-call-chevron${expanded ? " expanded" : ""}`} />
      </button>
      {expanded ? (
        <div className="tool-call-detail">
          {tool.error ? (
            <div className="tool-call-section">
              <p className="tool-call-section-label">Error</p>
              <pre className="tool-call-code tool-call-code--error">{tool.error}</pre>
            </div>
          ) : null}
          {tool.status !== "error"
            ? (() => {
                const openable = extractOpenablePath(tool.name, tool.inputFull);
                if (!openable) return null;
                const onOpen = (): void => {
                  if (!window.argmax) return;
                  void window.argmax.system
                    .openPath({ path: openable, ...(workspaceCwd ? { cwd: workspaceCwd } : {}) })
                    .catch(() => undefined);
                };
                return (
                  <button className="tool-call-open-button" type="button" onClick={onOpen} aria-label={`Open ${openable}`}>
                    <ExternalLink size={11} aria-hidden="true" />
                    <span>Open {openable}</span>
                  </button>
                );
              })()
            : null}
          {Object.keys(tool.inputFull).length > 0 ? (
            <div className="tool-call-section">
              <p className="tool-call-section-label">Input</p>
              <pre className="tool-call-code">{JSON.stringify(tool.inputFull, null, 2)}</pre>
            </div>
          ) : null}
          {tool.output && !tool.error ? (
            <div className="tool-call-section">
              <p className="tool-call-section-label">
                Output
                {tool.output.length > 3000 ? (
                  <span className="tool-call-section-meta">
                    {" "}— showing first 3,000 of {tool.output.length.toLocaleString()} chars
                  </span>
                ) : null}
              </p>
              <pre
                className={`tool-call-code${isBashLikeTool(tool.name) ? " tool-call-code--terminal" : ""}`}
              >
                {tool.output.length > 3000 ? `${tool.output.slice(0, 3000)}\n…` : tool.output}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
