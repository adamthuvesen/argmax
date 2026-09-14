import { ChevronUp } from "lucide-react";

/**
 * Reveals the head of a long list the render window leaves unmounted.
 *
 * Every transcript window uses this one control — earlier messages, earlier
 * activity in a turn, earlier tool calls in a group, earlier child activity
 * under an agent — so the four places a list can be paged all read the same.
 * It is shaped like the rows it sits among rather than like a button: the
 * chevron occupies the same mark gutter, and the label starts where a row's
 * verb starts.
 */
export function ShowEarlier({
  noun,
  count,
  onClick
}: {
  /** What is hidden, as it reads after "Show earlier": "activity", "messages". */
  noun: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button type="button" className="conversation-show-earlier" onClick={onClick}>
      <span className="activity-icon-slot" aria-hidden="true">
        <ChevronUp />
      </span>
      <span>
        Show earlier {noun} <span className="conversation-show-earlier-count">({count})</span>
      </span>
    </button>
  );
}
