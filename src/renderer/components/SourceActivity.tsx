import { BookOpen, ChevronRight, Plus } from "lucide-react";
import type { JSX } from "react";
import type { ProjectSourceActivity } from "../lib/canonicalTimeline.js";
import { WebLink } from "./WebLink.js";

export function SourceActivity({ activity }: { activity: ProjectSourceActivity }): JSX.Element {
  const isRead = activity.action === "read";
  const Icon = isRead ? BookOpen : Plus;
  const label = `${isRead ? "Read" : "Added"} project source: ${activity.title}`;
  const location = activity.readLocation ?? activity.location;
  const isWebLink = /^https?:\/\//i.test(location);
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">{label}</span>
      <details className="project-source-activity">
        <summary aria-label={label}>
          <ChevronRight className="project-source-chevron" size={12} aria-hidden="true" />
          <Icon size={14} aria-hidden="true" />
          <span>{isRead ? "Read source" : "Added source"}</span>
          <strong>{activity.title}</strong>
          {activity.truncated ? <span>Partial</span> : null}
        </summary>
        <div className="project-source-activity-details">
          <p>{isWebLink ? <WebLink href={location}>{location}</WebLink> : <code>{location}</code>}</p>
          <p>{activity.guidance}</p>
          <p>
            {isRead ? "Retrieved" : "Added by agent"} <time dateTime={activity.at}>{activity.at.slice(0, 10)}</time>.
            {isRead ? " Retrieval does not verify the source’s claims." : " Listed for future reference, not read or verified."}
          </p>
          {activity.truncated ? <p>Only part of the content was returned to the agent.</p> : null}
        </div>
      </details>
    </>
  );
}
