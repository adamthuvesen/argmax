import { Copy } from "lucide-react";
import { type JSX, type ReactNode } from "react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";

type ChatBubbleProps = {
  kind: "user" | "assistant";
  rawMarkdown: string;
  children: ReactNode;
};

export function ChatBubble({ kind, rawMarkdown, children }: ChatBubbleProps): JSX.Element {
  const [copied, copy] = useCopyToClipboard();

  const handleCopy = (): void => {
    void copy(rawMarkdown);
  };

  return (
    <article className={`chat-bubble ${kind}`}>
      {children}
      <button
        type="button"
        className="chat-bubble-copy"
        aria-label="Copy bubble"
        title={copied ? "Copied!" : "Copy markdown"}
        onClick={handleCopy}
      >
        <Copy size={12} />
      </button>
    </article>
  );
}
