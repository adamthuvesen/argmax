import {
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledrive,
  siLinear,
  siNotion,
  siSnowflake,
  siVercel
} from "simple-icons";

export interface ServerIcon {
  /** Brand name, used as the icon's accessible name. */
  title: string;
  /** 24×24 single-path mark. */
  path: string;
  /** Brand colour, or null for marks that are drawn black and so take the
   *  row's text colour instead of vanishing on the dark theme. */
  hex: string | null;
}

// Slack's mark is not in Simple Icons 16 (it shipped through 15). The path
// below is that release's, kept here so a Slack call still shows the mark
// people recognise; it identifies a Slack integration, which is what Slack's
// brand guidelines allow it for, and is never recoloured beyond the row tint.
const SLACK: ServerIcon = {
  title: "Slack",
  hex: "4A154B",
  path: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
};

function fromSimpleIcon(icon: { title: string; path: string; hex: string }): ServerIcon {
  // Notion, GitHub and Vercel are black marks: no tint carries them on
  // charcoal, so they fall back to currentColor like the words beside them.
  const hex = ["000000", "181717"].includes(icon.hex.toUpperCase()) ? null : icon.hex;
  return { title: icon.title, path: icon.path, hex };
}

// Keyed by the server name `parseMcpToolName` yields, lower-cased: the MCP
// namespace with client prefixes stripped and `-`/`_` turned into spaces.
// Aliases cover the ids connectors actually register under.
const SERVER_ICONS: Record<string, ServerIcon> = {
  slack: SLACK,
  notion: fromSimpleIcon(siNotion),
  "google drive": fromSimpleIcon(siGoogledrive),
  gdrive: fromSimpleIcon(siGoogledrive),
  drive: fromSimpleIcon(siGoogledrive),
  gmail: fromSimpleIcon(siGmail),
  "google calendar": fromSimpleIcon(siGooglecalendar),
  gcal: fromSimpleIcon(siGooglecalendar),
  calendar: fromSimpleIcon(siGooglecalendar),
  snowflake: fromSimpleIcon(siSnowflake),
  linear: fromSimpleIcon(siLinear),
  github: fromSimpleIcon(siGithub),
  vercel: fromSimpleIcon(siVercel)
};

/** The brand mark for an MCP server name, or null when none is wired up. */
export function serverIconFor(server: string): ServerIcon | null {
  const key = server.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  return SERVER_ICONS[key] ?? null;
}
