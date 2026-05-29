import type { JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceSummary } from "../../shared/types.js";
import { matchFileChip } from "../lib/fileChipPath.js";
import { CodeBlock } from "./CodeBlock.js";
import { FileChip, type FileChipOpenOptions } from "./FileChip.js";

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
