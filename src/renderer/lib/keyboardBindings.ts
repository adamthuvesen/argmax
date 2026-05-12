export interface KeyBinding {
  accelerator: string;
  label: string;
}

export const KEYBOARD_BINDINGS: KeyBinding[] = [
  { accelerator: "⌘K", label: "Open command palette" },
  { accelerator: "⌘,", label: "Open Settings" },
  { accelerator: "⌘N", label: "New session" },
  { accelerator: "⌘1 – ⌘9", label: "Jump to session 1–9" },
  { accelerator: "⌘B", label: "Toggle sidebar" },
  { accelerator: "⌘⇧D", label: "Toggle debug log" },
  { accelerator: "⌘/", label: "Show keyboard shortcuts" },
  { accelerator: "Esc", label: "Close the topmost overlay" }
];
