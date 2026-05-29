import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan } from "../lib/parsePlan.js";
import { PlanCard } from "./PlanCard.js";

function samplePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    title: "Plan: Refactor onboarding",
    summary: ["Tighten the onboarding flow and remove the duplicate consent step."],
    sections: [
      {
        label: "Key Changes",
        items: [
          {
            title: "Restructure `App.tsx`",
            children: [{ title: "extract `<OnboardingRoot>`" }]
          },
          { title: "Add `docs/onboarding.md`" }
        ]
      }
    ],
    action: {
      question: "Implement this plan?",
      options: [
        { label: "Yes, implement this plan" },
        { label: "No, and tell Claude what to do differently" }
      ]
    },
    ...overrides
  };
}

describe("PlanCard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-05-16T14:30:00.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("renders the title, summary, sections, and an inline code chip", () => {
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        modelLabel="Claude Opus 4.8"
        onAccept={() => {}}
        onReject={() => {}}
      />
    );
    expect(screen.getByRole("article", { name: /Plan: Refactor onboarding/ })).toBeInTheDocument();
    expect(screen.getByText(/Tighten the onboarding flow/)).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("Key Changes")).toBeInTheDocument();
    expect(screen.getByText("Claude Opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("App.tsx").className).toContain("plan-card-chip");
  });

  it("starts with the first option selected", () => {
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={() => {}}
        onReject={() => {}}
      />
    );
    const listbox = screen.getByRole("listbox", { name: "Plan response" });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    expect(listbox).toBeInTheDocument();
  });

  it("moves selection with the 2 key and submits onReject on Enter", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={onAccept}
        onReject={onReject}
      />
    );
    const listbox = screen.getByRole("listbox", { name: "Plan response" });
    fireEvent.keyDown(listbox, { key: "2" });
    const options = screen.getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("selects option 1 with the 1 key and submits onAccept on Enter", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={onAccept}
        onReject={onReject}
      />
    );
    const listbox = screen.getByRole("listbox", { name: "Plan response" });
    fireEvent.keyDown(listbox, { key: "2" });
    fireEvent.keyDown(listbox, { key: "1" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("wraps selection with ArrowDown past the end", () => {
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={() => {}}
        onReject={() => {}}
      />
    );
    const listbox = screen.getByRole("listbox", { name: "Plan response" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });

  it("Escape is a no-op (cards are not dismissable — the answer is the dismiss)", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={onAccept}
        onReject={onReject}
      />
    );
    const listbox = screen.getByRole("listbox", { name: "Plan response" });
    fireEvent.keyDown(listbox, { key: "Escape" });
    expect(screen.getByRole("listbox", { name: "Plan response" })).toBeInTheDocument();
    expect(onAccept).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it("collapses to a summary header after submit and re-expands via the chevron", () => {
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={() => {}}
        onReject={() => {}}
      />
    );
    const listbox = screen.getByRole("listbox", { name: "Plan response" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(screen.queryByRole("listbox", { name: "Plan response" })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand plan" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));
    expect(screen.getByRole("listbox", { name: "Plan response" })).toBeInTheDocument();
  });

  it("does not submit again after collapse and re-expand", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={onAccept}
        onReject={onReject}
      />
    );

    fireEvent.keyDown(screen.getByRole("listbox", { name: "Plan response" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Plan response" }), { key: "Enter" });
    const [firstOption] = screen.getAllByRole("option");
    if (!firstOption) throw new Error("expected option to be in document");
    fireEvent.click(firstOption);

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("invokes onAccept when option 1 is clicked", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={onAccept}
        onReject={onReject}
      />
    );
    const [firstOption] = screen.getAllByRole("option");
    if (!firstOption) throw new Error("expected option to be in document");
    fireEvent.click(firstOption);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("auto-focuses the listbox on mount so Enter submits without tabbing in", () => {
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={() => {}}
        onReject={() => {}}
      />
    );
    const listbox = screen.getByRole("listbox", { name: "Plan response" });
    expect(document.activeElement).toBe(listbox);
  });

  it("does not steal focus from a textarea that the user is typing in", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={() => {}}
        onReject={() => {}}
      />
    );
    expect(document.activeElement).toBe(textarea);
    textarea.remove();
  });

  it("fires onAccept when Enter is pressed immediately after the card renders", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown="raw"
        onAccept={onAccept}
        onReject={onReject}
      />
    );
    // No prior key events — the listbox is auto-focused so Enter should fire
    // submit on the default-selected first option.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter" });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("copies the raw markdown when the copy button is clicked", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockImplementation(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(
      <PlanCard
        plan={samplePlan()}
        createdAt="2026-05-16T14:30:00.000Z"
        rawMarkdown={"# Plan\n\nbody"}
        onAccept={() => {}}
        onReject={() => {}}
      />
    );
    const button = screen.getByRole("button", { name: "Copy plan" });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith("# Plan\n\nbody");
    await act(async () => {
      await Promise.resolve();
    });
    expect(button).toHaveAttribute("title", "Copied!");
  });
});
