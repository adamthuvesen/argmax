import { ChevronDown, Cpu } from "lucide-react";
import { useRef, useState, type JSX } from "react";
import { PROVIDER_MODELS, type ProviderModelSelection } from "../../shared/providerModels.js";
import type { ProviderId } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { allModelOptions, effortLabel, modelValue, optionKey, type ModelPickerSelection } from "../lib/models.js";

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
  const models = PROVIDER_MODELS[provider];
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsideOrEscape(anchorRef, open, () => setOpen(false));

  const currentLabel = value.reasoningEffort
    ? `${value.label} · ${effortLabel(value.reasoningEffort)}`
    : value.label;

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
        {currentLabel}
        <ChevronDown size={12} aria-hidden="true" style={{ marginLeft: 2, opacity: 0.6 }} />
      </button>
      {open && (
        <ul className="project-picker-popover" role="listbox" aria-label={ariaLabel}>
          {models.map((model) => {
            const isSelected =
              model.modelId === value.modelId && model.reasoningEffort === value.reasoningEffort;
            const label = model.reasoningEffort
              ? `${model.label} · ${effortLabel(model.reasoningEffort)}`
              : model.label;
            return (
              <li key={optionKey(model)} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  className="project-picker-item"
                  aria-pressed={isSelected}
                  onClick={() => {
                    onChange({
                      label: model.label,
                      modelId: model.modelId,
                      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {})
                    });
                    setOpen(false);
                  }}
                >
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function CombinedModelSelector({
  ariaLabel,
  onChange,
  value
}: {
  ariaLabel: string;
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
              {model.label}
            </option>
          ))}
        </optgroup>
      </select>
    </span>
  );
}
