export type SettingsGroupId =
  | "general"
  | "appearance"
  | "agents"
  | "projects"
  | "integrations"
  | "advanced";

type SettingsSectionMeta = {
  id: string;
  label: string;
  /** Row labels inside the section, so a search for "Fast mode" lands on
   *  Defaults. Keep in step with the panel when a row is added or renamed. */
  settings?: ReadonlyArray<string>;
};

type SettingsGroupMeta = {
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
      {
        id: "settings-startup",
        label: "Startup",
        settings: [
          "New chat",
          "Follow-up while agent works",
          "Random icon for new chats",
          "Escape stops a running chat"
        ]
      },
      {
        id: "settings-notifications",
        label: "Notifications",
        settings: [
          "Notify when agent finishes",
          "Test notification"
        ]
      },
      { id: "settings-power", label: "Power", settings: ["Keep computer awake"] },
      { id: "settings-handoff", label: "Handoff", settings: ["Default IDE", "Web links from chat"] }
    ]
  },
  {
    id: "appearance",
    label: "Appearance",
    sections: [
      {
        id: "settings-theme",
        label: "Theme",
        settings: [
          "Browser theme",
          "Background intensity",
          "Sidebar intensity",
          "Accent",
          "Activity icons",
          "Activity mark",
          "Running row underline",
          "Your message bubbles"
        ]
      },
      {
        id: "settings-typography",
        label: "Typography",
        settings: [
          "Font family",
          "App font size",
          "Agent window font size",
          "Font heaviness",
          "Ink strength"
        ]
      },
      {
        id: "settings-layout",
        label: "Layout",
        settings: [
          "Chat width",
          "Files panel side",
          "Show arcs",
          "Show archived chats",
          "Priority section in sidebar",
          "Translucent window",
          "Window translucency",
          "Workspace card in agent view",
          "Fox mascot",
          "Context indicator in composer",
          "Celebrate PR milestones"
        ]
      }
    ]
  },
  {
    id: "agents",
    label: "Agents",
    sections: [
      {
        id: "settings-agent-defaults",
        label: "Defaults",
        settings: [
          "Default model",
          "Default effort",
          "Fast mode"
        ]
      },
      { id: "settings-auto-routing", label: "Model router", settings: ["Jev API key"] },
      { id: "settings-permissions", label: "Permissions", settings: ["Tool permissions"] },
      { id: "settings-tools", label: "Tools", settings: ["Browser tools"] },
      {
        id: "settings-conversation",
        label: "Conversation",
        settings: [
          "Chat detail & verbosity",
          "Changed files expanded",
          "Goals",
          "Turns a goal may spend",
          "Revert to a turn"
        ]
      },
      { id: "settings-providers", label: "Providers", settings: ["Refresh provider discovery"] },
      { id: "settings-session-sync", label: "Chat sync", settings: ["How far back"] }
    ]
  },
  {
    id: "projects",
    label: "Projects",
    sections: [
      {
        id: "settings-project-config",
        label: "Project settings",
        settings: [
          "Worktree location",
          "Setup command",
          "Check commands",
          "Archive a workspace when its PR merges"
        ]
      },
      { id: "settings-project-sources", label: "Project sources" }
    ]
  },
  {
    id: "integrations",
    label: "Integrations",
    sections: [
      { id: "settings-engram", label: "Engram", settings: ["Install Engram", "Engram agent"] },
      { id: "settings-mcp", label: "Connections", settings: ["Connection provider"] },
      {
        id: "settings-remote",
        label: "Remote access",
        settings: [
          "Phone remote",
          "Pairing QR code",
          "Pairing link",
          "Tailscale proxy",
          "Port",
          "ntfy topic",
          "APNs key file",
          "Paired phones"
        ]
      }
    ]
  },
  {
    id: "advanced",
    label: "Advanced",
    dividerBefore: true,
    sections: [
      { id: "settings-chat-history", label: "Chat history", settings: ["Delete chats older than 7 days"] },
      { id: "settings-knowledge", label: "Project knowledge" },
      {
        id: "settings-diagnostics",
        label: "Diagnostics",
        settings: [
          "Copy diagnostics",
          "Reveal database file",
          "Compact database",
          "Archived workspaces",
          "Save log file",
          "Performance",
          "Developer tools"
        ]
      },
      { id: "settings-about", label: "About", settings: ["Version", "Source and issues"] }
    ]
  }
];

export const DEFAULT_SETTINGS_GROUP = SETTINGS_GROUPS[0];

export function settingsGroupById(id: SettingsGroupId): SettingsGroupMeta {
  return SETTINGS_GROUPS.find((group) => group.id === id) ?? DEFAULT_SETTINGS_GROUP;
}
