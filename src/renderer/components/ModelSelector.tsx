import { Check, ChevronDown, Cpu } from "lucide-react";
import { Fragment, useRef, useState, type JSX } from "react";
import {
  DEFAULT_REASONING_EFFORT,
  PROVIDER_MODELS,
  REASONING_EFFORTS,
  type ProviderModelSelection,
  type ReasoningEffort
} from "../../shared/providerModels.js";
import type { ProviderId } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { allModelOptions, effortLabel, modelValue, optionKey, type ModelPickerSelection } from "../lib/models.js";

const PROVIDER_GROUP_LABEL: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor"
};

/** Per-provider install/auth state used to gate the picker. */
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
  onChange,
  provider,
  value
}: {
  ariaLabel: string;
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
      isSelected={(model) => model.modelId === value.modelId}
      onChange={onChange}
      options={options}
      value={value}
    />
  );
}

export function LaunchModelSelector({
  ariaLabel,
  availability,
  onOpenChange,
  onChange,
  open,
  value
}: {
  ariaLabel: string;
  availability?: ProviderAvailability;
  onOpenChange?: (open: boolean) => void;
  onChange: (model: ModelPickerSelection) => void;
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
      isSelected={(model) => model.provider === value.provider && model.modelId === value.modelId}
      onChange={onChange}
      onOpenChange={onOpenChange}
      open={open}
      options={options}
      value={value}
    />
  );
}

function ChipModelPicker<T extends PickerValue>({
  ariaLabel,
  isSelected,
  onChange,
  onOpenChange,
  open: controlledOpen,
  options,
  value
}: {
  ariaLabel: string;
  isSelected: (value: T) => boolean;
  onChange: (value: T) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  options: Array<ChipModelOption<T>>;
  value: T;
}): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false);
  const [effortMenuFor, setEffortMenuFor] = useState<string | null>(null);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean | ((open: boolean) => boolean)): void => {
    const nextValue = typeof next === "function" ? next(open) : next;
    if (controlledOpen === undefined) {
      setInternalOpen(nextValue);
    }
    if (!nextValue) setEffortMenuFor(null);
    onOpenChange?.(nextValue);
  };
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsideOrEscape(anchorRef, open, () => setOpen(false));

  const selectedOption = options.find((option) => isSelected(option.value));
  // Show the chosen effort whenever the selection carries one. Only suppress it
  // when we positively know the selected model is fast/no-effort (e.g. an old
  // session that stored an effort for Haiku before effort was removed there).
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

  const selectModel = (option: ChipModelOption<T>): void => {
    // A disabled row (provider CLI not installed) can't be chosen — the button
    // is also disabled, this is just belt-and-suspenders.
    if (option.disabled) return;
    // Clicking the already-selected model keeps its current effort; a new
    // effort-capable model uses the row's seeded default; fast models carry none.
    const next =
      option.supportsReasoningEffort && isSelected(option.value) && value.reasoningEffort
        ? { ...option.value, reasoningEffort: value.reasoningEffort }
        : option.value;
    onChange(next);
    setOpen(false);
  };

  const selectEffort = (option: ChipModelOption<T>, reasoningEffort: ReasoningEffort): void => {
    onChange({ ...option.value, reasoningEffort });
    setOpen(false);
  };

  // Effort can only be edited on the currently selected model — never on a
  // different row while another model is active.
  const editingOption = effortMenuFor
    ? options.find((option) => option.key === effortMenuFor && isSelected(option.value)) ?? null
    : null;

  return (
    <div className="project-picker-anchor model-picker-anchor" ref={anchorRef}>
      <button
        type="button"
        className="composer-context-chip"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Cpu size={14} aria-hidden="true" />
        {selectedLabel}
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
          <ul className="project-picker-popover model-picker-popover" role="listbox" aria-label={ariaLabel}>
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
                      {/* Always reserve the check column so the selected row's
                          effort label stays aligned with the others. */}
                      <span className="model-picker-check" aria-hidden="true">
                        {selected ? <Check size={14} /> : null}
                      </span>
                    </button>
                    {option.supportsReasoningEffort && !option.disabled ? (
                      <button
                        type="button"
                        className="model-picker-edit"
                        aria-label={`Edit effort for ${option.label}`}
                        aria-expanded={editing}
                        disabled={!selected}
                        title={selected ? "Change reasoning effort" : "Select this model to change its effort"}
                        onClick={() => setEffortMenuFor((current) => (current === option.key ? null : option.key))}
                      >
                        Edit
                      </button>
                    ) : null}
                  </li>
                </Fragment>
              );
            })}
          </ul>
          {editingOption ? (
            <ul className="project-picker-popover model-effort-popover" role="listbox" aria-label="Reasoning effort">
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
                      {active ? <Check size={14} aria-hidden="true" className="model-picker-check" /> : null}
                    </button>
                  </li>
                );
              })}
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
  const fallbackKey = allModelOptions[0] ? modelValue(allModelOptions[0]) : "";
  const matched = allModelOptions.find(
    (model) => model.provider === value.provider && model.modelId === value.modelId
  );
  const selectedValue = matched ? modelValue(matched) : fallbackKey;

  return (
    <span className="model-selector model-selector-combined">
      <select
        id={inputId}
        aria-label={ariaLabel}
        value={selectedValue}
        onChange={(event) => {
          const model = allModelOptions.find((option) => modelValue(option) === event.target.value);
          if (model) {
            onChange({
              provider: model.provider,
              label: model.label,
              modelId: model.modelId,
              ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
            });
          }
        }}
      >
        {(Object.keys(PROVIDER_GROUP_LABEL) as ProviderId[]).map((provider) => {
          const { disabled, annotation } = availabilityAnnotation(availability, provider);
          const groupLabel = annotation
            ? `${PROVIDER_GROUP_LABEL[provider]} — ${annotation}`
            : PROVIDER_GROUP_LABEL[provider];
          return (
            <optgroup key={provider} label={groupLabel}>
              {PROVIDER_MODELS[provider].map((model) => (
                <option
                  key={optionKey(model)}
                  value={modelValue({ provider, modelId: model.modelId })}
                  disabled={disabled}
                >
                  {model.label}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </span>
  );
}
