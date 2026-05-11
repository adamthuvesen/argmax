import type { JSX, RefObject } from "react";
import type { SlashAutocompleteState } from "../hooks/useSlashAutocomplete.js";

export function SkillPopover({
  state,
  inputRef
}: {
  state: SlashAutocompleteState;
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}): JSX.Element | null {
  if (!state.popoverOpen) {
    return null;
  }
  return (
    <ul className="skill-popover" id="skill-popover" role="listbox" aria-label="Skill suggestions">
      {state.filteredSkills.map((skill, index) => (
        <li
          key={skill.name}
          role="option"
          aria-selected={index === state.selectionIndex}
          className={`skill-option${index === state.selectionIndex ? " is-selected" : ""}`}
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
