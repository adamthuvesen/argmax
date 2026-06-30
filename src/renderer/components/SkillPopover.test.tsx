import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlashAutocompleteState } from "../hooks/useSlashAutocomplete.js";
import { SkillPopover } from "./SkillPopover.js";

function makeState(selectionIndex: number): SlashAutocompleteState {
  return {
    popoverOpen: true,
    filteredSkills: Array.from({ length: 20 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Skill ${index}`,
      source: "user" as const
    })),
    skillNames: new Set(Array.from({ length: 20 }, (_, index) => `skill-${index}`)),
    selectionIndex,
    setSelectionIndex: vi.fn(),
    selectSkill: vi.fn(),
    onKeyDown: vi.fn()
  };
}

describe("SkillPopover", () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- captured purely to restore after the test; never invoked unbound.
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  afterEach(() => {
    if (originalScrollIntoView) {
      Element.prototype.scrollIntoView = originalScrollIntoView;
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
    vi.restoreAllMocks();
  });

  it("keeps the selected skill scrolled into view for keyboard navigation", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const inputRef = createRef<HTMLTextAreaElement>();
    const { rerender } = render(<SkillPopover state={makeState(0)} inputRef={inputRef} />);

    rerender(<SkillPopover state={makeState(14)} inputRef={inputRef} />);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("/skill-14");
  });

  it("keeps wheel scrolling inside the popover instead of bubbling to the page", () => {
    const parentWheel = vi.fn();
    const inputRef = createRef<HTMLTextAreaElement>();
    render(
      <div onWheel={parentWheel}>
        <SkillPopover state={makeState(0)} inputRef={inputRef} />
      </div>
    );

    fireEvent.wheel(screen.getByRole("listbox", { name: "Skill suggestions" }));

    expect(parentWheel).not.toHaveBeenCalled();
  });
});
