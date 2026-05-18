import { ExternalLink } from "lucide-react";
import { useMemo, type JSX } from "react";
import { interpretFileChange } from "../lib/fileChange.js";
import { extractOpenablePath, getToolTypeBucket, isBashLikeTool, type ToolCall } from "../lib/toolCalls.js";
import { FileChangeCard } from "./FileChangeCard.js";

export function ToolCallDetail({
  tool,
  workspaceCwd
}: {
  tool: ToolCall;
  workspaceCwd?: string | null;
}): JSX.Element {
  const changes = useMemo(
    () => interpretFileChange(tool.name, tool.inputFull),
    [tool.name, tool.inputFull]
  );

  if (changes && changes.length > 0) {
    return (
      <div className="tool-call-detail">
        {tool.error ? (
          <div className="tool-call-section">
            <p className="tool-call-section-label">Error</p>
            <pre className="tool-call-code tool-call-code--error">{tool.error}</pre>
          </div>
        ) : null}
        {changes.map((change, index) => (
          <FileChangeCard
            change={change}
            key={`${change.path}-${index}`}
            workspaceCwd={workspaceCwd ?? null}
          />
        ))}
      </div>
    );
  }

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
      {(() => {
        // For Task (sub-agent) tools, drop the `prompt` field — it's a long
        // multi-paragraph instruction that bloats the toggled detail and adds
        // nothing the user can act on. Keep description + subagent_type.
        const isAgent = getToolTypeBucket(tool.name) === "agent";
        const visibleInput = isAgent
          ? Object.fromEntries(Object.entries(tool.inputFull).filter(([k]) => k !== "prompt"))
          : tool.inputFull;
        if (Object.keys(visibleInput).length === 0) return null;
        return (
          <div className="tool-call-section">
            <p className="tool-call-section-label">Input</p>
            <pre className="tool-call-code">{JSON.stringify(visibleInput, null, 2)}</pre>
          </div>
        );
      })()}
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
