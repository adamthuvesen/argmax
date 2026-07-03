import { vi } from "vitest";

// CodeMirror leans on browser layout APIs jsdom does not implement. Exercise the
// React contract (dirty marker, stale banner, callback wiring) with a textarea.
vi.mock("@uiw/react-codemirror", () => ({
  default: ({
    value,
    onChange,
    readOnly,
    "aria-label": ariaLabel
  }: {
    value: string;
    onChange: (next: string) => void;
    readOnly?: boolean;
    "aria-label"?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      data-readonly={readOnly ? "true" : "false"}
      readOnly={readOnly}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}));
