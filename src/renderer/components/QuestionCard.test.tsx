import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./QuestionCard.js";

describe("QuestionCard", () => {
  afterEach(() => cleanup());

  it("does not select multi-select answers while moving keyboard focus", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionCard
        questions={[
          {
            question: "Pick priorities",
            header: "Priorities",
            multiSelect: true,
            options: [{ label: "Runbooks" }, { label: "Examples" }]
          }
        ]}
        createdAt="2026-05-17T19:00:00.000Z"
        onAnswer={onAnswer}
      />
    );

    const listbox = screen.getByRole("listbox", { name: "Priorities" });
    const submit = screen.getByRole("button", { name: "Submit answer" });

    fireEvent.keyDown(listbox, { key: "ArrowDown" });

    expect(screen.getByRole("option", { name: /Examples/ })).toHaveAttribute("aria-selected", "false");
    expect(submit).toBeDisabled();

    fireEvent.keyDown(listbox, { key: " " });
    expect(screen.getByRole("option", { name: /Examples/ })).toHaveAttribute("aria-selected", "true");
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    expect(onAnswer).toHaveBeenCalledWith("**Priorities**: Examples");
  });
});
