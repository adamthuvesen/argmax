export type AccentId = "green" | "mascot-purple" | "neutral" | "anthropic-orange" | "codex-blue";

export type AccentOption = {
  id: AccentId;
  label: string;
  hint: string;
  swatch: {
    color: string;
    soft: string;
  };
};

export const ACCENT_STORAGE_KEY = "argmax.accent.tint";
export const DEFAULT_ACCENT_ID: AccentId = "green";

export const ACCENT_OPTIONS: AccentOption[] = [
  {
    id: "green",
    label: "Green",
    hint: "The original Argmax tint. Code additions and status greens stay semantic either way.",
    swatch: { color: "#5a8f72", soft: "#e7efe7" }
  },
  {
    id: "mascot-purple",
    label: "Mascot purple",
    hint: "A soft purple accent for chrome, inspired by the mascot.",
    swatch: { color: "#8f63d9", soft: "#eee7fb" }
  },
  {
    id: "neutral",
    label: "Neutral",
    hint: "A quiet black/gray tint for the lowest-key interface.",
    swatch: { color: "#2f2f2b", soft: "#ededeb" }
  },
  {
    id: "anthropic-orange",
    label: "Anthropic orange",
    hint: "A warm orange accent for chrome without changing warnings or diffs.",
    swatch: { color: "#c77d3a", soft: "#f6eadc" }
  },
  {
    id: "codex-blue",
    label: "Codex blue",
    hint: "A cool blue accent for selection, focus, and transcript chrome.",
    swatch: { color: "#3f7ecb", soft: "#e5eef9" }
  }
];

const ACCENT_IDS = new Set<AccentId>(ACCENT_OPTIONS.map((option) => option.id));

export function readStoredAccent(): AccentId {
  if (typeof window === "undefined") return DEFAULT_ACCENT_ID;
  const stored = window.localStorage.getItem(ACCENT_STORAGE_KEY);
  return ACCENT_IDS.has(stored as AccentId) ? (stored as AccentId) : DEFAULT_ACCENT_ID;
}

export function writeStoredAccent(accentId: AccentId): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ACCENT_STORAGE_KEY, accentId);
}

export function applyAccentToDocument(accentId: AccentId): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.accent = accentId;
}
