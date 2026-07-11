export type SettingsGroupId = "general" | "agents" | "integrations" | "system";
type SettingsSectionMeta = { id: string; label: string };
export type SettingsGroupMeta = {
  id: SettingsGroupId;
  label: string;
  title: string;
  eyebrow: string;
  description: string;
  sections: ReadonlyArray<SettingsSectionMeta>;
};

export const SETTINGS_GROUPS: ReadonlyArray<SettingsGroupMeta> = [
  {
    id: "general",
    label: "General",
    title: "Shape the workspace",
    eyebrow: "Local console",
    description: "The everyday feel of Argmax: identity, typography, launch behavior, and visible session detail.",
    sections: [
      { id: "settings-local", label: "Local profile" },
      { id: "settings-appearance", label: "Appearance" },
      { id: "settings-defaults", label: "Launch defaults" }
    ]
  },
  {
    id: "agents",
    label: "Agents",
    title: "Tune agent behavior",
    eyebrow: "Model sessions",
    description: "Provider defaults, tool-call visibility, and the permission stance every new session starts with.",
    sections: [
      { id: "settings-agent-defaults", label: "Model defaults" },
      { id: "settings-permissions", label: "Permissions" },
      { id: "settings-providers", label: "Providers" }
    ]
  },
  {
    id: "integrations",
    label: "Integrations",
    title: "Connect local tools",
    eyebrow: "Handoffs",
    description: "Editor handoff and setup guidance for provider-managed MCP servers.",
    sections: [
      { id: "settings-tools", label: "Default IDE" },
      { id: "settings-mcp", label: "MCP servers" }
    ]
  },
  {
    id: "system",
    label: "System",
    title: "Inspect the engine room",
    eyebrow: "On-device state",
    description: "Project knowledge, runtime diagnostics, local database health, logs, and app details.",
    sections: [
      { id: "settings-knowledge", label: "Project knowledge" },
      { id: "settings-diagnostics", label: "Diagnostics" },
      { id: "settings-about", label: "About" }
    ]
  }
];

export const DEFAULT_SETTINGS_GROUP = SETTINGS_GROUPS[0];

export function settingsGroupById(id: SettingsGroupId): SettingsGroupMeta {
  return SETTINGS_GROUPS.find((group) => group.id === id) ?? DEFAULT_SETTINGS_GROUP;
}
