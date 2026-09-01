import { ChevronDown, ChevronRight, Zap } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import {
  clampEffort,
  DEFAULT_REASONING_EFFORT,
  PROVIDER_MODELS,
  reasoningEffortsForModel,
  type ProviderModelSelection,
  type ReasoningEffort
} from "../../shared/providerModels.js";
import type { ProviderId } from "../../shared/types.js";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useTypeToFilter } from "../hooks/useTypeToFilter.js";
import { EffortPixelField } from "./EffortPixelField.js";
import { Mascot } from "./Mascot.js";
import { PickerFilterRow } from "./PickerFilterRow.js";
import {
  allModelOptions,
  effortLabel,
  factoryLaunchModel,
  modelSupportsFastMode,
  providerModelKey,
  modelKey,
  type ModelPickerSelection
} from "../lib/models.js";

const PROVIDER_GROUP_LABEL: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode"
};

/** Per-provider install/auth state for picker gating. */
export interface ProviderAvailabilityEntry {
  installed: boolean;
  authenticated: boolean | null;
}

/**
 * Optional availability map keyed by provider. When absent (or a provider is
 * missing), the picker stays optimistic — every model enabled. Discovery is
 * async, so the picker must work before it resolves.
 */
export type ProviderAvailability = Partial<Record<ProviderId, ProviderAvailabilityEntry>>;

/**
 * Resolve a provider to a picker annotation. Not installed → disabled +
 * "not installed". Installed but not authenticated → advisory "needs login"
 * (still selectable, per product decision). Unknown/ready → no annotation.
 */
function availabilityAnnotation(
  availability: ProviderAvailability | undefined,
  provider: ProviderId
): { disabled?: boolean; annotation?: string } {
  const entry = availability?.[provider];
  if (!entry) return {};
  if (!entry.installed) return { disabled: true, annotation: "not installed" };
  if (entry.authenticated === false) return { annotation: "needs login" };
  return {};
}

type ChipModelOption<T> = {
  key: string;
  /** Base model label, without any effort suffix. */
  label: string;
  value: T;
  group?: string;
  supportsReasoningEffort: boolean;
  /** Provider CLI not installed — row is shown disabled. */
  disabled?: boolean;
  /** Small advisory suffix ("not installed" / "needs login"). */
  annotation?: string;
};

export function ModelSelector({
  ariaLabel,
  fastModeEnabled = false,
  onFastModeEnabledChange,
  onChange,
  provider,
  withEffortSlider = false,
  value
}: {
  ariaLabel: string;
  fastModeEnabled?: boolean;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onChange: (model: ProviderModelSelection) => void;
  provider: ProviderId;
  withEffortSlider?: boolean;
  value: ProviderModelSelection;
}): JSX.Element {
  const options: Array<ChipModelOption<ProviderModelSelection>> = PROVIDER_MODELS[provider].map((model) => ({
    key: modelKey(model),
    label: model.label,
    supportsReasoningEffort: Boolean(model.supportsReasoningEffort),
    value: {
      label: model.label,
      modelId: model.modelId,
      ...(model.supportsReasoningEffort ? { reasoningEffort: DEFAULT_REASONING_EFFORT } : {})
    }
  }));

  return (
    <ChipModelPicker
      ariaLabel={ariaLabel}
      fastModeEnabled={fastModeEnabled}
      isSelected={(model) => model.modelId === value.modelId}
      onChange={onChange}
      onFastModeEnabledChange={onFastModeEnabledChange}
      options={options}
      reasoningEffortsForValue={(model) => reasoningEffortsForModel(provider, model.modelId)}
      withEffortSlider={withEffortSlider}
      supportsFastModeForValue={(model) => modelSupportsFastMode({ provider, modelId: model.modelId })}
      value={value}
    />
  );
}

