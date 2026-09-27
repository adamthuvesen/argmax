import { useState, type JSX } from "react";
import { errorMessage } from "../../../shared/error.js";
import type { ProjectCheckMode, RoutingSettings } from "../../../shared/types.js";
import { SegmentedControl, SettingGroup, SettingNote, SettingRow } from "./settingsPrimitives.js";

const PROJECT_CHECK_OPTIONS: ReadonlyArray<{ value: ProjectCheckMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "suggest", label: "Suggest" },
  { value: "switch", label: "Suggest & switch" }
];

function isProjectCheckMode(value: string): value is ProjectCheckMode {
  return PROJECT_CHECK_OPTIONS.some((option) => option.value === value);
}

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

  const setProjectCheck = async (mode: ProjectCheckMode): Promise<void> => {
    const api = window.argmax?.settings;
    if (!api) return;
    setError(null);
    try {
      onRoutingChange(await api.setProjectCheck({ mode }));
    } catch (saveError) {
      setError(errorMessage(saveError));
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
      {routing?.enabled ? (
        <SettingRow
          label="Project check"
          description="Before a new chat starts, Jev reads the prompt and checks it belongs in the project you picked. Suggest asks first; Suggest & switch also moves a chat on its own when the prompt names the other project or one of its files."
          control={
            <SegmentedControl
              ariaLabel="Project check"
              name="project-check-mode"
              value={routing.projectCheck}
              onChange={(value) => {
                if (isProjectCheckMode(value)) void setProjectCheck(value);
              }}
              options={PROJECT_CHECK_OPTIONS}
            />
          }
        />
      ) : null}
      {error ? (
        <SettingNote tone="warn" role="alert">
          {error}
        </SettingNote>
      ) : null}
    </SettingGroup>
  );
}
