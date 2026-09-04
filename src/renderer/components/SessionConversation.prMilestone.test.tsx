import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { baseSession, event, project, reviewStub, workspace } from "../../test/sessionConversationTestHarness.js";
import { PrMilestoneCelebrationContext } from "../lib/uiPreferences.js";
import { SessionConversation } from "./SessionConversation.js";

vi.mock("./TurnExhale.js", () => ({
  TurnExhale: ({ onDone }: { onDone: () => void }) => <button onClick={onDone}>Finish PR sweep</button>
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("PR milestones without an assistant turn", () => {
  it.each([false, true])("plays immediately with pending user message = %s and never replays on assistant output", (hasMessage) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-05T10:00:00Z"));
    const props: ComponentProps<typeof SessionConversation> = {
      events: hasMessage ? [event("user", "user.message", "Work on this", "2026-09-05T10:00:00Z")] : [],
      project, workspace, session: baseSession(), review: reviewStub(), rawOutputs: [],
      isLogOpen: false, workspaceCardEnabled: false,
      onSendSessionInput: vi.fn(), onTerminateSession: vi.fn(), onClearSession: vi.fn(), onToggleLog: vi.fn()
    };
    const view = (next: typeof props) => <PrMilestoneCelebrationContext value><SessionConversation {...next} /></PrMilestoneCelebrationContext>;
    const { rerender } = render(view(props));
    expect(screen.queryByRole("button", { name: "Finish PR sweep" })).toBeNull();
    now.mockReturnValue(Date.parse("2026-09-05T10:00:05Z"));
    const confirmed = { ...props, workspace: { ...workspace, prNumber: 42, prState: "OPEN" as const, prCreatedAt: "2026-09-05T10:00:05Z" } };
    rerender(view(confirmed));
    fireEvent.click(screen.getByRole("button", { name: "Finish PR sweep" }));
    rerender(view({ ...confirmed, events: [...props.events, event("answer", "message.completed", "Done", "2026-09-05T10:00:06Z", { text: "Done", role: "assistant" })] }));
    expect(screen.queryByRole("button", { name: "Finish PR sweep" })).toBeNull();
  });
});
