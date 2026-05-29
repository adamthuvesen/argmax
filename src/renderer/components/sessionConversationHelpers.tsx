import type { JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentMode, TimelineEvent, WorkspaceSummary } from "../../shared/types.js";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import { matchFileChip } from "../lib/fileChipPath.js";
import { CodeBlock } from "./CodeBlock.js";
import { FileChip, type FileChipOpenOptions } from "./FileChip.js";

/**
 * Terminate a running probe (if needed) then send follow-up input. Surfaces
 * errors via `onError` and resolves to `false` on failure so optimistic callers
 * (Plan/Question cards) can roll back their "submitted" state.
 */
export async function sendAfterTerminate(
  sessionId: string,
  isRunning: boolean,
  onTerminateSession: (id: string) => Promise<void>,
  send: () => Promise<void>,
  onError: (message: string) => void
): Promise<boolean> {
  if (isRunning) {
    try {
      await onTerminateSession(sessionId);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not terminate session.");
      return false;
    }
  }
  try {
    await send();
    return true;
  } catch (error) {
    onError(error instanceof Error ? error.message : "Could not send input.");
    return false;
  }
}

export function isPayloadTruncationMarker(event: TimelineEvent): boolean {
  return event.type === "error" && event.message === "event payload truncated" && "truncatedEventId" in event.payload;
}

export function isSubAgentProseEcho(event: TimelineEvent): boolean {
  if (event.type !== "message.delta" && event.type !== "message.completed") return false;
  const parentToolUseId = event.payload.parent_tool_use_id;
  return typeof parentToolUseId === "string" && parentToolUseId.length > 0;
}

export function StreamingMarkdown({
  text,
  streaming,
  workspace,
  onOpenFile
}: {
  text: string;
  streaming: boolean;
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
}): JSX.Element {
  return (
    <div className={`markdown${streaming ? " markdown-streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children, ...rest }) => {
            const hasLanguage = typeof className === "string" && className.includes("language-");
            const codeText = Array.isArray(children)
              ? children.map((c) => (typeof c === "string" ? c : "")).join("")
              : typeof children === "string"
                ? children
                : "";
            if (hasLanguage || codeText.includes("\n")) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            const match = matchFileChip(codeText);
            if (match) {
              return (
                <FileChip
                  path={match.path}
                  line={match.line}
                  workspaceId={workspace?.id ?? null}
                  workspaceCwd={workspace?.path ?? null}
                  onOpen={onOpenFile}
                />
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          a: ({ href, children, ...rest }) => {
            if (!href || href.startsWith("#")) {
              return (
                <a href={href} {...rest}>
                  {children}
                </a>
              );
            }
            if (/^(?:https?:|mailto:)/.test(href)) {
              return (
                <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                  {children}
                </a>
              );
            }
            const match = matchFileChip(href);
            if (!match) {
              return (
                <a href={href} {...rest}>
                  {children}
                </a>
              );
            }
            return (
              <FileChip
                path={match.path}
                line={match.line}
                workspaceId={workspace?.id ?? null}
                workspaceCwd={workspace?.path ?? null}
                onOpen={onOpenFile}
              />
            );
          },
          pre: ({ children }) => <>{children}</>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export type SessionConversationSendInput = (
  sessionId: string,
  input: string,
  model: ProviderModelSelection,
  agentMode: AgentMode
) => Promise<void>;
