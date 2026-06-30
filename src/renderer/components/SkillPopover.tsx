import { useEffect, useRef, type JSX, type RefObject } from "react";
import type { SlashAutocompleteState } from "../hooks/useSlashAutocomplete.js";

export function SkillPopover({
  state,
  inputRef
}: {
  state: SlashAutocompleteState;
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}): JSX.Element | null {
  const selectedOptionRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (!state.popoverOpen) {
      return;
    }
    selectedOptionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [state.popoverOpen, state.selectionIndex]);

  if (!state.popoverOpen) {
    return null;
  }
  return (
    <ul
      className="skill-popover"
      id="skill-popover"
      role="listbox"
      aria-label="Skill suggestions"
      onWheel={(event) => event.stopPropagation()}
    >
      {state.filteredSkills.map((skill, index) => (
        <li
          key={skill.name}
          ref={index === state.selectionIndex ? selectedOptionRef : undefined}
          role="option"
          aria-selected={index === state.selectionIndex}
          className={`skill-option${index === state.selectionIndex ? " is-selected" : ""}`}
          // Hover highlights the row by moving the shared selection index, so
          // pointer and arrow-key navigation light up the same row. Use
          // mouseMove, not mouseEnter: arrow-key navigation scrolls the list,
          // and a scroll that slides a new row under a resting pointer fires
          // mouseEnter — which would snatch selection back from the keyboard.
          // mouseMove only fires on real pointer movement.
          onMouseMove={() => {
            if (index !== state.selectionIndex) {
              state.setSelectionIndex(index);
            }
          }}
          onMouseDown={(event) => {
            event.preventDefault();
            state.setSelectionIndex(index);
            state.selectSkill(skill.name);
            inputRef.current?.focus();
          }}
        >
          <span className="skill-option-name">/{skill.name}</span>
          {skill.description ? <span className="skill-option-description">{skill.description}</span> : null}
        </li>
      ))}
    </ul>
  );
}
