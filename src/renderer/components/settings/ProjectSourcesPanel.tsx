import { useEffect, useState, type JSX } from "react";
import type { ProjectSource, SourceInput } from "../../../shared/types.js";

export function ProjectSourcesPanel({ projectId }: { projectId: string }): JSX.Element {
  const [sources, setSources] = useState<ProjectSource[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProjectSource | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const api = window.argmax?.sources;
    if (!api) {
      setLoading(false);

      return;
    }
    void api.list({ projectId }).then((result) => {
      if (active) setSources(result);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load sources.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, revision]);

  async function save(source: SourceInput): Promise<void> {
    const api = window.argmax?.sources;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      if (editing && editing !== "new") {
        await api.update({ projectId, id: editing.id, source });
      } else {
        await api.add({ projectId, source });
      }
      setEditing(null);
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save source.");
    } finally { setBusy(false); }
  }

  async function remove(id: string): Promise<void> {
    const api = window.argmax?.sources;
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete({ projectId, id });
      setSources((items) => items.filter((item) => item.id !== id));
      if (editing !== "new" && editing?.id === id) setEditing(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove source.");
    } finally { setBusy(false); }
  }

  return (
    <section id="settings-project-sources" className="settings-card project-sources" aria-label="Project sources">
      <h3>Project sources</h3>
      <p className="settings-note">Save repository paths and web links with guidance on when to consult them. Agents can add references as they work and read current content on demand. Source reads appear in the chat.</p>
      <div className="project-source-actions">
        <button className="settings-button" disabled={busy || loading || !window.argmax?.sources} onClick={() => setEditing("new")}>Add source</button>
        <button className="settings-button" disabled={busy || loading} onClick={() => setRevision((value) => value + 1)}>Refresh sources</button>
      </div>
      {!window.argmax?.sources ? <p className="settings-note">Open the Argmax app to manage project sources.</p> : null}
      {error ? <p role="alert" className="settings-note">{error}</p> : null}
      {loading ? <p role="status" className="settings-note">Loading sources…</p> : null}
      {!loading && !error && sources.length === 0 ? <p className="settings-note">No sources yet. Try docs/architecture.md or a project specification URL.</p> : null}
      {sources.length > 0 ? <ul className="project-source-list">
        {sources.map((source) => (
          <li key={source.id}>
            <strong>{source.title}</strong>
            <code>{source.location}</code>
            {source.guidance ? <p>{source.guidance}</p> : null}
            <p className="settings-note">Added by {source.addedBy} on <time dateTime={source.createdAt}>{source.createdAt.slice(0, 10)}</time>. {source.updatedAt !== source.createdAt ? <>Edited <time dateTime={source.updatedAt}>{source.updatedAt.slice(0, 10)}</time>.</> : null}</p>
            <div className="project-source-actions">
              <button className="settings-button" disabled={busy || loading} aria-label={`Edit source: ${source.title}`} onClick={() => setEditing(source)}>Edit</button>
              <button className="settings-button" disabled={busy || loading} aria-label={`Remove source: ${source.title}`} onClick={() => void remove(source.id)}>Remove</button>
            </div>
          </li>
        ))}
      </ul> : null}
      {editing ? <SourceForm key={editing === "new" ? "new" : editing.id} source={editing === "new" ? null : editing} busy={busy || loading} onSave={save} onCancel={() => setEditing(null)} /> : null}
      <p className="settings-note">Only references are saved here. Adding or editing a source does not verify its contents. Removing it leaves the original file or page intact. Engram is optional and configured separately.</p>
    </section>
  );
}

function SourceForm({ source, busy, onSave, onCancel }: { source: ProjectSource | null; busy: boolean; onSave: (source: SourceInput) => Promise<void>; onCancel: () => void }): JSX.Element {
  const [title, setTitle] = useState(source?.title ?? "");
  const [location, setLocation] = useState(source?.location ?? "");
  const [guidance, setGuidance] = useState(source?.guidance ?? "");
  return (
    <form className="project-source-form" aria-label={source ? "Edit project source" : "Add project source"} onSubmit={(event) => { event.preventDefault(); void onSave({ title: title.trim(), location: location.trim(), guidance: guidance.trim() }); }}>
      <label className="settings-field">Title<input className="settings-text-input" required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="settings-field">Repository path or URL<input className="settings-text-input" required maxLength={2048} placeholder="docs/architecture.md or https://…" value={location} onChange={(event) => setLocation(event.target.value)} /></label>
      <label className="settings-field">When to consult<textarea className="settings-text-input" rows={3} maxLength={1000} placeholder="Read before changing the runtime lifecycle" value={guidance} onChange={(event) => setGuidance(event.target.value)} /></label>
      <div className="project-source-actions"><button className="settings-button" disabled={busy || !title.trim() || !location.trim()} type="submit">{busy ? "Saving…" : "Save source"}</button><button className="settings-button" disabled={busy} type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
