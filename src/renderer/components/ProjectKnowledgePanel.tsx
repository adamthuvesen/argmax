import { Check, Trash2 } from "lucide-react";
import { learningActions } from "../data/bridgeActions.js";
import { useBridgeQuery } from "../data/useBridgeQuery.js";
import { useEffect, useState, type JSX } from "react";
import type { Learning, ProjectSummary } from "../../shared/types.js";
import { showErrorToast } from "../state/toast.js";
import { SettingRow, SettingsListPicker } from "./settings/settingsPrimitives.js";

export function ProjectKnowledgePanel({ projects }: { projects: ProjectSummary[] }): JSX.Element {
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => projects[0]?.id ?? "");
  const [draftSummaries, setDraftSummaries] = useState<Record<string, string>>({});
  const query = useBridgeQuery({
    key: ["learnings.list", selectedProjectId],
    enabled: selectedProjectId !== "",
    read: (api) => api.learnings.list({ projectId: selectedProjectId })
  });
  const learnings = query.data ?? [];
  const loadError = query.error;
  const setLearnings = (update: (current: Learning[]) => Learning[]): void => {
    query.setData((current) => update(current ?? []));
  };

  useEffect(() => {
    setDraftSummaries({});
  }, [selectedProjectId]);

  // Keep the project picker pointed at something valid when the prop changes.
  useEffect(() => {
    if (!projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(projects[0]?.id ?? "");
    }
  }, [projects, selectedProjectId]);

  const handleSummaryBlur = async (learning: Learning): Promise<void> => {
    const trimmed = draftSummaries[learning.id]?.trim() ?? "";
    if (!trimmed || trimmed === learning.summary) {
      setDraftSummaries((current) => {
        const next = { ...current };
        delete next[learning.id];
        return next;
      });
      return;
    }
    const actions = learningActions();
    if (!actions) return;
    try {
      const updated = await actions.update({ id: learning.id, summary: trimmed });
      if (!query.isCurrent()) return;
      setLearnings((current) => current.map((item) => (item.id === learning.id ? updated : item)));
      setDraftSummaries((current) => {
        const next = { ...current };
        delete next[learning.id];
        return next;
      });
    } catch (error) {
      if (!query.isCurrent()) return;
      showErrorToast(error instanceof Error ? error.message : "Could not update learning.");
    }
  };

  const handleVerifiedToggle = async (learning: Learning): Promise<void> => {
    const actions = learningActions();
    if (!actions) return;
    const nextVerified = !learning.verified;
    setLearnings((current) =>
      current.map((item) => (item.id === learning.id ? { ...item, verified: nextVerified } : item))
    );
    try {
      const updated = await actions.update({ id: learning.id, verified: nextVerified });
      if (!query.isCurrent()) return;
      setLearnings((current) => current.map((item) => (item.id === learning.id ? updated : item)));
    } catch (error) {
      if (!query.isCurrent()) return;
      // Roll back on failure.
      setLearnings((current) =>
        current.map((item) => (item.id === learning.id ? { ...item, verified: learning.verified } : item))
      );
      showErrorToast(error instanceof Error ? error.message : "Could not toggle verified.");
    }
  };

  const handleDelete = async (learning: Learning): Promise<void> => {
    const actions = learningActions();
    if (!actions) return;
    // Optimistic remove so the row disappears immediately.
    setLearnings((current) => current.filter((item) => item.id !== learning.id));
    try {
      await actions.delete(learning.id);
    } catch (error) {
      if (!query.isCurrent()) return;
      // Restore on failure.
      setLearnings((current) => [...current, learning]);
      showErrorToast(error instanceof Error ? error.message : "Could not delete learning.");
    }
  };

  return (
    <div className="settings-card project-knowledge">
      <SettingRow
        label="Project"
        description="Project learnings are available when an agent searches with the Argmax learning tools. Current code and docs take precedence."
        htmlFor="settings-project-knowledge-picker"
        control={
          <SettingsListPicker
            ariaLabel="Project knowledge — project picker"
            inputId="settings-project-knowledge-picker"
            value={selectedProjectId}
            onChange={setSelectedProjectId}
            disabled={projects.length === 0}
            options={
              projects.length === 0
                ? [{ value: "", label: "No projects yet" }]
                : projects.map((project) => ({ value: project.id, label: project.name }))
            }
          />
        }
      />

      {loadError ? (
        <p className="settings-note" role="alert">
          {loadError}
        </p>
      ) : null}

      {learnings.length === 0 ? (
        <p className="settings-note">No learnings captured yet. Complete a chat to start filling this list.</p>
      ) : (
        <ul className="project-knowledge-list" aria-label="Project learnings">
          {learnings.map((learning) => {
            const draft = draftSummaries[learning.id];
            const draftActive = draft !== undefined;
            return (
              <li key={learning.id} className="project-knowledge-row" data-verified={learning.verified ? "true" : "false"}>
                <span className="project-knowledge-kind">{learning.kind}</span>
                <textarea
                  className="project-knowledge-summary"
                  aria-label={`Edit summary for learning ${learning.id}`}
                  rows={2}
                  value={draftActive ? draft : learning.summary}
                  onChange={(event) =>
                    setDraftSummaries((current) => ({ ...current, [learning.id]: event.target.value }))
                  }
                  onBlur={() => {
                    void handleSummaryBlur(learning);
                  }}
                />
                <button
                  type="button"
                  className="project-knowledge-verify"
                  aria-label={`${learning.verified ? "Unmark" : "Mark"} learning as verified`}
                  aria-pressed={learning.verified}
                  title={learning.verified ? "Verified (sticky)" : "Mark as verified"}
                  onClick={() => {
                    void handleVerifiedToggle(learning);
                  }}
                >
                  <Check size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="project-knowledge-delete"
                  aria-label={`Delete learning ${learning.id}`}
                  title="Delete learning"
                  onClick={() => {
                    void handleDelete(learning);
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
