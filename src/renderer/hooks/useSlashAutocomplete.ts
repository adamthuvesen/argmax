import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { ProviderId, SkillSummary } from "../../shared/types.js";

/**
 * Returns the partial skill name when the input is a slash command being
 * composed (no whitespace yet), otherwise null. The popover only opens on
 * `/<name>` shapes; once the user adds a space (typing args) the popover
 * stays closed.
 */
export function parseSlashQuery(input: string): { query: string } | null {
  if (!input.startsWith("/")) {
    return null;
  }
  const rest = input.slice(1);
  if (/\s/.test(rest)) {
    return null;
  }
  return { query: rest };
}

interface UseSlashAutocompleteArgs {
  input: string;
  setInput: (value: string) => void;
  provider: ProviderId | null;
  workspaceId: string | null;
}

export interface SlashAutocompleteState {
  popoverOpen: boolean;
  filteredSkills: SkillSummary[];
  /** Lowercased names of every skill available for this provider/workspace.
      Lets the composer tint a `/command` token even after the popover closes
      (e.g. once args are typed). */
  skillNames: Set<string>;
  selectionIndex: number;
  setSelectionIndex: (index: number) => void;
  selectSkill: (name: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

export function useSlashAutocomplete({
  input,
  setInput,
  provider,
  workspaceId
}: UseSlashAutocompleteArgs): SlashAutocompleteState {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectionIndex, setSelectionIndex] = useState(0);
  const fetchedFor = useRef<string | null>(null);
  // Memoize so identity is stable per `input`. Without this, every parent
  // render rebuilds the result object, refiring the fetch + filter effects
  // below on deps that didn't actually change.
  const slashQuery = useMemo(() => parseSlashQuery(input), [input]);

  // Fetch whenever the input opens with a slash — not only while the popover
  // query is live. The composer tints a `/command` token even after a space
  // is typed (popover closed), which needs the list loaded in that state too.
  // Keyed on `input` so a retry after a transient failure refires as the user
  // keeps typing; the `fetchedFor` latch still collapses it to one IPC call.
  useEffect(() => {
    if (!input.startsWith("/") || !provider) {
      return;
    }
    const cacheKey = `${provider}::${workspaceId ?? ""}`;
    if (fetchedFor.current === cacheKey) {
      return;
    }
    const api = window.argmax?.skills;
    if (!api?.list) {
      return;
    }
    // Set synchronously so re-entrant renders during the in-flight window
    // don't fire duplicate IPC calls; cleared on failure so a transient
    // error can be retried on the next render.
    fetchedFor.current = cacheKey;
    let cancelled = false;
    void api
      .list({ provider, workspaceId })
      .then((result) => {
        if (cancelled) return;
        setSkills(result);
      })
      .catch(() => {
        if (cancelled) return;
        fetchedFor.current = null;
        setSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, [input, provider, workspaceId]);

  const skillNames = useMemo(
    () => new Set(skills.map((skill) => skill.name.toLowerCase())),
    [skills]
  );

  const filteredSkills = useMemo(() => {
    if (!slashQuery) {
      return [] as SkillSummary[];
    }
    const needle = slashQuery.query.toLowerCase();
    if (!needle) {
      return skills;
    }
    return skills.filter((skill) => skill.name.toLowerCase().includes(needle));
  }, [skills, slashQuery]);

  const popoverOpen = slashQuery !== null && filteredSkills.length > 0;

  useEffect(() => {
    if (selectionIndex >= filteredSkills.length) {
      setSelectionIndex(0);
    }
  }, [filteredSkills.length, selectionIndex]);

  const selectSkill = (name: string): void => {
    setInput(`/${name} `);
    setSelectionIndex(0);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (!popoverOpen) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectionIndex((prev) => (prev + 1) % filteredSkills.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectionIndex((prev) => (prev - 1 + filteredSkills.length) % filteredSkills.length);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const choice = filteredSkills[selectionIndex];
      if (choice) {
        event.preventDefault();
        selectSkill(choice.name);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setInput("");
      setSelectionIndex(0);
    }
  };

  return { popoverOpen, filteredSkills, skillNames, selectionIndex, setSelectionIndex, selectSkill, onKeyDown };
}
