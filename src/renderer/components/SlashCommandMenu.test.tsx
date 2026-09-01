import { fireEvent, render, screen, within } from "@testing-library/react";
import { ListChecks } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlashAutocompleteState } from "../hooks/useSlashAutocomplete.js";
import { SlashCommandMenu } from "./SlashCommandMenu.js";

function makeState(selectionIndex: number, commandCount = 1): SlashAutocompleteState {
  const commands = Array.from({ length: commandCount }, (_, index) => ({
    kind: "command" as const,
    command: {
      name: `command-${index}`,
      label: `Command ${index}`,
      hint: `Runs command ${index}`,
      icon: ListChecks,
      run: vi.fn()
    }
  }));
  const skills = Array.from({ length: 20 }, (_, index) => ({
    kind: "skill" as const,
    skill: { name: `skill-${index}`, description: `Skill ${index}`, source: "user" as const }
  }));
  return {
    popoverOpen: true,
    items: [...commands, ...skills],
    skillSectionStart: commands.length,
    skillNames: new Set(skills.map((item) => item.skill.name)),
    selectionIndex,
    setSelectionIndex: vi.fn(),
    selectItem: vi.fn(),
    dismiss: vi.fn(),
    onKeyDown: vi.fn()
  };
}

describe("SlashCommandMenu", () => {
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

  it("keeps the selected row scrolled into view for keyboard navigation", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = render(<SlashCommandMenu state={makeState(0)} />);

    rerender(<SlashCommandMenu state={makeState(14)} />);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("skill-13");
  });

  it("lists composer commands above a Skills heading, with each skill's source", () => {
    render(<SlashCommandMenu state={makeState(0, 2)} />);

    const menu = screen.getByRole("listbox", { name: "Slash commands" });
    const options = within(menu).getAllByRole("option");
    expect(options[0]).toHaveTextContent("Command 0Runs command 0");
    expect(options[2]).toHaveTextContent("skill-0Skill 0User");
    expect(within(menu).getByText("Skills")).toBeInTheDocument();
  });

  it("highlights a row on hover by moving the shared selection index", () => {
    const state = makeState(0);
    render(<SlashCommandMenu state={state} />);

    fireEvent.mouseMove(screen.getByText("skill-3"));

    expect(state.setSelectionIndex).toHaveBeenCalledWith(4);
  });

  it("does not re-set the index when hovering the already-selected row", () => {
    const state = makeState(0);
    render(<SlashCommandMenu state={state} />);

    fireEvent.mouseMove(screen.getByText("Command 0"));

    expect(state.setSelectionIndex).not.toHaveBeenCalled();
  });

  it("selects the row the pointer pressed", () => {
    const state = makeState(0);
    render(<SlashCommandMenu state={state} />);

    fireEvent.mouseDown(screen.getByText("skill-2"));

    expect(state.selectItem).toHaveBeenCalledWith(3);
  });

  it("dismisses when a press lands outside the menu, but not on a row", () => {
    const state = makeState(0);
    render(
      <div>
        <button type="button">elsewhere</button>
        <SlashCommandMenu state={state} />
      </div>
    );

    fireEvent.mouseDown(screen.getByText("skill-2"));
    expect(state.dismiss).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }));
    expect(state.dismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps wheel scrolling inside the menu instead of bubbling to the page", () => {
    const parentWheel = vi.fn();
    render(
      <div onWheel={parentWheel}>
        <SlashCommandMenu state={makeState(0)} />
      </div>
    );

    fireEvent.wheel(screen.getByRole("listbox", { name: "Slash commands" }));

    expect(parentWheel).not.toHaveBeenCalled();
  });
});