export function LaunchModelSelector({
  ariaLabel,
  anchorClassName,
  align,
  availability,
  fastModeEnabled = false,
  inputId,
  onOpenChange,
  onChange,
  onFastModeEnabledChange,
  open,
  withEffortSlider = false,
  value
}: {
  ariaLabel: string;
  anchorClassName?: string;
  align?: "start" | "end";
  availability?: ProviderAvailability;
  fastModeEnabled?: boolean;
  inputId?: string;
  onOpenChange?: (open: boolean) => void;
  onChange: (model: ModelPickerSelection) => void;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  open?: boolean;
  withEffortSlider?: boolean;
  value: ModelPickerSelection;
}): JSX.Element {
  const options: Array<ChipModelOption<ModelPickerSelection>> = allModelOptions.map((model) => ({
    key: providerModelKey(model),
    label: model.label,
    group: PROVIDER_GROUP_LABEL[model.provider],
    supportsReasoningEffort: model.supportsReasoningEffort,
    ...availabilityAnnotation(availability, model.provider),
    value: {
      provider: model.provider,
      label: model.label,
      modelId: model.modelId,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
    }
  }));

  return (
    <ChipModelPicker
      ariaLabel={ariaLabel}
      anchorClassName={anchorClassName}
      align={align}
      fastModeEnabled={fastModeEnabled}
      inputId={inputId}
      isSelected={(model) => model.provider === value.provider && model.modelId === value.modelId}
      onChange={onChange}
      onFastModeEnabledChange={onFastModeEnabledChange}
      onOpenChange={onOpenChange}
      open={open}
      options={options}
      reasoningEffortsForValue={(model) => reasoningEffortsForModel(model.provider, model.modelId)}
      withEffortSlider={withEffortSlider}
      supportsFastModeForValue={modelSupportsFastMode}
      value={value}
    />
  );
}

function alwaysSupportsFastMode(): boolean {
  return true;
}

type EffortPosStyle = CSSProperties & { "--effort-pos"?: string };

/**
 * Standalone effort control shown beside the model chip: a chip that reads the
 * current effort and opens a slider spanning `efforts`. The list is
 * provider-specific (Claude and Codex Sol/Terra run low→ultra, others stop
 * earlier). The thumb tracks the pointer 1:1 while dragging, then glides to
 * the nearest stop; arrow/Home/End keys step it. role="slider" carries the
 * a11y semantics.
 */
