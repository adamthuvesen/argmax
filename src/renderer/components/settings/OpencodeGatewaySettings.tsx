import { useEffect, useState, type JSX } from "react";
import { errorMessage } from "../../../shared/error.js";
import type { OpencodeGateway, OpencodeGatewaySettings as GatewaySettings } from "../../../shared/types.js";
import { SegmentedControl, SettingGroup, SettingNote, SettingRow } from "./settingsPrimitives.js";

const GATEWAY_OPTIONS: ReadonlyArray<{ value: OpencodeGateway; label: string }> = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "vercel", label: "Vercel AI Gateway" }
];

const GATEWAY_NAMES: Record<OpencodeGateway, string> = {
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway"
};

function isGateway(value: string): value is OpencodeGateway {
  return GATEWAY_OPTIONS.some((option) => option.value === value);
}

function keyHint(settings: GatewaySettings, gateway: OpencodeGateway): string | null | undefined {
  return gateway === "openrouter" ? settings.openrouterKeyHint : settings.vercelKeyHint;
}

/**
 * Which gateway OpenCode's models run through, and the key for it. A key is
 * optional: without one OpenCode uses its own `opencode auth login`. Only the
 * selected gateway's key row shows; the other gateway's key stays saved.
 */
export function OpencodeGatewaySettings(): JSX.Element {
  const [settings, setSettings] = useState<GatewaySettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.argmax?.settings;
    if (!api) return;
    let cancelled = false;
    api
      .opencodeGateway()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (action: () => Promise<GatewaySettings>): Promise<boolean> => {
    setError(null);
    try {
      setSettings(await action());
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError));
      return false;
    }
  };

  const api = window.argmax?.settings;
  const gateway = settings?.gateway ?? "openrouter";
  const name = GATEWAY_NAMES[gateway];
  const hint = settings ? keyHint(settings, gateway) : undefined;
  const inputId = `settings-opencode-key-${gateway}`;

  const saveKey = async (): Promise<void> => {
    const trimmed = apiKey.trim();
    if (!api || trimmed === "") return;
    setIsSaving(true);
    if (await run(() => api.setOpencodeGatewayKey({ gateway, apiKey: trimmed }))) setApiKey("");
    setIsSaving(false);
  };

  return (
    <SettingGroup id="settings-opencode-gateway" label="OpenCode gateway">
      {settings && api ? (
        <>
          <SettingRow
            label="Gateway"
            description="Where OpenCode's models run. Applies from each chat's next turn."
            control={
              <SegmentedControl
                ariaLabel="OpenCode gateway"
                name="opencode-gateway"
                value={gateway}
                onChange={(value) => {
                  if (!isGateway(value) || value === gateway) return;
                  setApiKey("");
                  void run(() => api.setOpencodeGateway({ gateway: value }));
                }}
                options={GATEWAY_OPTIONS}
              />
            }
          />
          {hint ? (
            <SettingRow
              label={`${name} API key`}
              description={`Saved in your Keychain · key ${hint}`}
              control={
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => void run(() => api.clearOpencodeGatewayKey({ gateway }))}
                >
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
                label={`${name} API key`}
                description="Optional. Without one, OpenCode uses the key from opencode auth login. Saved in your Keychain."
                htmlFor={inputId}
                control={
                  <>
                    <input
                      id={inputId}
                      className="settings-text-input settings-key-input"
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
        </>
      ) : null}
      {error ? (
        <SettingNote tone="warn" role="alert">
          {error}
        </SettingNote>
      ) : null}
    </SettingGroup>
  );
}
