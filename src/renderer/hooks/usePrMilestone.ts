import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { WorkspaceSummary } from "../../shared/types.js";
import { PrMilestoneCelebrationContext } from "../lib/uiPreferences.js";

/** Only celebrate GitHub milestones that happened while this chat was open. */
export function usePrMilestone(workspace: WorkspaceSummary | null): {
  milestone: string | null;
  finish: () => void;
} {
  const enabled = useContext(PrMilestoneCelebrationContext);
  const identity = workspace ? JSON.stringify([workspace.projectId, workspace.id, workspace.branch]) : "";
  const watch = useRef({ identity, enabled, startedAt: Date.now(), seen: new Set<string>() });
  const [active, setActive] = useState<{ identity: string; milestone: string } | null>(null);
  const number = workspace?.prNumber;
  const state = workspace?.prState;
  const createdAt = workspace?.prCreatedAt;
  const mergedAt = workspace?.prMergedAt;

  useEffect(() => {
    if (watch.current.identity !== identity || watch.current.enabled !== enabled) {
      watch.current = { identity, enabled, startedAt: Date.now(), seen: new Set() };
      setActive(null);
      return;
    }
    if (!enabled) setActive(null);
    if (!number || (state !== "OPEN" && state !== "MERGED")) return;

    // Merge wins if one refresh discovers both creation and merge. Record both
    // while disabled too, so turning the setting on never replays old work.
    const created = `${number}:created`;
    const merged = `${number}:merged`;
    const newCreation = Date.parse(createdAt ?? "") > watch.current.startedAt && !watch.current.seen.has(created);
    const newMerge = state === "MERGED" && Date.parse(mergedAt ?? "") > watch.current.startedAt && !watch.current.seen.has(merged);
    if (Number.isFinite(Date.parse(createdAt ?? ""))) watch.current.seen.add(created);
    if (state === "MERGED" && Number.isFinite(Date.parse(mergedAt ?? ""))) watch.current.seen.add(merged);
    if (enabled && (newMerge || (state === "OPEN" && newCreation))) {
      setActive({ identity, milestone: newMerge ? merged : created });
    }
  }, [identity, number, state, createdAt, mergedAt, enabled]);

  const finish = useCallback(() => setActive(null), []);
  return { milestone: enabled && active?.identity === identity ? active.milestone : null, finish };
}
