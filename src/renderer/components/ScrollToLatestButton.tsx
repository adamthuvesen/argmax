import { ArrowDown } from "lucide-react";
import type { JSX } from "react";
import { useTranscriptFollow, type TranscriptFollow } from "../hooks/useConversationScroll.js";

/**
 * Subscribes to the follow state on its own, so showing or hiding the button
 * re-renders the button and not the transcript beside it.
 */
export function ScrollToLatestButton({
  follow,
  onClick
}: {
  follow: TranscriptFollow;
  onClick: () => void;
}): JSX.Element | null {
  const { detached, newBelowCount } = useTranscriptFollow(follow);
  if (!detached) return null;
  const label = newBelowCount > 0 ? `Scroll to latest (${newBelowCount} new)` : "Scroll to latest";
  return (
    <button
      type="button"
      className="scroll-to-bottom-fab"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <ArrowDown size={19} strokeWidth={2.2} aria-hidden="true" />
    </button>
  );
}
