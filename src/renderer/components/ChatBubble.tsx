import { Copy } from "lucide-react";
import { memo, useMemo, type JSX, type ReactNode } from "react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";

function formatBubbleTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

type ChatBubbleProps = {
  kind: "user" | "assistant";
  createdAt: string;
  rawMarkdown: string;
  children: ReactNode;
};

function ChatBubbleInner({
  kind,
  createdAt,
  rawMarkdown,
  children
}: ChatBubbleProps): JSX.Element {
  const [copied, copy] = useCopyToClipboard();
  const label = useMemo(() => formatBubbleTimestamp(createdAt), [createdAt]);

  const handleCopy = (): void => {
    void copy(rawMarkdown);
  };

  return (
    <article className={`chat-bubble ${kind}`} data-time={label || undefined}>
      {children}
      <div className="chat-bubble-meta">
        {label ? (
          <span
            className="chat-bubble-timestamp"
            title={new Date(createdAt).toISOString()}
          >
            {label}
          </span>
        ) : null}
        <button
          type="button"
          className="chat-bubble-copy"
          aria-label="Copy bubble"
          title={copied ? "Copied!" : "Copy markdown"}
          onClick={handleCopy}
        >
          <Copy size={12} />
        </button>
      </div>
    </article>
  );
}

// Memoize on kind + createdAt + rawMarkdown only (ralph C2). `children` is
// intentionally excluded from the comparator: SessionConversation derives
// children from the same rawMarkdown string, so when rawMarkdown is equal
// the rendered children are equivalent for our purposes. A token tick that
// updates only the active assistant bubble's text will re-render that one
// bubble; all prior bubbles in the conversation skip the re-render.
export const ChatBubble = memo(ChatBubbleInner, (prev, next) => {
  return (
    prev.kind === next.kind &&
    prev.createdAt === next.createdAt &&
    prev.rawMarkdown === next.rawMarkdown
  );
});