function EffortSlider({
  value,
  efforts,
  onChange,
  ariaLabel
}: {
  value: ReasoningEffort;
  efforts: readonly ReasoningEffort[];
  onChange: (value: ReasoningEffort) => void;
  ariaLabel: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Draft effort while the picker is open. It's committed to the parent only on
  // dismiss, so dragging back and forth doesn't reflow the composer toolbar (the
  // chip that anchors this popover) underneath the cursor.
  const [draft, setDraft] = useState(value);
  const [dragging, setDragging] = useState(false);
  // Anchored like the model flyout beside it, so the two halves of one control
  // open the same way instead of one being hand-positioned in CSS.
  const flyout = useAnchoredPopover({ open, placement: "bottom-start", strategy: "absolute" });
  const trackRef = useRef<HTMLDivElement | null>(null);

  const maxIndex = efforts.length - 1;
  const index = Math.max(0, efforts.indexOf(draft));

  // Continuous thumb position (0..maxIndex). Follows the pointer while dragging;
  // otherwise it snaps to the draft effort and the CSS transition glides it.
  const [pos, setPos] = useState(index);

  const commitAndClose = (): void => {
    setOpen(false);
    setDragging(false);
    if (draft !== value) onChange(draft);
  };
  useDismissOnOutsideOrEscape(flyout.anchorRef, open, commitAndClose);

  useEffect(() => {
    if (!dragging) setPos(index);
  }, [index, dragging]);

  // Suppress page-wide text selection for the duration of a drag — otherwise a
  // drag past the track edge selects the composer text behind the popover.
  useEffect(() => {
    if (!dragging) return undefined;
    document.body.style.setProperty("user-select", "none");
    document.body.style.setProperty("-webkit-user-select", "none");
    return () => {
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("-webkit-user-select");
    };
  }, [dragging]);

  const fraction = maxIndex === 0 ? 0 : pos / maxIndex;

  const selectIndex = (next: number): void => {
    const clamped = Math.min(maxIndex, Math.max(0, next));
    const effort = efforts[clamped];
    if (effort) setDraft(effort);
  };

  const posFromClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return pos;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return pos;
    return Math.min(maxIndex, Math.max(0, ((clientX - rect.left) / rect.width) * maxIndex));
  };

  return (
    <div className="project-picker-anchor effort-slider-anchor" ref={flyout.setAnchor}>
      <button
        type="button"
        className="composer-context-chip effort-slider-chip"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Reasoning effort · ${effortLabel(value)}`}
        onClick={() => {
          if (open) {
            commitAndClose();
          } else {
            setDraft(value);
            setOpen(true);
          }
        }}
      >
        <span className="model-picker-label">{effortLabel(value)}</span>
        <ChevronDown size={11} className="composer-context-caret" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="effort-slider-popover"
          role="dialog"
          aria-label={ariaLabel}
          ref={flyout.setPopover}
          style={flyout.floatingStyles}
        >
          <div className="effort-slider-head">
            <span className="effort-slider-caption">Effort</span>
            <span className="effort-slider-current">{effortLabel(draft)}</span>
          </div>
          <div
            className="effort-slider-track"
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label="Reasoning effort"
            aria-valuemin={0}
            aria-valuemax={maxIndex}
            aria-valuenow={index}
            aria-valuetext={effortLabel(draft)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight" || event.key === "ArrowUp") next = index + 1;
              else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = index - 1;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = maxIndex;
              else return;
              event.preventDefault();
              selectIndex(next);
            }}
            onPointerDown={(event) => {
              event.preventDefault(); // don't anchor a text selection on the press
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
              const next = posFromClientX(event.clientX);
              setPos(next);
              selectIndex(Math.round(next)); // keep the label/aria in step with the thumb
            }}
            onPointerMove={(event) => {
              if (!dragging) return;
              const next = posFromClientX(event.clientX);
              setPos(next);
              selectIndex(Math.round(next));
            }}
            onPointerUp={(event) => {
              if (!dragging) return;
              const next = Math.round(posFromClientX(event.clientX));
              setDragging(false);
              selectIndex(next);
            }}
            onPointerCancel={() => setDragging(false)}
          >
            <div className="effort-slider-fieldclip">
              <EffortPixelField level={fraction} flowRate={fraction} />
            </div>
            <div
              className="effort-slider-thumb"
              data-dragging={dragging || undefined}
              aria-hidden="true"
              style={{ "--effort-pos": String(fraction) } as EffortPosStyle}
            >
              <Mascot mood="idle" size={18} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChipModelPicker<T extends ProviderModelSelection>({
  ariaLabel,
  anchorClassName,
  align = "start",
  fastModeEnabled,
  inputId,
  isSelected,
  onChange,
  onFastModeEnabledChange,
  onOpenChange,
  open: controlledOpen,
  options,
  reasoningEffortsForValue,
  withEffortSlider = false,
  supportsFastModeForValue = alwaysSupportsFastMode,
  value
}: {
  ariaLabel: string;
  anchorClassName?: string;
  /** Which edge the flyout lines up with. Settings hangs its chip off the
   *  right margin, so the menu has to grow leftward from there. */
  align?: "start" | "end";
  fastModeEnabled: boolean;
  inputId?: string;
  isSelected: (value: T) => boolean;
  onChange: (value: T) => void;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  options: Array<ChipModelOption<T>>;
  /** Effort levels for a given value's provider, low → high. Claude and Codex
   *  Sol/Terra run the full low→ultra list; other models stop earlier. */
  reasoningEffortsForValue: (value: T) => readonly ReasoningEffort[];
  /** Show a standalone effort slider beside the chip. Off in settings, which
   *  has no per-session effort control — the model's default effort applies. */
  withEffortSlider?: boolean;
  supportsFastModeForValue?: (value: T) => boolean;
  value: T;
}): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false);
  const [fastModeMenuOpen, setFastModeMenuOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean | ((open: boolean) => boolean)): void => {
    const nextValue = typeof next === "function" ? next(open) : next;
    if (controlledOpen === undefined) {
      setInternalOpen(nextValue);
    }
    if (!nextValue) {
      setFastModeMenuOpen(false);
    }
    onOpenChange?.(nextValue);
  };
  const primaryListRef = useRef<HTMLUListElement | null>(null);

  // Stays inside the anchor rather than portaling to <body>: the composer and
  // settings both style this menu through descendant selectors, and the chip
  // already establishes the stacking context the menu wants. `flip` picks the
  // side — the agent composer sits at the bottom of its pane so the menu opens
  // upward there, while settings has room below.
  const flyout = useAnchoredPopover({
    open,
    placement: align === "end" ? "bottom-end" : "bottom-start",
    strategy: "absolute"
  });
  // The Speed submenu hangs off its own row, so it tracks that row instead of
  // being nudged into place with margins measured against the list.
  const speedMenu = useAnchoredPopover({
    open: fastModeMenuOpen,
    placement: "right-start",
    gutter: 6,
    strategy: "absolute"
  });

  useDismissOnOutsideOrEscape(flyout.anchorRef, open, () => setOpen(false));
  const selectedSupportsFastMode = supportsFastModeForValue(value);
  // Fast mode is surfaced as a submenu the UI labels "Speed" (Standard / Fast);
  // picking "Fast" flips fastModeEnabled. The code below uses the fast-mode name
  // throughout — "Speed" stays only in the visible copy.
  const canChangeFastMode = Boolean(onFastModeEnabledChange) && selectedSupportsFastMode;
  const effectiveFastModeEnabled = fastModeEnabled && selectedSupportsFastMode;

  const selectedOption = options.find((option) => isSelected(option.value));
  // Show the chosen effort whenever the selection carries one. Suppress it when
  // the selected model is known to be fast/no-effort.
  const selectedShowsEffort =
    value.reasoningEffort != null && (selectedOption ? selectedOption.supportsReasoningEffort : true);
  const showEffortSlider = withEffortSlider && selectedShowsEffort && value.reasoningEffort != null;

  const selectionForOption = (option: ChipModelOption<T>): T => {
    // Fast/no-effort models carry no effort. Otherwise the current effort is
    // carried onto the target and clamped to its range (Claude Ultra → Codex
    // Luna becomes Max), never promoted (Codex Extra High → Claude stays Extra
    // High). Falls back to the seeded default when there's none to carry.
    if (!option.supportsReasoningEffort) return option.value;
    const carried = clampEffort(value.reasoningEffort, reasoningEffortsForValue(option.value));
    return { ...option.value, reasoningEffort: carried ?? DEFAULT_REASONING_EFFORT };
  };

  // Typing into the open picker filters the model list through useTypeToFilter.
  const modelFilter = useTypeToFilter({
    open,
    items: options,
    toLabel: (option: ChipModelOption<T>) => option.label,
    listRef: primaryListRef,
    onPick: (option: ChipModelOption<T>) => selectModel(option)
  });

  const selectModel = (option: ChipModelOption<T>): void => {
    // A disabled row (provider CLI not installed) can't be chosen — the button
    // is also disabled, this is just belt-and-suspenders.
    if (option.disabled) return;
    const nextValue = selectionForOption(option);
    onChange(nextValue);
    setOpen(false);
  };

  const setFastMode = (enabled: boolean): void => {
    onFastModeEnabledChange?.(enabled);
    setOpen(false);
  };

  return (
    <div className="model-picker-cluster">
    <div
      className={`project-picker-anchor model-picker-anchor${anchorClassName ? ` ${anchorClassName}` : ""}`}
      ref={flyout.setAnchor}
    >
      <button
        type="button"
        id={inputId}
        className="composer-context-chip"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={effectiveFastModeEnabled ? `${value.label} · Fast speed` : value.label}
        onClick={() => setOpen((o) => !o)}
      >
        {effectiveFastModeEnabled ? (
          <Zap size={14} aria-hidden="true" className="model-picker-speed-icon" />
        ) : null}
        <span className="model-picker-label">{value.label}</span>
        {/* Without the standalone effort chip beside it, the model chip is the
            end of the control and carries the caret itself. */}
        {showEffortSlider ? null : (
          <ChevronDown size={11} className="composer-context-caret" aria-hidden="true" />
        )}
      </button>
      {open && (
        <div
          className="model-picker-flyout"
          ref={flyout.setPopover}
          style={flyout.floatingStyles}
          onClick={(event) => {
            // Clicking inert popover chrome (group labels, padding) dismisses,
            // mirroring the other composer pickers. Buttons handle their own
            // clicks — model rows and the Speed trigger close/open themselves.
            if (event.target instanceof Element && !event.target.closest("button")) {
              setOpen(false);
            }
          }}
        >
          <ul
            className="project-picker-popover model-picker-popover"
            role="listbox"
            aria-label={ariaLabel}
            ref={primaryListRef}
            tabIndex={-1}
            onKeyDown={modelFilter.onKeyDown}
          >
            <PickerFilterRow
              query={modelFilter.query}
              matchCount={modelFilter.matches.length}
              totalCount={options.length}
            />
            {modelFilter.matches.map((option, index) => {
              const selected = isSelected(option.value);
              const previousGroup = index > 0 ? modelFilter.matches[index - 1]?.group : null;
              return (
                <Fragment key={option.key}>
                  {option.group && index > 0 && option.group !== previousGroup ? (
                    <li className="model-picker-divider" role="separator" />
                  ) : null}
                  <li
                    role="option"
                    aria-selected={selected}
                    aria-disabled={option.disabled || undefined}
                    className="model-picker-row"
                    data-disabled={option.disabled || undefined}
                    data-active={index === modelFilter.activeIndex ? "true" : undefined}
                  >
                    <button
                      type="button"
                      className="project-picker-item model-picker-item"
                      aria-pressed={selected}
                      disabled={option.disabled}
                      title={option.disabled ? `${option.label} — provider CLI not installed` : undefined}
                      onClick={() => selectModel(option)}
                    >
                      <span className="model-picker-name">{option.label}</span>
                      {option.annotation ? (
                        <span className="model-picker-annotation">{option.annotation}</span>
                      ) : null}
                    </button>
                  </li>
                </Fragment>
              );
            })}
            {modelFilter.matches.length === 0 ? (
              <li className="project-picker-empty" role="presentation">
                No models match
              </li>
            ) : null}
            {canChangeFastMode ? (
              <>
                <li className="model-picker-divider" role="separator" />
                <li role="presentation" className="model-picker-row model-picker-speed-row">
                  <button
                    type="button"
                    ref={speedMenu.setAnchor}
                    className="project-picker-item model-picker-item model-picker-submenu-trigger"
                    aria-expanded={fastModeMenuOpen}
                    onClick={() => setFastModeMenuOpen((menuOpen) => !menuOpen)}
                  >
                    <span className="model-picker-name">Speed</span>
                    <ChevronRight size={14} aria-hidden="true" className="model-picker-submenu-caret" />
                  </button>
                </li>
              </>
            ) : null}
          </ul>
          {fastModeMenuOpen && canChangeFastMode ? (
            <ul
              className="project-picker-popover model-speed-popover"
              role="listbox"
              aria-label="Speed"
              ref={speedMenu.setPopover}
              style={speedMenu.floatingStyles}
            >
              <li className="project-picker-group-label" role="presentation">
                Speed
              </li>
              <li role="option" aria-selected={!fastModeEnabled}>
                <button
                  type="button"
                  className="project-picker-item model-effort-item"
                  aria-pressed={!fastModeEnabled}
                  onClick={() => setFastMode(false)}
                >
                  <span>Standard</span>
                </button>
              </li>
              <li role="option" aria-selected={fastModeEnabled}>
                <button
                  type="button"
                  className="project-picker-item model-effort-item"
                  aria-pressed={fastModeEnabled}
                  title="Faster responses, increased usage"
                  onClick={() => setFastMode(true)}
                >
                  <span>Fast</span>
                </button>
              </li>
            </ul>
          ) : null}
        </div>
      )}
    </div>
      {showEffortSlider && value.reasoningEffort ? (
        <EffortSlider
          value={value.reasoningEffort}
          efforts={reasoningEffortsForValue(value)}
          ariaLabel={`${ariaLabel} effort`}
          onChange={(reasoningEffort) => onChange({ ...value, reasoningEffort })}
        />
      ) : null}
    </div>
  );
}

export function CombinedModelSelector({
  ariaLabel,
  availability,
  inputId,
  onChange,
  value
}: {
  ariaLabel: string;
  availability?: ProviderAvailability;
  inputId?: string;
  onChange: (model: ModelPickerSelection) => void;
  value: ModelPickerSelection;
}): JSX.Element {
  const matched = allModelOptions.find(
    (model) => model.provider === value.provider && model.modelId === value.modelId
  );
  const selectedReasoningEffort = value.reasoningEffort ?? matched?.reasoningEffort;
  const fallback = factoryLaunchModel();
  const selectedValue: ModelPickerSelection = matched
    ? {
        provider: matched.provider,
        label: matched.label,
        modelId: matched.modelId,
        ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {})
      }
    : fallback;

  return (
    <LaunchModelSelector
      ariaLabel={ariaLabel}
      anchorClassName="settings-model-picker"
      align="end"
      availability={availability}
      inputId={inputId}
      value={selectedValue}
      onChange={onChange}
    />
  );
}
