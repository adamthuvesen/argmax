import { ExternalLink } from "lucide-react";
import type { JSX } from "react";
import { extractOpenablePath, isBashLikeTool, type ToolCall } from "../lib/toolCalls.js";

export function ToolCallDetail({
  tool,
  workspaceCwd
}: {
  tool: ToolCall;
  workspaceCwd?: string | null;
}): JSX.Element {
  return (
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
              <button
                className="tool-call-open-button"
                type="button"
                onClick={onOpen}
                aria-label={`Open ${openable}`}
              >
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
  );
}
