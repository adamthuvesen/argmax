import { useCallback, useEffect, useState, type JSX } from "react";
import type { LinkedRepo } from "../../../shared/types.js";
import { validationMessage } from "../../../shared/validationMessage.js";
import { showErrorToast } from "../../state/toast.js";
import { Toggle } from "./settingsPrimitives.js";

/**
 * Settings → Projects → Linked repositories. Each entry is a named, canonical
 * directory the project's agents may read and edit. It is separate from the project's
 * sources, which are project-relative files and URLs.
 *
 * Claude Code receives the directories with `--add-dir` for read and edit access.
 */
export function LinkedReposPanel({ projectId }: { projectId: string }): JSX.Element {
  const [repos, setRepos] = useState<LinkedRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const api = window.argmax?.linkedRepos;

  useEffect(() => {
    let active = true;
    if (!api) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void api
      .list({ projectId })
      .then((result) => {
        if (!active) return;
        setRepos(result);
        setLoadError(null);
      })
      .catch((reason: unknown) => {
        if (active) setLoadError(validationMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, projectId]);

  const add = useCallback(async (): Promise<void> => {
    if (!api) return;
    setBusy(true);
    setFormError(null);
    try {
      const created = await api.add({
        projectId,
        repo: { name: name.trim() === "" ? null : name.trim(), path: path.trim() }
      });
      setRepos((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setName("");
      setPath("");
    } catch (reason) {
      // The reason names the rule that failed, so it belongs beside the form.
      setFormError(validationMessage(reason));
    } finally {
      setBusy(false);
    }
  }, [api, name, path, projectId]);

  const toggle = useCallback(
    async (repo: LinkedRepo, enabled: boolean): Promise<void> => {
      if (!api) return;
      setBusy(true);
      try {
        const updated = await api.setEnabled({ projectId, id: repo.id, enabled });
        setRepos((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      } catch (reason) {
        showErrorToast(validationMessage(reason));
      } finally {
        setBusy(false);
      }
    },
    [api, projectId]
  );

  const remove = useCallback(
    async (repo: LinkedRepo): Promise<void> => {
      if (!api) return;
      setBusy(true);
      try {
        await api.remove({ projectId, id: repo.id });
        setRepos((current) => current.filter((item) => item.id !== repo.id));
      } catch (reason) {
        showErrorToast(validationMessage(reason));
      } finally {
        setBusy(false);
      }
    },
    [api, projectId]
  );

  return (
    <section
      id="settings-linked-repos"
      className="settings-card linked-repos"
      aria-label="Linked repositories"
    >
      <h3>Linked repositories</h3>
      <p className="settings-note">
        Other checkouts on this Mac that agents can read and edit as needed for your task. Claude
        Code gets them as extra directories and loads their CLAUDE.md files. Agents can use Argmax
        source tools to read files and their normal file or shell tools to edit them, subject to
        session permissions. Argmax reads these folders on demand and never watches them.
      </p>
      {!api ? <p className="settings-note">Open the Argmax app to manage linked repositories.</p> : null}
      {loadError ? (
        <p role="alert" className="settings-note">
          {loadError}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="settings-note">
          Loading linked repositories…
        </p>
      ) : null}
      {!loading && !loadError && repos.length === 0 && api ? (
        <p className="settings-note">No linked repositories yet.</p>
      ) : null}
      {repos.length > 0 ? (
        <ul className="project-source-list">
          {repos.map((repo) => (
            <li key={repo.id}>
              <strong>{repo.name}</strong>
              <code>{repo.rootPath}</code>
              <div className="project-source-actions">
                <Toggle
                  ariaLabel={`Enable linked repository ${repo.name}`}
                  checked={repo.enabled}
                  onChange={(enabled) => void toggle(repo, enabled)}
                />
                <button
                  type="button"
                  className="settings-button"
                  disabled={busy}
                  aria-label={`Remove linked repository ${repo.name}`}
                  onClick={() => void remove(repo)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {api ? (
        <form
          className="project-source-form"
          aria-label="Link a repository"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="settings-field">
            Absolute path
            <input
              className="settings-text-input"
              required
              spellCheck={false}
              placeholder="/Users/you/code/shared-docs"
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <label className="settings-field">
            Name (optional)
            <input
              className="settings-text-input"
              maxLength={40}
              spellCheck={false}
              placeholder="shared-docs"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {formError ? (
            <p role="alert" className="settings-note">
              {formError}
            </p>
          ) : null}
          <div className="project-source-actions">
            <button className="settings-button" type="submit" disabled={busy || path.trim() === ""}>
              {busy ? "Linking…" : "Link repository"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
