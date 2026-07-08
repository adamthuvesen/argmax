import { ChevronRight, Zap } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import {
  clampEffort,
  DEFAULT_REASONING_EFFORT,
  PROVIDER_MODEL_DEFAULTS,
  PROVIDER_MODELS,
  reasoningEffortsForModel,
  type ProviderModelSelection,
  type ReasoningEffort
} from "../../shared/providerModels.js";
import type { ProviderId } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { EffortPixelField } from "./EffortPixelField.js";
import { Mascot } from "./Mascot.js";
import {
  allModelOptions,
  effortLabel,
  modelSupportsFastMode,
  modelValue,
  optionKey,
  type ModelPickerSelection
} from "../lib/models.js";

const PROVIDER_GROUP_LABEL: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor"
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

/** Minimum shape the picker needs from each selectable value. */
type PickerValue = { label: string; modelId: string; reasoningEffort?: ReasoningEffort };

type SubmenuStyle = CSSProperties & {
  "--model-submenu-top"?: string;
  "--model-submenu-bottom"?: string;
};

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
  showEffortControl = false,
  value
}: {
  ariaLabel: string;
  fastModeEnabled?: boolean;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onChange: (model: ProviderModelSelection) => void;
  provider: ProviderId;
  showEffortControl?: boolean;
  value: ProviderModelSelection;
}): JSX.Element {
  const options: Array<ChipModelOption<ProviderModelSelection>> = PROVIDER_MODELS[provider].map((model) => ({
    key: optionKey(model),
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
      showEffortControl={showEffortControl}
      supportsFastModeForValue={(model) => modelSupportsFastMode({ provider, modelId: model.modelId })}
      value={value}
    />
  );
}

export function LaunchModelSelector({
  ariaLabel,
  anchorClassName,
  availability,
  fastModeEnabled = false,
  inputId,
  onOpenChange,
  onChange,
  onFastModeEnabledChange,
  open,
  showEffortControl = false,
  value
}: {
  ariaLabel: string;
  anchorClassName?: string;
  availability?: ProviderAvailability;
  fastModeEnabled?: boolean;
  inputId?: string;
  onOpenChange?: (open: boolean) => void;
  onChange: (model: ModelPickerSelection) => void;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  open?: boolean;
  showEffortControl?: boolean;
  value: ModelPickerSelection;
}): JSX.Element {
  const options: Array<ChipModelOption<ModelPickerSelection>> = allModelOptions.map((model) => ({
    key: modelValue(model),
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
      fastModeEnabled={fastModeEnabled}
      inputId={inputId}
      isSelected={(model) => model.provider === value.provider && model.modelId === value.modelId}
      onChange={onChange}
      onFastModeEnabledChange={onFastModeEnabledChange}
      onOpenChange={onOpenChange}
      open={open}
      options={options}
      reasoningEffortsForValue={(model) => reasoningEffortsForModel(model.provider, model.modelId)}
      showEffortControl={showEffortControl}
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
 * current effort and opens a slider spanning `efforts` (provider-specific — the
 * Claude list runs low→ultra, others stop at Extra High). The thumb tracks the
 * pointer 1:1 while dragging, then glides to the nearest stop; arrow/Home/End
 * keys step it. role="slider" carries the a11y semantics.
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
  const anchorRef = useRef<HTMLDivElement | null>(null);
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
  useDismissOnOutsideOrEscape(anchorRef, open, commitAndClose);

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
    <div className="project-picker-anchor effort-slider-anchor" ref={anchorRef}>
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
      </button>
      {open && (
        <div className="effort-slider-popover" role="dialog" aria-label={ariaLabel}>
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
              <EffortPixelField level={fraction} speed={fraction} />
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

function ChipModelPicker<T extends PickerValue>({
  ariaLabel,
  anchorClassName,
  fastModeEnabled,
  inputId,
  isSelected,
  onChange,
  onFastModeEnabledChange,
  onOpenChange,
  open: controlledOpen,
  options,
  reasoningEffortsForValue,
  showEffortControl = false,
  supportsFastModeForValue = alwaysSupportsFastMode,
  value
}: {
  ariaLabel: string;
  anchorClassName?: string;
  fastModeEnabled: boolean;
  inputId?: string;
  isSelected: (value: T) => boolean;
  onChange: (value: T) => void;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  options: Array<ChipModelOption<T>>;
  /** Effort levels for a given value's provider, low → high. Claude runs the
   *  full low→ultra list; other providers stop at Extra High. */
  reasoningEffortsForValue: (value: T) => readonly ReasoningEffort[];
  /** Show a standalone effort slider beside the chip and drop the effort suffix
   *  from the model label. Off in settings, where effort stays in the label. */
  showEffortControl?: boolean;
  supportsFastModeForValue?: (value: T) => boolean;
  value: T;
}): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false);
  const [effortMenuFor, setEffortMenuFor] = useState<string | null>(null);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [submenuOffset, setSubmenuOffset] = useState<{ top: number; bottom: number } | null>(null);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean | ((open: boolean) => boolean)): void => {
    const nextValue = typeof next === "function" ? next(open) : next;
    if (controlledOpen === undefined) {
      setInternalOpen(nextValue);
    }
    if (!nextValue) {
      setEffortMenuFor(null);
      setSpeedMenuOpen(false);
      setSubmenuOffset(null);
    }
    onOpenChange?.(nextValue);
  };
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const primaryListRef = useRef<HTMLUListElement | null>(null);
  useDismissOnOutsideOrEscape(anchorRef, open, () => setOpen(false));
  const selectedSupportsFastMode = supportsFastModeForValue(value);
  const canChangeSpeed = Boolean(onFastModeEnabledChange) && selectedSupportsFastMode;
  const effectiveFastModeEnabled = fastModeEnabled && selectedSupportsFastMode;

  const selectedOption = options.find((option) => isSelected(option.value));
  // Show the chosen effort whenever the selection carries one. Suppress it when
  // the selected model is known to be fast/no-effort.
  const selectedShowsEffort =
    value.reasoningEffort != null && (selectedOption ? selectedOption.supportsReasoningEffort : true);
  // "Model · Effort" for the tooltip; when the standalone effort slider is
  // shown the button text drops the effort suffix (the slider carries it).
  const selectedTitle =
    selectedShowsEffort && value.reasoningEffort
      ? `${value.label} · ${effortLabel(value.reasoningEffort)}`
      : value.label;
  const selectedLabel = showEffortControl ? value.label : selectedTitle;
  const showEffortSlider = showEffortControl && selectedShowsEffort && value.reasoningEffort != null;

  // Effort a row would use if picked: the current effort carried over and
  // clamped to what the row's model supports (fast models show nothing). This
  // keeps the row preview in step with what selectionForOption commits.
  const effortForOption = (option: ChipModelOption<T>): ReasoningEffort =>
    (isSelected(option.value)
      ? value.reasoningEffort
      : clampEffort(value.reasoningEffort, reasoningEffortsForValue(option.value))) ??
    DEFAULT_REASONING_EFFORT;

  const selectionForOption = (option: ChipModelOption<T>): T => {
    // Fast/no-effort models carry no effort. Otherwise the current effort is
    // carried onto the target and clamped to its range (e.g. Claude Max →
    // Codex Extra High), never promoted (Codex Extra High → Claude stays
    // Extra High). Falls back to the seeded default when there's none to carry.
    if (!option.supportsReasoningEffort) return option.value;
    const carried = clampEffort(value.reasoningEffort, reasoningEffortsForValue(option.value));
    return { ...option.value, reasoningEffort: carried ?? DEFAULT_REASONING_EFFORT };
  };

  const selectModel = (option: ChipModelOption<T>): void => {
    // A disabled row (provider CLI not installed) can't be chosen — the button
    // is also disabled, this is just belt-and-suspenders.
    if (option.disabled) return;
    const nextValue = selectionForOption(option);
    onChange(nextValue);
    setOpen(false);
  };

  const selectEffort = (option: ChipModelOption<T>, reasoningEffort: ReasoningEffort): void => {
    onChange({ ...option.value, reasoningEffort });
    setOpen(false);
  };

  const selectSpeed = (enabled: boolean): void => {
    onFastModeEnabledChange?.(enabled);
    setOpen(false);
  };

  const anchorSubmenuTo = (trigger: HTMLElement): void => {
    const list = primaryListRef.current;
    if (!list) {
      setSubmenuOffset(null);
      return;
    }

    const listRect = list.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    setSubmenuOffset({
      top: Math.max(0, Math.round(triggerRect.top - listRect.top)),
      bottom: Math.max(0, Math.round(listRect.bottom - triggerRect.bottom))
    });
  };

  const submenuStyle: SubmenuStyle | undefined = submenuOffset
    ? {
        "--model-submenu-top": `${submenuOffset.top}px`,
        "--model-submenu-bottom": `${submenuOffset.bottom}px`
      }
    : undefined;

  const editingOption = effortMenuFor
    ? options.find((option) => option.key === effortMenuFor && option.supportsReasoningEffort && !option.disabled) ?? null
    : null;

  return (
    <div className="model-picker-cluster">
    <div
      className={`project-picker-anchor model-picker-anchor${anchorClassName ? ` ${anchorClassName}` : ""}`}
      ref={anchorRef}
    >
      <button
        type="button"
        id={inputId}
        className="composer-context-chip"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={effectiveFastModeEnabled ? `${selectedTitle} · Fast speed` : selectedTitle}
        onClick={() => setOpen((o) => !o)}
      >
        {effectiveFastModeEnabled ? (
          <Zap size={14} aria-hidden="true" className="model-picker-speed-icon" />
        ) : null}
        <span className="model-picker-label">{selectedLabel}</span>
      </button>
      {open && (
        <div
          className="model-picker-flyout"
          onClick={(event) => {
            // Clicking inert popover chrome (group labels, padding) dismisses,
            // mirroring the other composer pickers. Buttons handle their own
            // clicks — model/effort rows close themselves, Edit stays open.
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
          >
            {options.map((option, index) => {
              const selected = isSelected(option.value);
              const previousGroup = index > 0 ? options[index - 1]?.group : null;
              const editing = option.key === effortMenuFor;
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
                      {option.supportsReasoningEffort && !option.disabled ? (
                        <span className="model-picker-effort">{effortLabel(effortForOption(option))}</span>
                      ) : null}
                    </button>
                    {option.supportsReasoningEffort && !option.disabled ? (
                      <button
                        type="button"
                        className="model-picker-edit"
                        aria-label={`Edit effort for ${option.label}`}
                        aria-expanded={editing}
                        title="Change reasoning effort"
                        onClick={(event) => {
                          setSpeedMenuOpen(false);
                          const nextEffortMenuFor = effortMenuFor === option.key ? null : option.key;
                          setEffortMenuFor(nextEffortMenuFor);
                          if (nextEffortMenuFor) {
                            if (!isSelected(option.value)) {
                              onChange(selectionForOption(option));
                            }
                            anchorSubmenuTo(event.currentTarget);
                          } else {
                            setSubmenuOffset(null);
                          }
                        }}
                      >
                        <ChevronRight size={14} aria-hidden="true" className="model-picker-submenu-caret" />
                      </button>
                    ) : null}
                  </li>
                </Fragment>
              );
            })}
            {canChangeSpeed ? (
              <>
                <li className="model-picker-divider" role="separator" />
                <li role="presentation" className="model-picker-row model-picker-speed-row">
                  <button
                    type="button"
                    className="project-picker-item model-picker-item model-picker-submenu-trigger"
                    aria-expanded={speedMenuOpen}
                    onClick={(event) => {
                      setEffortMenuFor(null);
                      const nextSpeedMenuOpen = !speedMenuOpen;
                      setSpeedMenuOpen(nextSpeedMenuOpen);
                      if (nextSpeedMenuOpen) {
                        anchorSubmenuTo(event.currentTarget);
                      } else {
                        setSubmenuOffset(null);
                      }
                    }}
                  >
                    <span className="model-picker-name">Speed</span>
                    <span className="model-picker-effort">{fastModeEnabled ? "Fast" : "Standard"}</span>
                    <ChevronRight size={14} aria-hidden="true" className="model-picker-submenu-caret" />
                  </button>
                </li>
              </>
            ) : null}
          </ul>
          {editingOption ? (
            <ul
              className="project-picker-popover model-effort-popover"
              role="listbox"
              aria-label="Reasoning effort"
              style={submenuStyle}
            >
              <li className="project-picker-group-label" role="presentation">
                Effort
              </li>
              {reasoningEffortsForValue(editingOption.value).map((reasoningEffort) => {
                const active = effortForOption(editingOption) === reasoningEffort;
                return (
                  <li key={reasoningEffort} role="option" aria-selected={active}>
                    <button
                      type="button"
                      className="project-picker-item model-effort-item"
                      aria-pressed={active}
                      onClick={() => selectEffort(editingOption, reasoningEffort)}
                    >
                      <span>{effortLabel(reasoningEffort)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {speedMenuOpen && canChangeSpeed ? (
            <ul
              className="project-picker-popover model-speed-popover"
              role="listbox"
              aria-label="Speed"
              style={submenuStyle}
            >
              <li className="project-picker-group-label" role="presentation">
                Speed
              </li>
              <li role="option" aria-selected={!fastModeEnabled}>
                <button
                  type="button"
                  className="project-picker-item model-effort-item"
                  aria-pressed={!fastModeEnabled}
                  onClick={() => selectSpeed(false)}
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
                  onClick={() => selectSpeed(true)}
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
  const selectedValue: ModelPickerSelection = matched
    ? {
        provider: matched.provider,
        label: matched.label,
        modelId: matched.modelId,
        ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {})
      }
    : {
        provider: "codex",
        label: PROVIDER_MODEL_DEFAULTS.codex.label,
        modelId: PROVIDER_MODEL_DEFAULTS.codex.modelId,
        ...(PROVIDER_MODEL_DEFAULTS.codex.reasoningEffort
          ? { reasoningEffort: PROVIDER_MODEL_DEFAULTS.codex.reasoningEffort }
          : {})
      };

  return (
    <LaunchModelSelector
      ariaLabel={ariaLabel}
      anchorClassName="settings-model-picker"
      availability={availability}
      inputId={inputId}
      value={selectedValue}
      onChange={onChange}
    />
  );
}
