export type SettingsGroupId =
  | "general"
  | "appearance"
  | "agents"
  | "projects"
  | "integrations"
  | "advanced";

type SettingsSectionMeta = { id: string; label: string };

export type SettingsGroupMeta = {
  id: SettingsGroupId;
  label: string;
  /** Renders a hairline above this entry in the rail. Advanced is the only
   *  group that is not part of everyday configuration, so it sits apart. */
  dividerBefore?: boolean;
  sections: ReadonlyArray<SettingsSectionMeta>;
};

export const SETTINGS_GROUPS: ReadonlyArray<SettingsGroupMeta> = [
  {
    id: "general",
    label: "General",
    sections: [
      { id: "settings-startup", label: "Startup" },
      { id: "settings-handoff", label: "Handoff" }
    ]
  },
  {
    id: "appearance",
    label: "Appearance",
    sections: [
      { id: "settings-theme", label: "Theme" },
      { id: "settings-typography", label: "Typography" },
      { id: "settings-layout", label: "Layout" }
    ]
  },
  {
    id: "agents",
    label: "Agents",
    sections: [
      { id: "settings-agent-defaults", label: "Defaults" },
      { id: "settings-permissions", label: "Permissions" },
      { id: "settings-conversation", label: "Conversation" },
      { id: "settings-providers", label: "Providers" },
      { id: "settings-session-sync", label: "Session sync" }
    ]
  },
  {
    id: "projects",
    label: "Projects",
    sections: [{ id: "settings-project-config", label: "Project settings" }]
  },
  {
    id: "integrations",
    label: "Integrations",
    sections: [
      { id: "settings-mcp", label: "MCP servers" },
      { id: "settings-remote", label: "Remote access" }
    ]
  },
  {
    id: "advanced",
    label: "Advanced",
    dividerBefore: true,
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
