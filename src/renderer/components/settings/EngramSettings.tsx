import { Check, Copy, ExternalLink } from "lucide-react";
import { useState, type JSX } from "react";
import { PROVIDER_DISPLAY_NAMES } from "../../../shared/providerModels.js";
import type { ProviderId } from "../../../shared/types.js";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";
import { engramDirectoryError, engramSetup } from "../../lib/engramSetup.js";
import { PROVIDER_SETUP_ORDER } from "../../lib/providerSetup.js";
import { WebLink } from "../WebLink.js";
import { SettingGroup, SettingNote, SettingRow, SettingsListPicker } from "./settingsPrimitives.js";

export function EngramSettings({
  provider,
  onProviderChange
}: {
  provider: ProviderId;
  onProviderChange: (provider: ProviderId) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [directory, setDirectory] = useState("");
  const error = engramDirectoryError(directory);
  const setup = error === null ? engramSetup(provider, directory) : null;

  return (
    <SettingGroup id="settings-engram" label="Engram">
      <SettingRow
        label="Optional project memory"
        description="Share memories across coding agents with Engram, an open-source tool you install separately. Argmax works without it."
        control={
          <button
            type="button"
            className="settings-button"
            aria-expanded={expanded}
            aria-controls="settings-engram-setup"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Hide setup" : "Set up Engram"}
          </button>
        }
      />
      {expanded ? (
        <div id="settings-engram-setup">
          <SettingRow
            label="1. Install Engram"
            description="Follow the Engram guide to install it with uv and configure its model credentials."
            control={
              <WebLink
                className="settings-button"
                href="https://github.com/adamthuvesen/engram#run-it"
              >
                Installation guide <ExternalLink size={13} aria-hidden="true" />
              </WebLink>
            }
          />
          <SettingRow
            label="2. Choose an agent"
            htmlFor="settings-engram-provider"
            description="Connect each agent you want to use with the same Engram installation."
            control={
              <SettingsListPicker
                ariaLabel="Engram agent"
                inputId="settings-engram-provider"
                value={provider}
                onChange={onProviderChange}
                options={PROVIDER_SETUP_ORDER.map((value) => ({
                  value,
                  label: PROVIDER_DISPLAY_NAMES[value]
                }))}
              />
            }
          />
          <div className="settings-engram-fields">
            <div className="settings-field">
              <label className="settings-field-label" htmlFor="settings-engram-directory">
                Engram installation folder
              </label>
              <input
                id="settings-engram-directory"
                className="settings-text-input"
                placeholder="/absolute/path/to/engram"
                value={directory}
                onChange={(event) => setDirectory(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={directory.length > 0 && error !== null}
                aria-describedby="settings-engram-directory-help"
              />
              <p className="settings-note" id="settings-engram-directory-help">
                {directory.length > 0 && error !== null
                  ? error
                  : "The full path to your Engram clone, not the project you are working on."}
              </p>
            </div>
            {setup ? (
              <div className="settings-field">
                <label className="settings-field-label" htmlFor="settings-engram-command">
                  3. Connect {PROVIDER_DISPLAY_NAMES[provider]}
                </label>
                <textarea
                  id="settings-engram-command"
                  className="settings-text-input settings-textarea"
                  readOnly
                  spellCheck={false}
                  value={setup.content}
                  rows={setup.kind === "json" ? 10 : 3}
                  aria-describedby="settings-engram-command-help"
                />
                <p className="settings-note" id="settings-engram-command-help">{setup.instructions}</p>
                <div className="settings-form-footer">
                  <CopySetup key={setup.content} content={setup.content} kind={setup.kind} />
                </div>
              </div>
            ) : null}
          </div>
          <SettingNote>
            Engram is used when an agent calls its memory tools. Ask it to recall this project’s
            relevant memories and verify changeable facts against current code or sources.
            Manage or remove the connection in the agent’s own MCP settings.
          </SettingNote>
        </div>
      ) : null}
    </SettingGroup>
  );
}

function CopySetup({ content, kind }: { content: string; kind: "command" | "json" }): JSX.Element {
  const [flash, copy] = useCopyToClipboard();
  return (
    <button
      type="button"
      className="settings-button"
      aria-label={`Copy Engram ${kind === "json" ? "configuration" : "command"}`}
      onClick={() => void copy(content)}
    >
      {flash === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      {flash === "copied" ? "Copied" : flash === "failed" ? "Couldn’t copy" : "Copy"}
    </button>
  );
}
