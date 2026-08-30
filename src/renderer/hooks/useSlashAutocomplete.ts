import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import type { ProviderId, SkillSummary } from "../../shared/types.js";

/**
 * Returns the partial skill name when the input ends in a slash command being
 * composed — `/<name>` at the start of the input or after whitespace, with no
 * space typed after it yet. Mid-sentence invocations count ("check this /sn"),
 * so the popover is not limited to messages that open with the skill. `start`
 * is the index of the token's `/` so a selection can replace just that token.
 * Word-internal slashes (paths like `foo/bar`) never match: the `/` must
 * follow whitespace or start the input.
 */
export function parseSlashQuery(input: string): { query: string; start: number } | null {
  const match = /(^|\s)\/(\S*)$/.exec(input);
  if (!match) {
    return null;
  }
  const query = match[2] ?? "";
  return { query, start: input.length - query.length - 1 };
}

/** Stable empty list so the memos below don't refire on every render. */
const NO_SKILLS: SkillSummary[] = [];

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
  // Loaded skills carry the provider/workspace key they were fetched for. The
  // pane retargets provider in place (no remount), so a list that is not for
  // the current key must never be served — otherwise `/` after a Claude → Codex
  // switch offers Claude's commands.
  const [loaded, setLoaded] = useState<{ key: string; skills: SkillSummary[] } | null>(null);
  const [selectionIndex, setSelectionIndex] = useState(0);
  const fetchedFor = useRef<string | null>(null);
  const cacheKey = provider ? `${provider}::${workspaceId ?? ""}` : null;
  const skills = loaded && loaded.key === cacheKey ? loaded.skills : NO_SKILLS;
  // Memoize so identity is stable per `input`. Without this, every parent
  // render rebuilds the result object, refiring the fetch + filter effects
  // below on deps that didn't actually change.
  const slashQuery = useMemo(() => parseSlashQuery(input), [input]);

  // Fetch whenever a slash command is live at the end of the input OR the
  // input opens with one — not only while the popover query is live. The
  // composer tints a leading `/command` token even after a space is typed
  // (popover closed), which needs the list loaded in that state too. Keyed on
  // `input` so a retry after a transient failure refires as the user keeps
  // typing; the `fetchedFor` latch still collapses it to one IPC call.
  useEffect(() => {
    if ((slashQuery === null && !input.startsWith("/")) || !provider || !cacheKey) {
      return;
    }
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
    // No cancelling cleanup. `input` is a dep, so a keystroke during the
    // in-flight window re-runs this effect: a cleanup would drop the response
    // while the re-run bailed on the latch, wedging the list at empty for the
    // rest of the session. The latch identity is the guard instead — a response
    // for a superseded key is simply not committed.
    void api
      .list({ provider, workspaceId })
      .then((result) => {
        if (fetchedFor.current !== cacheKey) return;
        setLoaded({ key: cacheKey, skills: result });
      })
      .catch(() => {
        if (fetchedFor.current !== cacheKey) return;
        fetchedFor.current = null;
        setLoaded({ key: cacheKey, skills: [] });
      });
  }, [input, slashQuery, provider, workspaceId, cacheKey]);

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

  // Replace only the live `/token` (which always trails the input) so a
  // mid-sentence invocation keeps the text typed before it.
  const selectSkill = (name: string): void => {
    const prefix = slashQuery ? input.slice(0, slashQuery.start) : "";
    setInput(`${prefix}/${name} `);
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
      // Drop just the live `/token`; for a message that is nothing but the
      // token this clears the input, matching the old behavior.
      setInput(slashQuery ? input.slice(0, slashQuery.start) : "");
      setSelectionIndex(0);
    }
  };

  return { popoverOpen, filteredSkills, skillNames, selectionIndex, setSelectionIndex, selectSkill, onKeyDown };
}
