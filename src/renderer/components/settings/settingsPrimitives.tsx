import { ChevronDown } from "lucide-react";
import { useRef, useState, type CSSProperties, type JSX, type ReactNode } from "react";
import type { DiagnosticsReport } from "../../../shared/types.js";
import { ACCENT_OPTIONS, type AccentId } from "../../lib/accent.js";
import { FONT_OPTIONS, type FontFamilyId, type FontOption } from "../../lib/fonts.js";
import { THEME_OPTIONS, type ThemeMode } from "../../lib/theme.js";
import { readFirstContentMeasure } from "../../lib/paintTimings.js";
import { useDismissOnOutsideOrEscape } from "../../hooks/useDismissOnOutsideOrEscape.js";

export const COLD_START_BUDGET_MS = 1500;

export function ColdStartSummary({
  phases
}: {
  phases: DiagnosticsReport["startupPhases"];
}): JSX.Element | null {
  const ready = phases.find((p) => p.phase === "window.ready-to-show");
  if (!ready) return null;
  const overBudget = ready.elapsedMs > COLD_START_BUDGET_MS;
  return (
    <div
      className="settings-coldstart-summary"
      role="status"
      aria-label="Cold start budget summary"
      data-over-budget={overBudget || undefined}
    >
      <span className="settings-coldstart-label">Cold start</span>
      <span className="settings-coldstart-value">{ready.elapsedMs.toFixed(0)} ms</span>
      <span className="settings-coldstart-budget">(budget: {COLD_START_BUDGET_MS} ms)</span>
      {overBudget ? (
        <span className="settings-badge" data-tone="warn">
          over budget
        </span>
      ) : null}
    </div>
  );
}

export function RendererPaintRow(): JSX.Element | null {
  const measureMs = readFirstContentMeasure();
  if (measureMs === null) return null;
  return (
    <tr data-paint-timing="first-content">
      <td>
        <code>renderer.first-content</code>
      </td>
      <td>{measureMs.toFixed(2)} ms</td>
      <td>—</td>
    </tr>
  );
}

/**
 * A labelled block of setting rows. The label is a real heading — a group of
 * settings is a section of the page, and the command palette and the rail both
 * navigate to it by id.
 */
export function SettingGroup({
  id,
  label,
  action,
  card = true,
  children
}: {
  id: string;
  label: string;
  /** Optional control on the group's own line, e.g. a Refresh button. */
  action?: ReactNode;
  /** Set false when the children bring their own surface (a panel, a form). */
  card?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="settings-group" id={id} aria-labelledby={`${id}-h`}>
      <div className="settings-group-head">
        <h3 className="settings-group-label" id={`${id}-h`}>
          {label}
        </h3>
        {action ? <div className="settings-group-action">{action}</div> : null}
      </div>
      {card ? <div className="settings-card">{children}</div> : children}
    </section>
  );
}

/**
 * The one row shape: label, an optional single-line description, and the
 * control on the right. Everything configurable in the app is one of these.
 */
