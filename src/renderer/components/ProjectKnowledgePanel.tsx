import { Check, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type JSX } from "react";
import type { Learning, ProjectSummary } from "../../shared/types.js";

export function ProjectKnowledgePanel({ projects }: { projects: ProjectSummary[] }): JSX.Element {
  const [selectedProjectId, setSelectedProjectId] = useState<string>(() => projects[0]?.id ?? "");
  const [learnings, setLearnings] = useState<Learning[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftSummaries, setDraftSummaries] = useState<Record<string, string>>({});

  const refresh = useCallback(async (): Promise<void> => {
    if (!window.argmax || !selectedProjectId) {
      setLearnings([]);
      return;
    }
    try {
      const result = await window.argmax.learnings.list({ projectId: selectedProjectId });
      setLearnings(result);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load project knowledge.");
    }
  }, [selectedProjectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the project picker pointed at something valid when the prop changes.
  useEffect(() => {
    if (!projects.some((project) => project.id === selectedProjectId) && projects[0]) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const handleSummaryBlur = async (learning: Learning): Promise<void> => {
    const draft = draftSummaries[learning.id];
    if (draft === undefined || draft.trim() === learning.summary) {
      setDraftSummaries((current) => {
        const next = { ...current };
        delete next[learning.id];
        return next;
      });
      return;
    }
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraftSummaries((current) => {
        const next = { ...current };
        delete next[learning.id];
        return next;
      });
      return;
    }
    if (!window.argmax) return;
    try {
      const updated = await window.argmax.learnings.update({ id: learning.id, summary: trimmed });
      setLearnings((current) => current.map((item) => (item.id === learning.id ? updated : item)));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not update learning.");
    } finally {
      setDraftSummaries((current) => {
        const next = { ...current };
        delete next[learning.id];
        return next;
      });
    }
  };

  const handleVerifiedToggle = async (learning: Learning): Promise<void> => {
    if (!window.argmax) return;
    const nextVerified = !learning.verified;
    setLearnings((current) =>
      current.map((item) => (item.id === learning.id ? { ...item, verified: nextVerified } : item))
    );
    try {
      const updated = await window.argmax.learnings.update({ id: learning.id, verified: nextVerified });
      setLearnings((current) => current.map((item) => (item.id === learning.id ? updated : item)));
    } catch (error) {
      // Roll back on failure.
      setLearnings((current) =>
        current.map((item) => (item.id === learning.id ? { ...item, verified: learning.verified } : item))
      );
      setLoadError(error instanceof Error ? error.message : "Could not toggle verified.");
    }
  };

  const handleDelete = async (learning: Learning): Promise<void> => {
    if (!window.argmax) return;
    // Optimistic remove so the row disappears immediately.
    setLearnings((current) => current.filter((item) => item.id !== learning.id));
    try {
      await window.argmax.learnings.delete(learning.id);
    } catch (error) {
      // Restore on failure.
      setLearnings((current) => [...current, learning]);
      setLoadError(error instanceof Error ? error.message : "Could not delete learning.");
    }
  };

  return (
    <div className="settings-card project-knowledge">
      <div className="settings-row">
        <label htmlFor="settings-project-knowledge-picker">Project</label>
        <select
          id="settings-project-knowledge-picker"
          aria-label="Project knowledge — project picker"
          value={selectedProjectId}
          onChange={(event) => setSelectedProjectId(event.target.value)}
          disabled={projects.length === 0}
        >
          {projects.length === 0 ? <option value="">No projects yet</option> : null}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      {loadError ? (
        <p className="settings-hint" role="alert">
          {loadError}
        </p>
      ) : null}

      {learnings.length === 0 ? (
        <p className="settings-hint">No learnings captured yet. Complete a session to start filling this list.</p>
      ) : (
        <ul className="project-knowledge-list" aria-label="Project learnings">
          {learnings.map((learning) => {
            const draft = draftSummaries[learning.id];
            const draftActive = draft !== undefined;
            return (
              <li key={learning.id} className="project-knowledge-row" data-verified={learning.verified ? "true" : "false"}>
                <span className="project-knowledge-kind">{learning.kind}</span>
                <input
                  className="project-knowledge-summary"
                  aria-label={`Edit summary for learning ${learning.id}`}
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
