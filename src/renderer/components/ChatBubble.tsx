import { Copy } from "lucide-react";
import { useMemo, useState, type JSX, type ReactNode } from "react";

const COPY_FLASH_MS = 1500;

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

export function ChatBubble({
  kind,
  createdAt,
  rawMarkdown,
  children
}: {
  kind: "user" | "assistant";
  createdAt: string;
  rawMarkdown: string;
  children: ReactNode;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const label = useMemo(() => formatBubbleTimestamp(createdAt), [createdAt]);

  const handleCopy = (): void => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(rawMarkdown).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FLASH_MS);
    });
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
