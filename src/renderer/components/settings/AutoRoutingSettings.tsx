import { useState, type JSX } from "react";
import { errorMessage } from "../../../shared/error.js";
import type { RoutingSettings } from "../../../shared/types.js";
import { SettingGroup, SettingNote, SettingRow } from "./settingsPrimitives.js";

/**
 * Auto routing is on exactly when a Jev API key is saved, so the key is the
 * switch: there is no separate toggle that could turn Auto on without one.
 * Saving checks the key with a live call, and a rejection is shown inline.
 */
export function AutoRoutingSettings({
  routing,
  onRoutingChange
}: {
  /** Null until the first read answers. */
  routing: RoutingSettings | null;
  onRoutingChange: (routing: RoutingSettings) => void;
}): JSX.Element {
  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveKey = async (): Promise<void> => {
    const api = window.argmax?.settings;
    const trimmed = apiKey.trim();
    if (!api || trimmed === "") return;
    setIsSaving(true);
    setError(null);
    try {
      onRoutingChange(await api.setRoutingKey({ apiKey: trimmed }));
      setApiKey("");
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  };

  const removeKey = async (): Promise<void> => {
    const api = window.argmax?.settings;
    if (!api) return;
    setError(null);
    try {
      onRoutingChange(await api.clearRoutingKey());
    } catch (removeError) {
      setError(errorMessage(removeError));
    }
  };

  return (
    <SettingGroup id="settings-auto-routing" label="Model router">
      {routing?.enabled ? (
        <SettingRow
          label="Jev API key"
          description={`On · key ${routing.keyHint ?? "saved"}`}
          control={
            <button type="button" className="settings-button" onClick={() => void removeKey()}>
              Remove key
            </button>
          }
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveKey();
          }}
        >
          <SettingRow
            label="Jev API key"
            description="The model router picks the model and effort for a routed chat. Every message in that chat, including ones agents send, goes to TypeSafe's Jev to be classified. It needs a Jev API key."
            htmlFor="settings-routing-key"
            control={
              <>
                <input
                  id="settings-routing-key"
                  className="settings-text-input settings-routing-key-input"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={error !== null}
                  disabled={isSaving}
                />
                <button
                  type="submit"
                  className="settings-button"
                  disabled={isSaving || apiKey.trim() === ""}
                >
                  {isSaving ? "Checking…" : "Save"}
                </button>
              </>
            }
          />
        </form>
      )}
      {error ? (
        <SettingNote tone="warn" role="alert">
          {error}
        </SettingNote>
      ) : null}
    </SettingGroup>
  );
}
