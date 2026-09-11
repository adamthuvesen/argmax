export type AccentId =
  | "green"
  | "purple"
  | "neutral"
  | "black"
  | "orange"
  | "blue"
  | "coral";

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
    swatch: { color: "#70558f", soft: "#eee9f3" }
  },
  {
    id: "neutral",
    label: "Neutral",
    hint: "A quiet black/gray tint for the lowest-key interface.",
    swatch: { color: "#2f2f2b", soft: "#ededeb" }
  },
  {
    id: "black",
    label: "Black",
    hint: "High-contrast ink. Black on paper, cream on charcoal.",
    swatch: { color: "#1c1b18", soft: "#ecebea" }
  },
  {
    id: "orange",
    label: "Orange",
    hint: "A warm orange accent for chrome without changing warnings or diffs.",
    swatch: { color: "#b15810", soft: "#fff0e2" }
  },
  {
    id: "blue",
    label: "Blue",
    hint: "A cool blue accent for selection, focus, and transcript chrome.",
    swatch: { color: "#446b95", soft: "#e8eef5" }
  },
  {
    id: "coral",
    label: "Coral",
    hint: "A warm red accent for chrome. Error states keep their own rose tint.",
    swatch: { color: "#a35450", soft: "#f6eae8" }
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
