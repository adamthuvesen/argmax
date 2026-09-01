import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailsPopup } from "./DetailsPopup.js";
import { baseSession, event, workspace } from "../../test/sessionConversationTestHarness.js";
import type { ArgmaxApi, TimelineEvent } from "../../shared/types.js";

const popupWorkspace = {
  ...workspace,
  kind: "popup" as const,
  sharedWorkspace: true
};

const EVENTS: TimelineEvent[] = [
  // Newest first, matching mergeDashboardDelta's descending order.
  event("m4", "user.message", "Follow-up: what about clock skew?", "2026-05-12T15:00:03.000Z"),
  {
    ...event("m3", "message.completed", "Unrelated pane message.", "2026-05-12T15:00:02.000Z"),
    sessionId: "session-other"
  },
  event("m2", "message.completed", "A vector clock orders events without a shared clock.", "2026-05-12T15:00:01.000Z"),
  event("m1", "user.message", "Explain this excerpt in more detail: vector clocks", "2026-05-12T15:00:00.000Z")
];

// The popup's own prop types, not `ReturnType<typeof vi.fn>`: Vitest 4 types
// a bare `vi.fn()` as `Mock<Procedure | Constructable>`, which no longer
// widens to a call signature, so a loose override type poisons the prop.
type DetailsPopupProps = Parameters<typeof DetailsPopup>[0];

function renderPopup(overrides: {
  onClose?: DetailsPopupProps["onClose"];
  onLoadSessionEvents?: DetailsPopupProps["onLoadSessionEvents"];
} = {}) {
  return render(
    <DetailsPopup
      events={EVENTS}
      onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
      onClose={overrides.onClose ?? vi.fn(() => {})}
      onLoadSessionEvents={overrides.onLoadSessionEvents ?? vi.fn(() => Promise.resolve())}
      onSendQueuedMessageNow={vi.fn().mockResolvedValue(undefined)}
      onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
      onTerminateSession={vi.fn().mockResolvedValue(undefined)}
      onClearSession={vi.fn().mockResolvedValue(undefined)}
      project={null}
      rawOutputs={[]}
      session={baseSession()}
      workspace={popupWorkspace}
    />
  );
}

describe("DetailsPopup", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.argmax = {
      prs: { listForSession: vi.fn(() => new Promise(() => {})) }
    } as unknown as ArgmaxApi;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders its own session's transcript under the More details heading", () => {
    renderPopup();

    expect(screen.getByRole("dialog", { name: "More details" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "More details" })).toBeInTheDocument();
    expect(
      screen.getByText("A vector clock orders events without a shared clock.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Unrelated pane message.")).toBeNull();
    // Floating composer: no attach or workspace-context cluster — the popup
    // is too narrow for them at its minimum width.
    expect(screen.queryByRole("button", { name: "Attach file" })).toBeNull();
  });

  it("hides the seed prompt but keeps typed follow-ups", () => {
    renderPopup();

    // The seed restates the excerpt the user just selected; the panel belongs
    // to the answer. Later user messages are real follow-ups and stay. The
    // session prompt must not resurface either — foldConversation synthesizes
    // a user bubble from it once the seed event is filtered away.
    expect(screen.queryByText(/Explain this excerpt in more detail/)).toBeNull();
    expect(screen.queryByText("Build dashboard")).toBeNull();
    expect(screen.getByText("Follow-up: what about clock skew?")).toBeInTheDocument();
  });

  it("backfills the transcript once for its session", async () => {
    const onLoadSessionEvents = vi.fn().mockResolvedValue(undefined);
    renderPopup({ onLoadSessionEvents });

    await waitFor(() => expect(onLoadSessionEvents).toHaveBeenCalledWith("session-a"));
  });

  it("closes from the header close button", () => {
    const onClose = vi.fn();
    renderPopup({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "Close popup" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
