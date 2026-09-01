import { useCallback, useEffect, useState, type JSX } from "react";
import { errorMessage } from "../../../shared/error.js";
import type { SyncStatus } from "../../../shared/types.js";
import { SectionHeader, Segmented, ToggleRow } from "./settingsPrimitives.js";

const PROVIDERS = ["claude", "codex", "cursor", "opencode", "grok"] as const;

const PROVIDER_LABELS: Record<(typeof PROVIDERS)[number], string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok Build"
};

/**
 * Settings → Agents → Session sync. Picks up sessions started outside Argmax
 * (a plain `claude` in a terminal) by reading each CLI's own transcript store,
 * and keeps doing it — new sessions appear on the next sweep, not just once.
 */
export function SessionSyncSettings(): JSX.Element {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "saved" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      setLoadError("Open the Argmax desktop app to configure session sync.");
      return;
    }
    try {
      setStatus(await window.argmax.sync.getStatus());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: SyncStatus["config"]): Promise<void> => {
      if (!window.argmax) return;
      setBusy(true);
      setNote(null);
      try {
        const updated = await window.argmax.sync.setConfig(next);
        setStatus(updated);
        setNote(
          updated.lastError
            ? { kind: "error", message: updated.lastError }
            : { kind: "saved", message: syncSummary(updated) }
        );
      } catch (error) {
        setNote({ kind: "error", message: errorMessage(error) });
      } finally {
        setBusy(false);
      }
    },
    []
  );

  if (loadError) {
    return (
      <section className="settings-section" aria-labelledby="settings-session-sync">
        <SectionHeader
          id="settings-session-sync"
          eyebrow="Session sync"
          title="Sessions from your terminal"
          description={loadError}
        />
      </section>
    );
  }

  const config = status?.config;
  const supported = new Set(status?.supportedProviders ?? []);

  return (
    <section className="settings-section" aria-labelledby="settings-session-sync">
      <SectionHeader
        id="settings-session-sync"
        eyebrow="Session sync"
        title="Sessions from your terminal"
        description="Pick up sessions you started outside Argmax by reading each agent's own transcripts. New sessions keep appearing while sync is on, and you can continue any of them here."
      />
      <div className="settings-card">
        {PROVIDERS.map((provider) => (
          <ToggleRow
            key={provider}
            label={PROVIDER_LABELS[provider]}
            description={
              supported.has(provider)
                ? undefined
                : "Argmax can't read this agent's transcript format yet."
            }
            checked={Boolean(config?.[provider])}
            onChange={(next) => {
              if (!config || !supported.has(provider) || busy) return;
              void save({ ...config, [provider]: next });
            }}
          />
        ))}
        <Segmented
          legend="How far back"
          hint="Older sessions are left in the agent's own history."
          name="sync-window"
          value={String(config?.windowHours ?? 24)}
          onChange={(next) => {
            if (!config || busy) return;
            void save({ ...config, windowHours: Number(next) });
          }}
          options={[
            { value: "24", label: "Last 24 hours" },
            { value: "168", label: "Last 7 days" }
          ]}
        />
        <p className="settings-hint">
          Turning a provider off — or narrowing the window — removes the synced sessions you
          haven&apos;t continued in Argmax. Nothing is lost: the agent&apos;s own history still
          has them, and turning sync back on brings them back.
        </p>
        {note ? (
          <p
            className="settings-hint settings-form-status"
            data-status={note.kind}
            role={note.kind === "error" ? "alert" : "status"}
          >
            {note.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function syncSummary(status: SyncStatus): string {
  const anyEnabled = PROVIDERS.some((provider) => status.config[provider]);
  if (!anyEnabled) return "Sync off. Synced sessions you never continued were removed.";
  if (status.importedCount === 0) return "Saved. No new sessions to import.";
  const plural = status.importedCount === 1 ? "session" : "sessions";
  return `Saved. Imported ${status.importedCount} ${plural}.`;
}
