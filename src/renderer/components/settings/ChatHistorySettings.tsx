import { useRef, useState, type JSX } from "react";
import type { ChatCleanupPreview } from "../../../shared/types.js";
import { SettingGroup, SettingNote, SettingRow } from "./settingsPrimitives.js";

const LAST_CLEANUP_KEY = "argmax.chatHistory.lastCleanup";

export function ChatHistorySettings(): JSX.Element {
  const [preview, setPreview] = useState<ChatCleanupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lastCleanup, setLastCleanup] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(LAST_CLEANUP_KEY);
    } catch {
      return null;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function reviewCleanup(): Promise<void> {
    if (!window.argmax) {
      setError("Open the Argmax app to manage chat history.");
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const result = await window.argmax.settings.previewChatCleanup();
      setPreview(result.chatCount > 0 ? result : null);
      if (result.chatCount === 0) setStatus("No inactive chats older than 7 days to delete.");
    } catch (cause) {
      setError(`Could not check chat history: ${String(cause)}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function deleteChats(): Promise<void> {
    if (!window.argmax) {
      setError("Open the Argmax app to manage chat history.");
      return;
    }
    if (!preview || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await window.argmax.settings.deleteOldChats({ cleanupId: preview.cleanupId });
      const skipped = result.skippedRecentCount + result.skippedRunningCount;
      const message =
        `Deleted ${result.deletedChatCount} ${result.deletedChatCount === 1 ? "chat" : "chats"}.` +
          (skipped ? ` Kept ${skipped} ${skipped === 1 ? "chat that is" : "chats that are"} active or recently updated.` : "");
      setLastCleanup(message);
      setStatus(null);
      try {
        window.localStorage.setItem(LAST_CLEANUP_KEY, message);
      } catch {
        // A storage failure must not turn a successful deletion into an error.
      }
      setPreview(null);
    } catch (cause) {
      setPreview(null);
      setError(`Chat cleanup did not finish: ${String(cause)}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <SettingGroup id="settings-chat-history" label="Chat history">
      <SettingRow
        label="Delete chats older than 7 days"
        description="Permanently removes chats whose last activity was more than 7 days ago. Chats with active work are kept. Project files and worktrees stay on disk."
        control={
          <button type="button" className="settings-button" disabled={busy || preview !== null} onClick={() => void reviewCleanup()}>
            {busy && !preview ? "Checking…" : "Delete old chats…"}
          </button>
        }
      />
      {preview ? (
        <SettingRow
          label={`Permanently delete ${preview.chatCount} ${preview.chatCount === 1 ? "chat" : "chats"}?`}
          description="This cannot be undone. These chats will also stay excluded from chat sync."
          control={
            <>
              <button type="button" className="settings-button" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
              <button type="button" className="settings-button" disabled={busy} onClick={() => void deleteChats()}>
                {busy ? "Deleting…" : `Delete ${preview.chatCount} ${preview.chatCount === 1 ? "chat" : "chats"}`}
              </button>
            </>
          }
        />
      ) : null}
      {lastCleanup || status ? (
        <SettingNote role="status">
          {lastCleanup ? `Last cleanup: ${lastCleanup}` : null}
          {lastCleanup && status ? " " : null}
          {status}
        </SettingNote>
      ) : null}
      {error ? <SettingNote role="alert" tone="warn">{error}</SettingNote> : null}
    </SettingGroup>
  );
}
