import { siGithub, siLinear, siNotion, siSnowflake, siVercel } from "simple-icons";

export interface ServerIconLayer {
  path: string;
  /** Fill colour, or null for a black mark that takes the row's text colour
   *  instead of vanishing on the dark theme. */
  fill: string | null;
}

export interface ServerIcon {
  /** Brand name, used as the icon's accessible name. */
  title: string;
  viewBox: string;
  /** Painted in order; a single layer for the monochrome marks. */
  layers: ServerIconLayer[];
}

// Slack's mark is not in Simple Icons 16 (it shipped through 15). The path
// below is that release's, kept here so a Slack call still shows the mark
// people recognise; it identifies a Slack integration, which is what Slack's
// brand guidelines allow it for.
const SLACK: ServerIcon = {
  title: "Slack",
  viewBox: "0 0 24 24",
  layers: [
    {
      fill: "#4A154B",
      path: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
    }
  ]
};

// Google's product marks are multi-coloured, which Simple Icons flattens to a
// single Google-blue silhouette. These are the 2020 marks as Google publishes
// them, used as Google's brand guidelines allow: to identify an integration.
const GOOGLE_DRIVE: ServerIcon = {
  title: "Google Drive",
  viewBox: "0 0 87.3 78",
  layers: [
    { fill: "#0066DA", path: "m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" },
    { fill: "#00AC47", path: "m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" },
    { fill: "#EA4335", path: "m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" },
    { fill: "#00832D", path: "m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" },
    { fill: "#2684FC", path: "m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" },
    { fill: "#FFBA00", path: "m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" }
  ]
};

const GMAIL: ServerIcon = {
  title: "Gmail",
  viewBox: "52 42 88 66",
  layers: [
    { fill: "#4285F4", path: "M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" },
    { fill: "#34A853", path: "M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" },
    { fill: "#FBBC04", path: "M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" },
    { fill: "#EA4335", path: "M72 74V48l24 18 24-18v26L96 92" },
    { fill: "#C5221F", path: "M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" }
  ]
};

// The "31" on the calendar face is dropped: at 12px it is noise, and the
// coloured frame is what identifies the mark.
const GOOGLE_CALENDAR: ServerIcon = {
  title: "Google Calendar",
  viewBox: "-3.75 -3.75 200 200",
  layers: [
    { fill: "#FFFFFF", path: "M148.882 43.618l-47.368-5.263-57.895 5.263L38.355 96.25l5.263 52.632 52.632 6.579 52.632-6.579 5.263-53.947z" },
    { fill: "#EA4335", path: "M148.882 196.25l47.368-47.368-23.684-10.526-23.684 10.526-10.526 23.684z" },
    { fill: "#34A853", path: "M33.092 172.566l10.526 23.684h105.263v-47.368H43.618z" },
    { fill: "#4285F4", path: "M12.039-3.75C3.316-3.75-3.75 3.316-3.75 12.039v136.842l23.684 10.526 23.684-10.526V43.618h105.263l10.526-23.684L148.882-3.75z" },
    { fill: "#188038", path: "M-3.75 148.882v31.579c0 8.724 7.066 15.789 15.789 15.789h31.579v-47.368z" },
    { fill: "#FBBC04", path: "M148.882 43.618v105.263h47.368V43.618l-23.684-10.526z" },
    { fill: "#1967D2", path: "M196.25 43.618V12.039c0-8.724-7.066-15.789-15.789-15.789h-31.579v47.368z" }
  ]
};

function fromSimpleIcon(icon: { title: string; path: string; hex: string }): ServerIcon {
  // Notion, GitHub and Vercel are black marks: no tint carries them on
  // charcoal, so they fall back to currentColor like the words beside them.
  const fill = ["000000", "181717"].includes(icon.hex.toUpperCase()) ? null : `#${icon.hex}`;
  return { title: icon.title, viewBox: "0 0 24 24", layers: [{ path: icon.path, fill }] };
}

// Keyed by the server name `parseMcpToolName` yields, lower-cased: the MCP
// namespace with client prefixes stripped and `-`/`_` turned into spaces.
// Aliases cover the ids connectors actually register under.
const SERVER_ICONS: Record<string, ServerIcon> = {
  slack: SLACK,
  notion: fromSimpleIcon(siNotion),
  "google drive": GOOGLE_DRIVE,
  gdrive: GOOGLE_DRIVE,
  drive: GOOGLE_DRIVE,
  gmail: GMAIL,
  "google calendar": GOOGLE_CALENDAR,
  gcal: GOOGLE_CALENDAR,
  calendar: GOOGLE_CALENDAR,
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
