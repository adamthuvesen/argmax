import { ArrowLeft, Check } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { useAnchoredPopover, type AnchorPoint } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import {
  DEFAULT_SESSION_ICON_COLOR,
  SESSION_ICON_COLORS,
  SESSION_ICON_NAMES,
  SESSION_ICONS,
  resolveSessionIconColor,
  sessionIconColorLabel,
  sessionIconLabel
} from "../lib/sessionIcons.js";

type SessionIconPickerProps = {
  icon: string | null;
  iconColor: string | null;
  /** Where the right-click that opened it landed, in viewport coordinates. */
  anchorPoint: AnchorPoint;
  /** Both null clears the custom glyph and restores the status marker. */
  onApply: (icon: string | null, iconColor: string | null) => void;
  onClose: () => void;
};

/**
 * Edit Icon popover for a session row: color swatches, a search field, and the
 * curated icon grid. Picking a color live-updates a row that already has an
 * icon; picking an icon applies it with the selected color and closes.
 */
export function SessionIconPicker({
  icon,
  iconColor,
  anchorPoint,
  onApply,
  onClose
}: SessionIconPickerProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [draftColor, setDraftColor] = useState(() => resolveSessionIconColor(iconColor));
  const panel = useAnchoredPopover({ open: true, gutter: 0, capHeight: true });
  const { anchorToPoint } = panel;
  useDismissOnOutsideOrEscape(panel.popoverRef, true, onClose);

  useEffect(() => {
    anchorToPoint(anchorPoint);
  }, [anchorToPoint, anchorPoint]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return SESSION_ICON_NAMES;
    return SESSION_ICON_NAMES.filter((name) =>
      sessionIconLabel(name).toLowerCase().includes(needle)
    );
  }, [query]);

  const selectColor = (color: string): void => {
    setDraftColor(color);
    // A row that already carries an icon recolors immediately, so the swatch
    // row doubles as a live preview.
    if (icon) onApply(icon, color);
  };

  return (
    <div
      ref={panel.setPopover}
      className="session-icon-picker"
      role="dialog"
      aria-label="Edit Icon"
      style={panel.floatingStyles}
    >
      <div className="session-icon-picker-header">
        <button
          type="button"
          className="session-icon-picker-back"
          aria-label="Close icon picker"
          onClick={onClose}
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <span className="session-icon-picker-title">Edit Icon</span>
      </div>

      <div className="session-icon-swatches" role="group" aria-label="Icon color">
        <button
          type="button"
          className="session-icon-swatch"
          data-swatch="default"
          aria-label="Default icon"
          aria-pressed={icon === null}
          title="Default icon"
          onClick={() => onApply(null, null)}
        >
          {icon === null ? <Check size={12} aria-hidden="true" /> : null}
        </button>
        {SESSION_ICON_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className="session-icon-swatch"
            data-icon-color={color}
            aria-label={`${sessionIconColorLabel(color)} icon color`}
            aria-pressed={draftColor === color}
            title={sessionIconColorLabel(color)}
            onClick={() => selectColor(color)}
          >
            {draftColor === color ? <Check size={12} aria-hidden="true" /> : null}
          </button>
        ))}
      </div>

      <input
        className="session-icon-picker-search"
        type="search"
        aria-label="Search icons"
        placeholder="Search icons..."
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="session-icon-grid" role="group" aria-label="Icons">
        {matches.map((name) => {
          const Glyph = SESSION_ICONS[name];
          if (!Glyph) return null;
          const label = sessionIconLabel(name);
          return (
            <button
              key={name}
              type="button"
              className="session-icon-option"
              data-icon-color={icon === name ? draftColor : undefined}
              aria-label={label}
              aria-pressed={icon === name}
              title={label}
              onClick={() => {
                onApply(name, draftColor ?? DEFAULT_SESSION_ICON_COLOR);
                onClose();
              }}
            >
              <Glyph size={15} aria-hidden="true" />
            </button>
          );
        })}
        {matches.length === 0 ? (
          <p className="session-icon-grid-empty">No icons match that search.</p>
        ) : null}
      </div>
    </div>
  );
}
