import { useCallback, useEffect, useState, type JSX } from "react";
import type { WindowSnapshotStatus } from "../../../shared/types.js";
import { displayChord, recordChord } from "../../lib/windowSnapshotChord.js";
import { isRemoteBridge } from "../../lib/tauriBridge.js";
import { showErrorToast } from "../../state/toast.js";
import { SettingGroup, SettingNote, SettingRow, Toggle } from "./settingsPrimitives.js";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The change was not saved.";
}

/**
 * The window snapshot chord: on or off, which keys, and whether macOS lets
 * Argmax see other apps' windows. Owns its own state; the host is the source of
 * truth, and a failed registration comes back as an error that leaves the old chord.
 */
export function WindowSnapshotSettings(): JSX.Element | null {
  // The remote browser has no chord to set and the channels are desktop-only.
  const api = isRemoteBridge() ? undefined : window.argmax?.windowSnapshot;
  const [status, setStatus] = useState<WindowSnapshotStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api?.status().then(
      (next) => {
        if (!cancelled) setStatus(next);
      },
      (error: unknown) => showErrorToast(message(error))
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const configure = useCallback(
    async (enabled: boolean, chord: string): Promise<void> => {
      if (!api) return;
      setBusy(true);
      try {
        setStatus(await api.configure({ enabled, chord }));
      } catch (error) {
        showErrorToast(message(error));
        // The host kept the previous chord; show it, not the rejected one.
        setStatus(await api.status().catch(() => null));
      } finally {
        setBusy(false);
      }
    },
    [api]
  );

  useEffect(() => {
    if (!recording || !status) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") {
        setRecording(false);
        return;
      }
      const result = recordChord(event);
      if (result.kind === "modifier-only") return;
      if (result.kind === "needs-modifier") {
        showErrorToast("A shortcut needs ⌘, ⌃ or ⌥ as well as a key.");
        return;
      }
      setRecording(false);
      void configure(status.enabled, result.chord);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, status, configure]);

  if (!api || !status) return null;

  if (!status.supported) {
    return (
      <SettingGroup id="settings-window-snapshot" label="Window snapshot">
        <SettingNote>Window snapshots are only available on macOS.</SettingNote>
      </SettingGroup>
    );
  }

  const granted = status.permission === "granted";
  return (
    <SettingGroup id="settings-window-snapshot" label="Window snapshot">
      <SettingRow
        label="Window snapshot shortcut"
        description="Press it from any app to attach that app's frontmost window to your next message."
        control={
          <Toggle
            ariaLabel="Window snapshot shortcut"
            checked={status.enabled}
            disabled={busy}
            onChange={(enabled) => void configure(enabled, status.chord)}
          />
        }
      />
      <SettingRow
        label="Shortcut keys"
        description="Needs ⌘, ⌃ or ⌥ as well as a key. macOS does not tell Argmax when another app uses the same keys. Press Esc to cancel."
        control={
          <>
            <button
              type="button"
              className="settings-button"
              aria-label={recording ? "Press the new shortcut" : `Change shortcut, now ${displayChord(status.chord)}`}
              aria-pressed={recording}
              disabled={busy}
              onClick={() => setRecording((value) => !value)}
            >
              <span>{recording ? "Press keys…" : displayChord(status.chord)}</span>
            </button>
            {status.chord !== status.defaultChord ? (
              <button
                type="button"
                className="settings-button"
                disabled={busy}
                onClick={() => void configure(status.enabled, status.defaultChord)}
              >
                <span>Reset</span>
              </button>
            ) : null}
          </>
        }
      />
      <SettingRow
        label="Screen Recording access"
        description={
          granted
            ? "Argmax can capture other apps' windows."
            : "macOS asks once. If you declined, turn Argmax on under Privacy & Security > Screen Recording, then restart Argmax."
        }
        control={
          granted ? (
            <span className="settings-row-value">Allowed</span>
          ) : (
            <button
              type="button"
              className="settings-button"
              disabled={busy}
              onClick={() =>
                void api
                  .requestPermission()
                  .then(setStatus, (error: unknown) => showErrorToast(message(error)))
              }
            >
              <span>Allow Screen Recording</span>
            </button>
          )
        }
      />
      {status.enabled && status.registrationError ? (
        <SettingNote tone="warn" role="alert">
          The shortcut is not active: {status.registrationError}
        </SettingNote>
      ) : null}
    </SettingGroup>
  );
}
