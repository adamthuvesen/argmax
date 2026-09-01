import { Package, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useRef, type JSX } from "react";
import { SKILL_SOURCE_LABELS } from "../lib/composerCommands.js";
import type { SlashAutocompleteState, SlashItem } from "../hooks/useSlashAutocomplete.js";

interface SlashRow {
  key: string;
  icon: LucideIcon;
  label: string;
  hint: string;
  badge: string | null;
}

function slashRow(item: SlashItem): SlashRow {
  if (item.kind === "command") {
    return {
      key: `command:${item.command.name}`,
      icon: item.command.icon,
      label: item.command.label,
      hint: item.command.hint,
      badge: null
    };
  }
  return {
    key: `skill:${item.skill.name}`,
    icon: Package,
    label: item.skill.name,
    hint: item.skill.description,
    badge: SKILL_SOURCE_LABELS[item.skill.source]
  };
}

export function SlashCommandMenu({ state }: { state: SlashAutocompleteState }): JSX.Element | null {
  const selectedOptionRef = useRef<HTMLLIElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  // Read through a ref so the listener below binds once per open, not once
  // per render: `dismiss` closes over the draft and is new every keystroke.
  const dismissRef = useRef(state.dismiss);
  dismissRef.current = state.dismiss;

  useEffect(() => {
    if (!state.popoverOpen) {
      return;
    }
    selectedOptionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [state.popoverOpen, state.selectionIndex]);

  // A press anywhere else — the transcript, the toolbar, the prompt itself —
  // closes the menu and leaves the draft alone. Rows call preventDefault on
  // mousedown but never stop propagation, so this still fires for them; the
  // containment check is what keeps a pick from reading as a dismissal.
  useEffect(() => {
    if (!state.popoverOpen) {
      return undefined;
    }
    const onMouseDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      dismissRef.current();
    };
    document.addEventListener("mousedown", onMouseDown, { capture: true });
    return () => document.removeEventListener("mousedown", onMouseDown, { capture: true });
  }, [state.popoverOpen]);

  if (!state.popoverOpen) {
    return null;
  }
  return (
    <ul
      ref={menuRef}
      className="slash-menu"
      id="slash-menu"
      role="listbox"
      aria-label="Slash commands"
      onWheel={(event) => event.stopPropagation()}
    >
      {state.items.map((item, index) => {
        const row = slashRow(item);
        const selected = index === state.selectionIndex;
        return (
          <Fragment key={row.key}>
            {index === state.skillSectionStart ? (
              <li className="slash-menu-section" role="presentation">
                Skills
              </li>
            ) : null}
            <li
              ref={selected ? selectedOptionRef : undefined}
              role="option"
              aria-selected={selected}
              className={`slash-menu-option${selected ? " is-selected" : ""}`}
              // Hover highlights the row by moving the shared selection index,
              // so pointer and arrow-key navigation light up the same row. Use
              // mouseMove, not mouseEnter: arrow-key navigation scrolls the
              // list, and a scroll that slides a new row under a resting
              // pointer fires mouseEnter — which would snatch selection back
              // from the keyboard. mouseMove only fires on real movement.
              onMouseMove={() => {
                if (!selected) {
                  state.setSelectionIndex(index);
                }
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                state.selectItem(index);
              }}
            >
              <row.icon className="slash-menu-icon" size={14} aria-hidden="true" />
              <span className="slash-menu-label">{row.label}</span>
              <span className="slash-menu-hint">{row.hint}</span>
              {row.badge ? <span className="slash-menu-badge">{row.badge}</span> : null}
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}
