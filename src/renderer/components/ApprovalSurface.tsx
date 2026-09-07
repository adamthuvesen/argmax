import { Fragment, useState, type JSX } from "react";
import type { ApprovalRequest, TimelineEvent } from "../../shared/types.js";
import { errorMessage } from "../../shared/error.js";
import { approvalAction } from "../lib/approvalAction.js";

type ApprovalResolution = "approved" | "rejected";
type ResolutionState =
  | { phase: "submitting"; resolution: ApprovalResolution }
  | { phase: "submitted"; resolution: ApprovalResolution }
  | { phase: "failed"; message: string };

/** The timeline line Argmax writes for every native request
 *  (approvals/service.rs). It reads as a reason but names none, so the row
 *  drops it and keeps only what a provider or the risk policy actually said. */
const GENERIC_NOTICE = "The provider needs your approval to continue";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function approvalReason(approval: ApprovalRequest, events: TimelineEvent[]): string | null {
  let requestEvent: TimelineEvent | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.type !== "approval.requested") continue;

    const approvalId = stringValue(event.payload.approvalId);
    if (approvalId) {
      if (approvalId !== approval.id) continue;
      requestEvent = event;
      break;
    }

    const providerRequestId = stringValue(event.payload.providerRequestId);
    if (providerRequestId && approval.providerRequestId) {
      if (providerRequestId !== approval.providerRequestId) continue;
      requestEvent = event;
      break;
    }
    if (
      stringValue(event.payload.command) !== approval.command ||
      (stringValue(event.payload.cwd) && stringValue(event.payload.cwd) !== approval.cwd)
    ) {
      continue;
    }

    requestEvent = event;
    break;
  }
  if (!requestEvent) return null;

  const reason = stringValue(requestEvent.payload.reason);
  if (reason) return reason;

  const message = requestEvent.message.trim();
  if (!message || message === approval.command || message === GENERIC_NOTICE) return null;
  return message;
}

/** Empty while the request simply waits: that is what the buttons already say. */
function statusLabel(approval: ApprovalRequest, resolution: ResolutionState | undefined): string {
  if (approval.status === "approved") return "Approved";
  if (approval.status === "rejected") return "Rejected";
  if (approval.status === "cancelled") return "No longer active";
  if (resolution?.phase === "submitting") {
    return resolution.resolution === "approved" ? "Approving…" : "Rejecting…";
  }
  if (resolution?.phase === "submitted") return "Response sent";
  return "";
}

export function ApprovalSurface({
  approvals,
  events,
  onResolveApproval
}: {
  approvals: ApprovalRequest[];
  events: TimelineEvent[];
  onResolveApproval: (approvalId: string, status: ApprovalResolution) => Promise<void>;
}): JSX.Element | null {
  const [resolutionById, setResolutionById] = useState<Record<string, ResolutionState>>({});

  if (approvals.length === 0) return null;

  const resolve = async (approval: ApprovalRequest, resolution: ApprovalResolution): Promise<void> => {
    setResolutionById((current) => ({
      ...current,
      [approval.id]: { phase: "submitting", resolution }
    }));
    try {
      await onResolveApproval(approval.id, resolution);
      setResolutionById((current) => ({
        ...current,
        [approval.id]: { phase: "submitted", resolution }
      }));
    } catch (error) {
      const detail = errorMessage(error);
      setResolutionById((current) => ({
        ...current,
        [approval.id]: {
          phase: "failed",
          message: detail || "The provider did not accept the response. Try again."
        }
      }));
    }
  };

  return (
    <section className="approval-surface" aria-label="Command approvals">
      {approvals.map((approval) => {
        const resolution = resolutionById[approval.id];
        const reason = approvalReason(approval, events);
        const isPending = approval.status === "pending";
        const isSubmitting = resolution?.phase === "submitting";
        const isSubmitted = resolution?.phase === "submitted";
        const canRespond = isPending && !isSubmitting && !isSubmitted;
        const action = approvalAction(approval.command);
        const status = statusLabel(approval, resolution);

        return (
          <article
            className="approval-row"
            data-risk={approval.riskLevel}
            aria-busy={isSubmitting || undefined}
            key={approval.id}
          >
            <div className="approval-details">
              <code className="approval-command">{action.title}</code>
              {action.args.length > 0 ? (
                <dl className="tool-call-args approval-args">
                  {action.args.map((argument) => (
                    <Fragment key={argument.key}>
                      <dt>{argument.key}</dt>
                      <dd title={argument.value}>{argument.value}</dd>
                    </Fragment>
                  ))}
                </dl>
              ) : null}
              {reason ? <p className="approval-reason">{reason}</p> : null}
              {resolution?.phase === "failed" ? (
                <p className="approval-error" role="alert">
                  Could not send your response. {resolution.message}
                </p>
              ) : null}
            </div>

            <div className="approval-actions">
              <span className="approval-status" role="status">
                {status}
              </span>
              {isPending ? (
                <>
                  <button
                    className="approval-reject"
                    disabled={!canRespond}
                    type="button"
                    aria-label={`Reject action: ${action.title}`}
                    onClick={() => void resolve(approval, "rejected")}
                  >
                    {isSubmitting && resolution.resolution === "rejected" ? "Rejecting…" : "Reject"}
                  </button>
                  <button
                    className="approval-approve"
                    disabled={!canRespond}
                    type="button"
                    aria-label={`Approve action: ${action.title}`}
                    onClick={() => void resolve(approval, "approved")}
                  >
                    {isSubmitting && resolution.resolution === "approved" ? "Approving…" : "Approve"}
                  </button>
                </>
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}
