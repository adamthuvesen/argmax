import { useEffect, useRef, useState, type JSX } from "react";
import type { LinkedRepo, ProjectFolder } from "../../../shared/types.js";
import { validationMessage } from "../../../shared/validationMessage.js";
import { showErrorToast } from "../../state/toast.js";
import { Toggle } from "./settingsPrimitives.js";

const pendingSummaries = new Map<string, Promise<LinkedRepo>>();

export function ProjectFolderContext({ folder }: { folder: ProjectFolder }): JSX.Element {
  const [summary, setSummary] = useState(folder.summary);
  const [enabled, setEnabled] = useState(folder.enabled);
  const [busy, setBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const mounted = useRef(true);
  const api = window.argmax?.linkedRepos;

  async function observeSummary(request: Promise<LinkedRepo>): Promise<void> {
    setBusy(true);
    setSummaryError(null);
    try {
      const updated = await request;
      if (mounted.current) setSummary(updated.summary ?? null);
    } catch (reason) {
      if (mounted.current) setSummaryError(validationMessage(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    const pending = pendingSummaries.get(folder.id);
    if (pending) void observeSummary(pending);
    return () => { mounted.current = false; };
  }, [folder.id]);

  function summarize(): void {
    if (!api) return;
    let request = pendingSummaries.get(folder.id);
    if (!request) {
      request = api.summarize({ projectId: folder.projectId, id: folder.id }).finally(() => pendingSummaries.delete(folder.id));
      pendingSummaries.set(folder.id, request);
    }
    void observeSummary(request);
  }

  async function toggle(next: boolean): Promise<void> {
    if (!api) return;
    setBusy(true);
    try {
      const updated = await api.setEnabled({ projectId: folder.projectId, id: folder.id, enabled: next });
      if (mounted.current) setEnabled(updated.enabled);
    } catch (reason) {
      if (mounted.current) showErrorToast(validationMessage(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div className="project-folder-context">
      {summary ? <p className="settings-note">{summary}</p> : null}
      {busy && pendingSummaries.has(folder.id) ? <p className="settings-note" role="status">Generating summary…</p> : null}
      {summaryError ? <p className="settings-note" role="alert">Summary unavailable. {summaryError}</p> : null}
      {api ? <div className="project-folder-context-actions">
        <Toggle ariaLabel={`Include ${folder.name} in agent context`} checked={enabled} disabled={busy}
          onChange={(next) => void toggle(next)} />
        <span className="settings-note">Include in agent context</span>
        <button type="button" className="settings-button" disabled={busy || !enabled}
          aria-label={`${summaryError ? "Retry summary" : summary ? "Regenerate summary" : "Generate summary"} for ${folder.name}`}
          onClick={summarize}>
          {summaryError ? "Retry summary" : summary ? "Regenerate summary" : "Generate summary"}
        </button>
      </div> : null}
    </div>
  );
}
