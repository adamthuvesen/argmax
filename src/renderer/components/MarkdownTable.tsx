import type { JSX, ReactNode } from "react";

/**
 * A markdown table, boxed in its own sideways scroller.
 *
 * A table is sized by its content, so `width: 100%` is a floor and not a cap:
 * a wide one keeps growing past the column it sits in, and the surrounding
 * scroller — the transcript, the file preview — is what ends up scrolling
 * sideways, dragging every other message with it. The wrapper is a block box,
 * so it can never exceed the column, and the overflow scrolls inside the table
 * instead. Styling lives on `.markdown-table-scroll` in `chat-conversation.css`.
 */
export function MarkdownTable({ children }: { children?: ReactNode }): JSX.Element {
  return (
    <div className="markdown-table-scroll">
      <table>{children}</table>
    </div>
  );
}
