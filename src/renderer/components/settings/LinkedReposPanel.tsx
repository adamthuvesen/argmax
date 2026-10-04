import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { LinkedRepo } from "../../../shared/types.js";
import { validationMessage } from "../../../shared/validationMessage.js";
import { showErrorToast } from "../../state/toast.js";
import { Toggle } from "./settingsPrimitives.js";

// Requests outlive Settings so a returning panel can observe the same generation.
const pendingSummaries = new Map<string, Promise<LinkedRepo>>();

export function LinkedReposPanel({ projectId }: { projectId: string }): JSX.Element {
  return <ProjectLinkedRepos key={projectId} projectId={projectId} />;
}

function ProjectLinkedRepos({ projectId }: { projectId: string }): JSX.Element {
  const [repos, setRepos] = useState<LinkedRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState<Set<string>>(new Set());
  const [summaryErrors, setSummaryErrors] = useState<Record<string, string | undefined>>({});
  const mounted = useRef(true);
  const api = window.argmax?.linkedRepos;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const summarize = useCallback(async (repo: LinkedRepo): Promise<void> => {
    if (!api) return;
    if (mounted.current) {
      setSummarizing((current) => new Set(current).add(repo.id));
      setSummaryErrors((current) => ({ ...current, [repo.id]: undefined }));
    }
    try {
      let request = pendingSummaries.get(repo.id);
      if (!request) {
        request = api.summarize({ projectId, id: repo.id }).finally(() => {
          pendingSummaries.delete(repo.id);
        });
        pendingSummaries.set(repo.id, request);
      }
      const updated = await request;
      if (!mounted.current) return;
      setRepos((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      if (mounted.current) {
        setSummaryErrors((current) => ({ ...current, [repo.id]: validationMessage(reason) }));
      }
    } finally {
      if (mounted.current) {
        setSummarizing((current) => {
          const remaining = new Set(current);
          remaining.delete(repo.id);
          return remaining;
        });
      }
    }
  }, [api, projectId]);

  useEffect(() => {
    let active = true;
    if (!api) {
      setLoading(false);
      return;
    }
    void api
      .list({ projectId })
      .then((result) => {
        if (!active) return;
        setRepos(result);
        setLoadError(null);
        for (const repo of result) {
          if (pendingSummaries.has(repo.id)) void summarize(repo);
        }
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(validationMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [api, projectId, summarize]);

  async function connect(): Promise<void> {
    if (!api) return;
    setBusy(true);
    setConnectError(null);
    try {
      const created = await api.pickFolder({ projectId });
      if (!created) return;
      if (mounted.current) {
        setRepos((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      }
      void summarize(created);
    } catch (reason) {
      if (mounted.current) setConnectError(validationMessage(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function toggle(repo: LinkedRepo, enabled: boolean): Promise<void> {
    if (!api) return;
    setBusy(true);
    try {
      const updated = await api.setEnabled({ projectId, id: repo.id, enabled });
      if (mounted.current) {
        setRepos((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      }
    } catch (reason) {
      if (mounted.current) showErrorToast(validationMessage(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function remove(repo: LinkedRepo): Promise<void> {
    if (!api) return;
    setBusy(true);
    try {
      await api.remove({ projectId, id: repo.id });
      if (mounted.current) setRepos((current) => current.filter((item) => item.id !== repo.id));
    } catch (reason) {
      if (mounted.current) showErrorToast(validationMessage(reason));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section
      id="settings-linked-repos"
      className="settings-card linked-repos"
      aria-label="Linked repositories"
    >
      <h3>Linked repositories</h3>
      <p className="settings-note">
        Connect other repositories on this Mac that agents can read and edit for your task.
        Argmax generates a concise summary to include in agent context. It reads these folders
        on demand and never watches them.
      </p>
      {!api ? <p className="settings-note">Open the Argmax app to manage linked repositories.</p> : null}
      {loadError ? <p role="alert" className="settings-note">{loadError}</p> : null}
      {loading ? (
        <p role="status" className="settings-note">Loading linked repositories…</p>
      ) : null}
      {!loading && !loadError && repos.length === 0 && api ? (
        <p className="settings-note">No linked repositories yet.</p>
      ) : null}
      {repos.length > 0 ? (
        <ul className="project-source-list">
          {repos.map((repo) => {
            const generating = summarizing.has(repo.id);
            const error = summaryErrors[repo.id];
            return (
              <li key={repo.id}>
                <strong>{repo.name}</strong>
                <code>{repo.rootPath}</code>
                {repo.summary ? <p className="settings-note">{repo.summary}</p> : null}
                {generating ? <p role="status" className="settings-note">Generating summary…</p> : null}
                {error ? (
                  <p role="alert" className="settings-note">
                    Repository connected. Summary unavailable. {error}
                  </p>
                ) : null}
                <div className="project-source-actions">
                  <Toggle
                    ariaLabel={`Enable linked repository ${repo.name}`}
                    checked={repo.enabled}
                    disabled={busy || generating}
                    onChange={(enabled) => void toggle(repo, enabled)}
                  />
                  <button
                    type="button"
                    className="settings-button"
                    disabled={busy || generating || !repo.enabled}
                    aria-label={`${error ? "Retry summary" : repo.summary ? "Regenerate summary" : "Generate summary"} for ${repo.name}`}
                    onClick={() => void summarize(repo)}
                  >
                    {error ? "Retry summary" : repo.summary ? "Regenerate summary" : "Generate summary"}
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    disabled={busy || generating}
                    aria-label={`Remove linked repository ${repo.name}`}
                    onClick={() => void remove(repo)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {api ? (
        <>
          {connectError ? <p role="alert" className="settings-note">{connectError}</p> : null}
          <div className="project-source-actions">
            <button
              className="settings-button"
              type="button"
              disabled={busy || loading || Boolean(loadError)}
              onClick={() => void connect()}
            >
              Connect repository…
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
