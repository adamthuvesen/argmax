import { ChevronDown } from "lucide-react";
import { useRef, useState, type JSX, type ReactNode } from "react";
import type { DiagnosticsReport } from "../../../shared/types.js";
import { ACCENT_OPTIONS, type AccentId } from "../../lib/accent.js";
import { FONT_OPTIONS, type FontFamilyId, type FontOption } from "../../lib/fonts.js";
import { THEME_OPTIONS, type ThemeMode } from "../../lib/theme.js";
import { readFirstContentMeasure } from "../../lib/paintTimings.js";
import { useDismissOnOutsideOrEscape } from "../../hooks/useDismissOnOutsideOrEscape.js";
import {
  SETTINGS_GROUPS,
  type SettingsGroupId,
  type SettingsGroupMeta,
  sectionNumber,
  settingsGroupById
} from "./settingsMeta.js";

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
      <span className="settings-coldstart-budget">
        (budget: {COLD_START_BUDGET_MS} ms)
      </span>
      <span className="settings-coldstart-status" role="img" aria-hidden="true">
        {overBudget ? "⚠" : "✓"}
      </span>
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

export function SettingsGroupIntro({ group }: { group: SettingsGroupMeta }): JSX.Element {
  return (
    <section className="settings-group-intro" aria-labelledby="settings-group-heading">
      <div>
        <p className="settings-group-eyebrow">
          <span className="settings-group-eyebrow-mark" aria-hidden="true" />
          {group.eyebrow}
        </p>
        <h2 id="settings-group-heading">{group.title}</h2>
        <p>{group.description}</p>
      </div>
      <ol className="settings-group-map" aria-label={`${group.label} settings in this group`}>
        {group.sections.map((section, index) => (
          <li key={section.id}>
            <span>{sectionNumber(index)}</span>
            <span>{section.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function SettingsNav({
  active,
  onChange
}: {
  active: SettingsGroupId;
  onChange: (group: SettingsGroupId) => void;
}): JSX.Element {
  return (
    <aside className="settings-nav" aria-label="Settings groups">
      <p className="settings-nav-eyebrow">Settings</p>
      <ol className="settings-nav-list">
        {SETTINGS_GROUPS.map((group, index) => {
          const isActive = group.id === active;
          return (
            <li key={group.id} className="settings-nav-item" data-active={isActive ? "true" : "false"}>
              <button
                type="button"
                className="settings-nav-link"
                aria-pressed={isActive}
                onClick={() => onChange(group.id)}
              >
                <span className="settings-nav-num">{sectionNumber(index)}</span>
                <span className="settings-nav-rule" aria-hidden="true" />
                <span className="settings-nav-copy">
                  <span className="settings-nav-label">{group.label}</span>
                  <span className="settings-nav-note">{group.railNote}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="settings-nav-foot">
        <span>{settingsGroupById(active).sections.length} sections · instant save</span>
      </p>
    </aside>
  );
}

export function SectionHeader({
  index,
  id,
  eyebrow,
  title,
  description,
  action
}: {
  index: number;
  id: string;
  eyebrow: string;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <header className="settings-section-header">
      <span className="settings-section-marker" aria-hidden="true">{sectionNumber(index)}</span>
      <div className="settings-section-titles">
        <p className="settings-section-eyebrow">{eyebrow}</p>
        <h2 id={id}>{title}</h2>
        <p className="settings-section-desc">{description}</p>
      </div>
      {action ? <div className="settings-section-action">{action}</div> : null}
    </header>
  );
}

export function KeyValueList({ rows }: { rows: ReadonlyArray<{ dt: string; dd: ReactNode }> }): JSX.Element {
  return (
    <dl className="settings-keyvals">
      {rows.map((row) => (
        <div key={row.dt}>
          <dt>{row.dt}</dt>
          <dd>{row.dd}</dd>
        </div>
      ))}
    </dl>
  );
}

type SegmentedOption = { value: string; label: string; caption?: string };

export function Segmented({
  legend,
  name,
  value,
  onChange,
  options
}: {
  legend: string;
  name: string;
  value: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<SegmentedOption>;
}): JSX.Element {
  return (
    <div className="settings-segmented" role="radiogroup" aria-label={legend}>
      <span className="settings-segmented-legend">{legend}</span>
      <div className="settings-segmented-track" data-count={options.length}>
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className="settings-segmented-option"
              data-checked={checked ? "true" : "false"}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
              />
              <span className="settings-segmented-label">{option.label}</span>
              {option.caption ? (
                <span className="settings-segmented-caption">{option.caption}</span>
              ) : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  onChange
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <label className="settings-checkbox-row settings-toggle-row">
      <div className="settings-toggle-text">
        <span className="settings-toggle-label">{label}</span>
        {description ? <span className="settings-toggle-desc">{description}</span> : null}
      </div>
      <span className="settings-toggle">
        <input
          type="checkbox"
          aria-label={label}
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="settings-toggle-track" aria-hidden="true">
          <span className="settings-toggle-thumb" />
        </span>
      </span>
    </label>
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
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsideOrEscape(anchorRef, open, () => setOpen(false));
  const selected: FontOption = FONT_OPTIONS.find((o) => o.id === value) ?? FONT_OPTIONS[0];

  return (
    <div className="settings-picker" ref={anchorRef}>
      <button
        type="button"
        id={inputId}
        className="settings-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Font family"
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ fontFamily: selected.stack }}>{selected.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <ul
          className="project-picker-popover settings-picker-popover"
          role="listbox"
          aria-label="Font family"
          onClick={(event) => {
            if (!(event.target instanceof Element && event.target.closest("button.project-picker-item"))) {
              setOpen(false);
            }
          }}
        >
          {FONT_OPTIONS.map((option) => {
            const isSelected = option.id === value;
            return (
              <li key={option.id} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  className="project-picker-item"
                  aria-pressed={isSelected}
                  style={{ fontFamily: option.stack }}
                  onClick={() => {
                    onChange(option.id);
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

/**
 * Three-chip Light / Dark / System picker. Each chip carries a tiny live
 * preview: a 28×18 swatch showing that mode's --bg / --text / --sage values,
 * so the user sees what they're picking before they pick it. The System chip
 * splits its swatch diagonally — half light, half dark — to advertise that
 * it tracks the OS.
 */
export function ThemePicker({
  value,
  onChange,
  inputId
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  inputId?: string;
}): JSX.Element {
  return (
    <div className="theme-picker" role="radiogroup" aria-label="Theme" id={inputId}>
      {THEME_OPTIONS.map((option) => {
        const isSelected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            className="theme-picker-chip"
            role="radio"
            aria-checked={isSelected}
            aria-label={option.label}
            data-theme-mode={option.id}
            data-selected={isSelected || undefined}
            title={option.hint}
            onClick={() => onChange(option.id)}
          >
            <span className="theme-picker-swatch" aria-hidden="true">
              <span className="theme-picker-swatch-bg" />
              <span className="theme-picker-swatch-text" />
              <span className="theme-picker-swatch-accent" />
            </span>
            <span className="theme-picker-label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function AccentPicker({
  value,
  onChange,
  inputId
}: {
  value: AccentId;
  onChange: (accentId: AccentId) => void;
  inputId?: string;
}): JSX.Element {
  return (
    <div className="accent-picker" role="radiogroup" aria-label="Accent" id={inputId}>
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
            title={option.hint}
            onClick={() => onChange(option.id)}
          >
            <span className="accent-picker-swatch" aria-hidden="true" />
            <span className="theme-picker-label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
