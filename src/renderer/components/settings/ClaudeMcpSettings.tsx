import { useState, type JSX } from "react";
import { settingsActions } from "../../data/bridgeActions.js";
import { useBridgeQuery } from "../../data/useBridgeQuery.js";
import { errorMessage } from "../../../shared/error.js";
import type * as Bindings from "../../../shared/bindings.js";
import { LoadingLine } from "../LoadingLine.js";
import { WorkingNest } from "../WorkingNest.js";
import { SettingGroup, SettingNote, SettingRow, Toggle } from "./settingsPrimitives.js";

type ClaudeMcpPreset = Bindings.ClaudeMcpPreset;

const PRESETS: ReadonlyArray<{ value: ClaudeMcpPreset; label: string; description: string }> = [
  {
    value: "everything",
    label: "Everything",
    description: "Claude's default: your servers, plugin servers, and claude.ai connectors.",
  },
  {
    value: "without-connectors",
    label: "Without claude.ai connectors",
    description: "Your servers and plugin servers.",
  },
  {
    value: "your-servers",
    label: "Your servers only",
    description: "Argmax and the servers in your Claude config, plus a checkout's .mcp.json.",
  },
  {
    value: "argmax-only",
    label: "Argmax tools only",
    description: "Only Argmax's own tools.",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Argmax and the servers you pick.",
  },
];

/** The `argmax` server, which every preset starts. */
const ARGMAX_SERVERS = 1;

const PROBE_FAILED_TITLE =
  "claude mcp list did not answer, so connectors and plugin servers were not counted";

function serverCount(count: number): string {
  return count === 1 ? "1 server" : `${count} servers`;
}

/**
 * How many servers each preset starts. Everything and Without connectors need
 * `claude mcp list`, so they read `null` until that probe answers.
 */
function presetCounts(
  settings: Bindings.ClaudeMcpSettings,
  probe: Bindings.ClaudeProbeCounts | null,
): Record<ClaudeMcpPreset, number | null> {
  const enabled = settings.ownServers.filter((server) => server.enabled);
  const own = enabled.length;
  const custom = enabled.filter((server) => settings.customServers.includes(server.name)).length;
  return {
    everything: probe
      ? ARGMAX_SERVERS +
        own +
        probe.connectors +
        probe.pluginServers -
        probe.pluginServersAtConnectorUrls
      : null,
    "without-connectors": probe ? ARGMAX_SERVERS + own + probe.pluginServers : null,
    "your-servers": ARGMAX_SERVERS + own,
    "argmax-only": ARGMAX_SERVERS,
    custom: ARGMAX_SERVERS + custom,
  };
}

/**
 * Settings → Agents → Claude: which MCP servers a Claude turn starts. Every
 * server Claude starts delays the turn, so the presets trade tools for a
 * faster start. Claude only; the launcher resolves the preset at each launch.
 *
 * `readiness` is where a measured "Claude ready in X s" per preset can go
 * beside each count. Nothing passes it yet.
 */
