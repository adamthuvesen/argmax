import { useCallback, useEffect, useRef } from "react";
import type { ProjectCheck } from "../../shared/types.js";

// Project check from the launcher's side (docs/routing.md#project-check).
// The check starts while the user is still typing, after a pause, so by the
// time they press Enter the answer is usually already here and the launch
// waits for nothing. A check that has not answered by then gets a short grace
// and is otherwise dropped: the launch never waits on Jev for long.

const TYPING_PAUSE_MS = 700;
const SUBMIT_GRACE_MS = 3_500;
const MIN_PROMPT_CHARS = 12;
const CACHE_SIZE = 8;

export const NO_PROJECT_CHECK: ProjectCheck = {
  decision: "none",
  checkId: null,
  suggestedProjectId: null,
  runnerUpProjectId: null,
  suggestedProbability: 0,
  currentProbability: 0,
  reasons: []
};

function checkable(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed.length >= MIN_PROMPT_CHARS && !trimmed.startsWith("/");
}

export function useProjectCheck({
  enabled,
  projectId,
  prompt,
  pickedByHand
}: {
  /** Off in chat and cloud mode, without a Jev key, or with one project. */
  enabled: boolean;
  projectId: string | null;
  prompt: string;
  pickedByHand: boolean;
}): (openingPrompt: string) => Promise<ProjectCheck> {
  const cache = useRef(new Map<string, Promise<ProjectCheck>>());

  const start = useCallback(
    (text: string): Promise<ProjectCheck> => {
      const api = window.argmax?.projects;
      if (!enabled || !projectId || !api?.checkPrompt || !checkable(text)) {
        return Promise.resolve(NO_PROJECT_CHECK);
      }
      const key = `${projectId}\u0000${pickedByHand ? 1 : 0}\u0000${text.trim()}`;
      const cached = cache.current.get(key);
      if (cached) return cached;
      const pending = api
        .checkPrompt({ projectId, prompt: text.trim(), pickedByHand })
        .catch(() => NO_PROJECT_CHECK);
      cache.current.set(key, pending);
      if (cache.current.size > CACHE_SIZE) {
        const oldest = cache.current.keys().next().value;
        if (oldest !== undefined) cache.current.delete(oldest);
      }
      return pending;
    },
    [enabled, pickedByHand, projectId]
  );

  useEffect(() => {
    if (!enabled || !checkable(prompt)) return;
    const timer = setTimeout(() => void start(prompt), TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [enabled, prompt, start]);

  return useCallback(
    (openingPrompt: string): Promise<ProjectCheck> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<ProjectCheck>((resolve) => {
        timer = setTimeout(() => resolve(NO_PROJECT_CHECK), SUBMIT_GRACE_MS);
      });
      return Promise.race([start(openingPrompt), grace]).finally(() => clearTimeout(timer));
    },
    [start]
  );
}
