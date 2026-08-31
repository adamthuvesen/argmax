export type AccentId = "green" | "purple" | "neutral" | "orange" | "blue" | "coral";

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
    swatch: { color: "#446c56", soft: "#e7efe7" }
  },
  {
    id: "purple",
    label: "Purple",
    hint: "A soft purple accent for chrome.",
    swatch: { color: "#613e9a", soft: "#ece4fb" }
  },
  {
    id: "neutral",
    label: "Neutral",
    hint: "A quiet black/gray tint for the lowest-key interface.",
    swatch: { color: "#2f2f2b", soft: "#ededeb" }
  },
  {
    id: "orange",
    label: "Orange",
    hint: "A warm orange accent for chrome without changing warnings or diffs.",
    swatch: { color: "#a85c43", soft: "#f8e9e1" }
  },
  {
    id: "blue",
    label: "Blue",
    hint: "A cool blue accent for selection, focus, and transcript chrome.",
    swatch: { color: "#30609a", soft: "#e5eef9" }
  },
  {
    id: "coral",
    label: "Coral",
    hint: "A hot pink-red accent. Shares a hue with the --rose error token, so risk states read less distinctly.",
    swatch: { color: "#a64354", soft: "#fee6e8" }
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
