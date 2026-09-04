import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../../shared/types.js";
import { DebugTraceTab } from "./DebugTraceTab.js";

describe("DebugTraceTab", () => {
  afterEach(cleanup);

  it("shows canonical diagnostics first and preserves an expandable raw event", () => {
    const source = {
      id: "event-1",
      sessionId: "session-1",
      type: "future.notice",
      message: "Future event",
      payload: { prompt: "large prompt", nested: { exact: true } },
      createdAt: "2026-09-01T10:00:00.000Z"
    } as unknown as TimelineEvent;

    render(<DebugTraceTab events={[source]} rawOutputs={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /future\.notice/i }));

    expect(screen.getByText(/"reason": "unsupported-type"/)).toBeVisible();
    expect(screen.getByText("Raw event")).toBeVisible();
    expect(screen.getByText(/"prompt": "large prompt"/)).not.toBeVisible();

    fireEvent.click(screen.getByText("Raw event"));
    expect(screen.getByText(/"prompt": "large prompt"/)).toBeVisible();
  });

  it("keeps a malformed payload readable in the raw event", () => {
    const source = {
      id: "event-2",
      sessionId: "session-1",
      type: "message.completed",
      message: "Malformed event",
      payload: null,
      createdAt: "2026-09-01T10:00:00.000Z"
    } as unknown as TimelineEvent;

    render(<DebugTraceTab events={[source]} rawOutputs={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /message\.completed/i }));

    expect(screen.getByText(/"reason": "invalid-payload"/)).toBeVisible();
    fireEvent.click(screen.getByText("Raw event"));
    expect(screen.getByText(/"payload": null/)).toBeVisible();
  });
});