export function SettingRow({
  label,
  description,
  control,
  htmlFor
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  /** Set when the control is a single focusable element with that id. */
  htmlFor?: string;
}): JSX.Element {
  return (
    <div className="settings-row">
      <span className="settings-row-text">
        {/* The label element wraps the label alone: pulling the description
            inside it would fold that sentence into the control's name. */}
        {htmlFor ? (
          <label className="settings-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="settings-row-label">{label}</span>
        )}
        {description ? <span className="settings-row-desc">{description}</span> : null}
      </span>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}

/** A read-only row: label on the left, value on the right. */
export function SettingValueRow({
  label,
  value
}: {
  label: ReactNode;
  value: ReactNode;
}): JSX.Element {
  return <SettingRow label={label} control={<span className="settings-row-value">{value}</span>} />;
}

/** Prose that belongs to the group rather than to any one row. */
export function SettingNote({
  children,
  tone,
  role
}: {
  children: ReactNode;
  tone?: "warn";
  role?: "alert" | "status";
}): JSX.Element {
  return (
    <p className="settings-note" data-tone={tone} role={role}>
      {children}
    </p>
  );
}

export function Toggle({
  ariaLabel,
  checked,
  onChange,
  disabled = false
}: {
  ariaLabel: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <span className="settings-toggle" data-disabled={disabled ? "true" : undefined}>
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="settings-toggle-track" aria-hidden="true">
        <span className="settings-toggle-thumb" />
      </span>
    </span>
  );
}

type SegmentedOption = { value: string; label: string; caption?: string; disabled?: boolean };

export function SegmentedControl({
  ariaLabel,
  name,
  value,
  onChange,
  options,
  disabled = false
}: {
  ariaLabel: string;
  name: string;
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<SegmentedOption>;
  /** Disables the whole control (e.g. a mode that makes this setting moot). */
  disabled?: boolean;
}): JSX.Element {
  return (
    <div
      className="settings-segmented"
      role="radiogroup"
      aria-label={ariaLabel}
      data-count={options.length}
      data-disabled={disabled ? "true" : undefined}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label
            key={option.value}
            className="settings-segmented-option"
            data-checked={checked ? "true" : "false"}
            data-disabled={option.disabled || disabled ? "true" : "false"}
            title={option.caption}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              disabled={option.disabled || disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="settings-segmented-label">{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}

export function Slider({
  ariaLabel,
  min,
  max,
  value,
  valueLabel,
  onChange
}: {
  ariaLabel: string;
  min: number;
  max: number;
  value: number;
  /** Readout beside the slider, e.g. the resulting size in px. */
  valueLabel: string;
  onChange: (next: number) => void;
}): JSX.Element {
  return (
    <div className="settings-slider">
      <input
        type="range"
        aria-label={ariaLabel}
        // The level is an index; the size it produces is the meaningful
        // value, so announce that rather than a bare "6".
        aria-valuetext={valueLabel}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="settings-slider-value">{valueLabel}</span>
    </div>
  );
}

type SettingsListPickerOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
  labelStyle?: CSSProperties;
};

export function SettingsListPicker<T extends string>({
  ariaLabel,
  disabled = false,
  inputId,
  onChange,
  options,
  placement = "below",
  value
}: {
  ariaLabel: string;
  disabled?: boolean;
  inputId?: string;
  onChange: (value: T) => void;
  options: ReadonlyArray<SettingsListPickerOption<T>>;
  /** Set to "above" when the menu would otherwise cover the next group's copy. */
  placement?: "above" | "below";
  value: T;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsideOrEscape(anchorRef, open, () => setOpen(false));
  const selected = options.find((option) => option.value === value) ?? options[0];
  const isOpen = open && !disabled;

  return (
    <div className="settings-picker settings-list-picker" ref={anchorRef}>
      <button
        type="button"
        id={inputId}
        className="settings-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="settings-picker-trigger-label" style={selected?.labelStyle}>
          {selected?.label ?? ""}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {isOpen ? (
        <ul
          className="project-picker-popover settings-picker-popover"
          role="listbox"
          aria-label={ariaLabel}
          data-placement={placement}
          onClick={(event) => {
            if (!(event.target instanceof Element && event.target.closest("button.project-picker-item"))) {
              setOpen(false);
            }
          }}
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
              >
                <button
                  type="button"
                  className="project-picker-item"
                  aria-pressed={isSelected}
                  disabled={option.disabled}
                  title={option.title}
                  style={option.labelStyle}
                  onClick={() => {
                    if (option.disabled) return;
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function FontFamilyPicker({
  value,
  onChange,
  inputId
}: {
  value: FontFamilyId;
  onChange: (id: FontFamilyId) => void;
  inputId?: string;
}): JSX.Element {
  return (
    <SettingsListPicker
      ariaLabel="Font family"
      inputId={inputId}
      value={value}
      onChange={onChange}
      options={FONT_OPTIONS.map((option: FontOption) => ({
        value: option.id,
        label: option.label,
        labelStyle: { fontFamily: option.stack }
      }))}
    />
  );
}

/** System / Light / Dark, on the same segmented control every other
 *  three-way choice on the page uses. */
export function ThemePicker({
  value,
  onChange
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}): JSX.Element {
  return (
    <SegmentedControl
      ariaLabel="Theme"
      name="theme-mode"
      value={value}
      onChange={(next) => {
        const picked = THEME_OPTIONS.find((option) => option.id === next);
        if (picked) onChange(picked.id);
      }}
      options={THEME_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
    />
  );
}

export function AccentPicker({
  value,
  onChange
}: {
  value: AccentId;
  onChange: (accentId: AccentId) => void;
}): JSX.Element {
  return (
    <div className="accent-picker" role="radiogroup" aria-label="Accent">
      {ACCENT_OPTIONS.map((option) => {
        const isSelected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            className="accent-picker-chip"
            role="radio"
            aria-checked={isSelected}
            aria-label={option.label}
            data-accent-id={option.id}
            data-selected={isSelected || undefined}
            title={option.label}
            onClick={() => onChange(option.id)}
          />
        );
      })}
    </div>
  );
}
