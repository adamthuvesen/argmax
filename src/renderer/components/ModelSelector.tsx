import { ChevronDown, ChevronRight, Cpu, Zap } from "lucide-react";
import { Fragment, useRef, useState, type CSSProperties, type JSX } from "react";
import {
  DEFAULT_REASONING_EFFORT,
  PROVIDER_MODEL_DEFAULTS,
  PROVIDER_MODELS,
  REASONING_EFFORTS,
  type ProviderModelSelection,
  type ReasoningEffort
} from "../../shared/providerModels.js";
import type { ProviderId } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import {
  allModelOptions,
  effortLabel,
  modelSupportsFastMode,
  modelValue,
  optionKey,
  providerSupportsFastMode,
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
  value
}: {
  ariaLabel: string;
  fastModeEnabled?: boolean;
  onFastModeEnabledChange?: (enabled: boolean) => void;
  onChange: (model: ProviderModelSelection) => void;
  provider: ProviderId;
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
      supportsFastModeForValue={() => providerSupportsFastMode(provider)}
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
      supportsFastModeForValue={modelSupportsFastMode}
      value={value}
    />
  );
}

function alwaysSupportsFastMode(): boolean {
  return true;
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
  const selectedLabel =
    selectedShowsEffort && value.reasoningEffort
      ? `${value.label} · ${effortLabel(value.reasoningEffort)}`
      : value.label;

  // Effort currently in effect for a given row: the live selection for the
  // selected model, otherwise the row's seeded default.
  const effortForOption = (option: ChipModelOption<T>): ReasoningEffort =>
    (isSelected(option.value) ? value.reasoningEffort : option.value.reasoningEffort) ?? DEFAULT_REASONING_EFFORT;

  const selectionForOption = (option: ChipModelOption<T>): T => {
    // Clicking the already-selected model keeps its current effort; a new
    // effort-capable model uses the row's seeded default; fast models carry none.
    return (
      option.supportsReasoningEffort && isSelected(option.value) && value.reasoningEffort
        ? { ...option.value, reasoningEffort: value.reasoningEffort }
        : option.value
    );
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
        title={effectiveFastModeEnabled ? `${selectedLabel} · Fast speed` : selectedLabel}
        onClick={() => setOpen((o) => !o)}
      >
        {effectiveFastModeEnabled ? (
          <Zap size={14} aria-hidden="true" className="model-picker-speed-icon" />
        ) : (
          <Cpu size={14} aria-hidden="true" />
        )}
        <span className="model-picker-label">{selectedLabel}</span>
        <ChevronDown size={12} aria-hidden="true" style={{ marginLeft: 2, opacity: 0.6 }} />
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
                  {option.group && option.group !== previousGroup ? (
                    <li className="project-picker-group-label" role="presentation">
                      {option.group}
                    </li>
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
              {REASONING_EFFORTS.map((reasoningEffort) => {
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
