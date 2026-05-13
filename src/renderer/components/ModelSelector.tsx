import { ChevronDown, Cpu } from "lucide-react";
import { Fragment, useRef, useState, type JSX } from "react";
import { PROVIDER_MODELS, type ProviderModelSelection } from "../../shared/providerModels.js";
import type { ProviderId } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { allModelOptions, effortLabel, modelValue, optionKey, type ModelPickerSelection } from "../lib/models.js";

const PROVIDER_GROUP_LABEL: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor"
};

type ChipModelOption<T> = {
  key: string;
  label: string;
  value: T;
  group?: string;
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
  const selectedLabel = value.reasoningEffort
    ? `${value.label} · ${effortLabel(value.reasoningEffort)}`
    : value.label;
  const options = PROVIDER_MODELS[provider].map((model) => ({
    key: optionKey(model),
    label: model.reasoningEffort ? `${model.label} · ${effortLabel(model.reasoningEffort)}` : model.label,
    value: {
      label: model.label,
      modelId: model.modelId,
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
    }
  }));

  return (
    <ChipModelPicker
      ariaLabel={ariaLabel}
      isSelected={(model) => model.modelId === value.modelId && model.reasoningEffort === value.reasoningEffort}
      onChange={onChange}
      options={options}
      selectedLabel={selectedLabel}
    />
  );
}

export function LaunchModelSelector({
  ariaLabel,
  onOpenChange,
  onChange,
  open,
  value
}: {
  ariaLabel: string;
  onOpenChange?: (open: boolean) => void;
  onChange: (model: ModelPickerSelection) => void;
  open?: boolean;
  value: ModelPickerSelection;
}): JSX.Element {
  const selectedLabel = value.reasoningEffort
    ? `${value.label} · ${effortLabel(value.reasoningEffort)}`
    : value.label;
  const options = allModelOptions.map((model) => ({
    key: modelValue(model),
    label: model.reasoningEffort ? `${model.label} · ${effortLabel(model.reasoningEffort)}` : model.label,
    value: model,
    group: PROVIDER_GROUP_LABEL[model.provider]
  }));

  return (
    <ChipModelPicker
      ariaLabel={ariaLabel}
      isSelected={(model) =>
        model.provider === value.provider &&
        model.modelId === value.modelId &&
        model.reasoningEffort === value.reasoningEffort
      }
      onChange={onChange}
      onOpenChange={onOpenChange}
      open={open}
      options={options}
      selectedLabel={selectedLabel}
    />
  );
}

function ChipModelPicker<T>({
  ariaLabel,
  isSelected,
  onChange,
  onOpenChange,
  open: controlledOpen,
  options,
  selectedLabel
}: {
  ariaLabel: string;
  isSelected: (value: T) => boolean;
  onChange: (value: T) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  options: Array<ChipModelOption<T>>;
  selectedLabel: string;
}): JSX.Element {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean | ((open: boolean) => boolean)): void => {
    const value = typeof next === "function" ? next(open) : next;
    if (controlledOpen === undefined) {
      setInternalOpen(value);
    }
    onOpenChange?.(value);
  };
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsideOrEscape(anchorRef, open, () => setOpen(false));

  return (
    <div className="project-picker-anchor" ref={anchorRef}>
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
        <ul
          className="project-picker-popover"
          role="listbox"
          aria-label={ariaLabel}
          onClick={(event) => {
            if (!(event.target instanceof Element && event.target.closest("button.project-picker-item"))) {
              setOpen(false);
            }
          }}
        >
          {options.map((option, index) => {
            const selected = isSelected(option.value);
            const previousGroup = index > 0 ? options[index - 1]?.group : null;
            return (
              <Fragment key={option.key}>
                {option.group && option.group !== previousGroup ? (
                  <li className="project-picker-group-label" role="presentation">
                    {option.group}
                  </li>
                ) : null}
                <li role="option" aria-selected={selected}>
                  <button
                    type="button"
                    className="project-picker-item"
                    aria-pressed={selected}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function CombinedModelSelector({
  ariaLabel,
  inputId,
  onChange,
  value
}: {
  ariaLabel: string;
  inputId?: string;
  onChange: (model: ModelPickerSelection) => void;
  value: ModelPickerSelection;
}): JSX.Element {
  const fallbackKey = allModelOptions[0] ? modelValue(allModelOptions[0]) : "";
  const matched = allModelOptions.find(
    (model) =>
      model.provider === value.provider &&
      model.modelId === value.modelId &&
      model.reasoningEffort === value.reasoningEffort
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
            onChange(model);
          }
        }}
      >
        <optgroup label="Codex">
          {PROVIDER_MODELS.codex.map((model) => (
            <option key={optionKey(model)} value={modelValue({ provider: "codex", ...model })}>
              {model.reasoningEffort ? `${model.label} · ${effortLabel(model.reasoningEffort)}` : model.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Claude">
          {PROVIDER_MODELS.claude.map((model) => (
            <option key={optionKey(model)} value={modelValue({ provider: "claude", ...model })}>
              {model.reasoningEffort ? `${model.label} · ${effortLabel(model.reasoningEffort)}` : model.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Cursor">
          {PROVIDER_MODELS.cursor.map((model) => (
            <option key={optionKey(model)} value={modelValue({ provider: "cursor", ...model })}>
              {model.reasoningEffort ? `${model.label} · ${effortLabel(model.reasoningEffort)}` : model.label}
            </option>
          ))}
        </optgroup>
      </select>
    </span>
  );
}
