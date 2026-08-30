import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import { type JSX, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";

type ChatBubbleProps = {
  kind: "user" | "assistant";
  rawMarkdown: string;
  children: ReactNode;
};

export function ChatBubble({ kind, rawMarkdown, children }: ChatBubbleProps): JSX.Element {
  const [copyFlash, copy] = useCopyToClipboard();

  const handleCopy = (): void => {
    void copy(rawMarkdown);
  };

  return (
    <article className={`chat-bubble ${kind}`}>
      {kind === "user" ? <UserBubbleBody rawMarkdown={rawMarkdown}>{children}</UserBubbleBody> : children}
      <button
        type="button"
        className="chat-bubble-copy"
        aria-label="Copy bubble"
        title={
          copyFlash === "copied" ? "Copied!" : copyFlash === "failed" ? "Couldn't copy" : "Copy markdown"
        }
        onClick={handleCopy}
      >
        <Copy size={12} />
      </button>
    </article>
  );
}

/**
 * A long paste would otherwise grow the bubble to the full height of its
 * content and push the reply off-screen. The body is clipped to a cap in CSS
 * and the overflow opens on demand — an inline toggle rather than an inner
 * scrollport, so the page keeps one scroll axis and the whole prompt is
 * readable in place once asked for. The toggle only appears when the content
 * is actually clipped, so short messages look untouched.
 */
function UserBubbleBody({
  rawMarkdown,
  children
}: {
  rawMarkdown: string;
  children: ReactNode;
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    // While expanded the cap is off, so there is nothing to measure — keep the
    // last collapsed verdict so the "Show less" way back stays on screen.
    if (!body || !content || expanded) return;
    const measure = (): void => setClipped(content.scrollHeight - body.clientHeight > 1);
    measure();
    // Watch the content, not the capped body: the body's box is pinned at the
    // cap, so it never resizes and would never report growth. Anything that
    // reflows the prose after mount — a loaded image, a swapped web font, a
    // narrower pane — changes the content's height and re-runs the check.
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded, rawMarkdown]);

  return (
    <>
      <div
        ref={bodyRef}
        className={`chat-bubble-body${expanded ? " expanded" : clipped ? " clipped" : ""}`}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {clipped ? (
        <button
          type="button"
          className="chat-bubble-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show more"}
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : null}
    </>
  );
}