export function ClaudeMcpSettings({
  readiness,
}: {
  readiness?: Partial<Record<ClaudeMcpPreset, string>>;
}): JSX.Element | null {
  const [error, setError] = useState<string | null>(null);
  const settings = useBridgeQuery({
    key: ["settings.claudeMcp"],
    read: (api) => api.settings?.claudeMcp(),
    onError: (loadError) => setError(errorMessage(loadError)),
  });
  const probe = useBridgeQuery({
    key: ["settings.claudeMcpProbe"],
    read: (api) => api.settings?.claudeMcpProbe(),
  });

  const current = settings.data;
  const api = settingsActions();

  const save = async (input: Bindings.SetClaudeMcpInput): Promise<void> => {
    if (!api || !current) return;
    const previous = current;
    setError(null);
    settings.setData(() => ({ ...previous, ...input }));
    try {
      const saved = await api.setClaudeMcp(input);
      settings.setData(() => saved);
    } catch (saveError) {
      settings.setData(() => previous);
      setError(errorMessage(saveError));
    }
  };

  // Without a host there is no launcher to configure, as in the demo.
  if (!settings.isAvailable || !api) return null;
  if (!current) {
    return (
      <SettingGroup id="settings-claude" label="Claude">
        {error ? (
          <SettingNote tone="warn" role="alert">
            {error}
          </SettingNote>
        ) : (
          <LoadingLine label="Reading your Claude MCP config" />
        )}
      </SettingGroup>
    );
  }

  const counts = presetCounts(current, probe.data);
  const ownNames = new Set(current.ownServers.map((server) => server.name));
  const missing = current.customServers.filter((name) => !ownNames.has(name));
  const setCustom = (name: string, on: boolean): void => {
    const others = current.customServers.filter((entry) => entry !== name);
    void save({ preset: "custom", customServers: on ? [...others, name] : others });
  };

  return (
    <SettingGroup id="settings-claude" label="Claude">
      <SettingNote>
        <strong className="settings-choice-heading">MCP at turn start</strong> Each server Claude
        starts adds to the wait before a turn begins. Applies from each Claude chat's next turn.
      </SettingNote>
      <div className="settings-choice-list" role="radiogroup" aria-label="MCP at turn start">
        {PRESETS.map((preset) => {
          const count = counts[preset.value];
          const ready = readiness?.[preset.value];
          const countText = count !== null ? serverCount(count) : "Count unknown";
          return (
            <label
              key={preset.value}
              className="settings-row settings-choice"
              data-checked={preset.value === current.preset ? "true" : "false"}
            >
              <input
                type="radio"
                name="claude-mcp-preset"
                value={preset.value}
                checked={preset.value === current.preset}
                onChange={() =>
                  void save({ preset: preset.value, customServers: current.customServers })
                }
              />
              <span className="settings-row-text">
                <span className="settings-row-label">{preset.label}</span>
                <span className="settings-row-desc">{preset.description}</span>
              </span>
              {count === null && probe.isLoading ? (
                <span className="settings-choice-meta" aria-label="Counting servers">
                  <WorkingNest active size={11} />
                </span>
              ) : (
                <span
                  className="settings-choice-meta"
                  title={count === null ? PROBE_FAILED_TITLE : undefined}
                >
                  {ready ? `${countText} · ${ready}` : countText}
                </span>
              )}
            </label>
          );
        })}
      </div>
      {current.preset === "custom" ? (
        <div className="settings-choice-servers" role="group" aria-label="Custom servers">
          {current.ownServers.map((server) => (
            <SettingRow
              key={server.name}
              label={<span className="settings-row-code">{server.name}</span>}
              description={server.enabled ? undefined : "Disabled in your Claude config"}
              control={
                <Toggle
                  ariaLabel={`Start ${server.name}`}
                  checked={current.customServers.includes(server.name)}
                  disabled={!server.enabled}
                  onChange={(on) => setCustom(server.name, on)}
                />
              }
            />
          ))}
          {missing.map((name) => (
            <SettingRow
              key={name}
              label={<span className="settings-row-code">{name}</span>}
              description={
                <span className="settings-choice-missing">
                  Not in your Claude config, so launches skip it.
                </span>
              }
              control={
                <Toggle
                  ariaLabel={`Start ${name}`}
                  checked
                  onChange={() => setCustom(name, false)}
                />
              }
            />
          ))}
          {current.ownServers.length === 0 && missing.length === 0 ? (
            <SettingNote>No servers in ~/.claude.json to pick from.</SettingNote>
          ) : null}
        </div>
      ) : null}
      <SettingNote>
        Your servers, Argmax tools, and Custom leave plugin servers and claude.ai connectors off:
        Claude keeps them outside the config files Argmax can pass on.
      </SettingNote>
      {error ? (
        <SettingNote tone="warn" role="alert">
          {error}
        </SettingNote>
      ) : null}
    </SettingGroup>
  );
}
