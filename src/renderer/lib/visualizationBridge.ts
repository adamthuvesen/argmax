import type { VisualizationControl, VisualizationControlGroup, VisualizationRuntimeMessage } from "../../shared/visualization/types.js";
import type { JsonValue, VisualizationWidgetState } from "../../shared/bindings.js";

type DecodedMessage = Exclude<VisualizationRuntimeMessage, { type: "argmax:visualization-state" }>
  | { type: "argmax:visualization-state"; instanceId: string; requestId: string; state: Required<VisualizationWidgetState> };

function jsonValue(value: unknown, ancestors = new Set<object>(), depth = 0): value is JsonValue {
  if (depth > 100) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Object.values(value).every(child => jsonValue(child, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function control(value: unknown): value is VisualizationControl {
  if (!record(value) || !text(value.id, 250) || !text(value.label, 250)) return false;
  if (value.kind === "toggle") return typeof value.value === "boolean";
  if (value.kind === "color") return typeof value.value === "string" && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value.value);
  if (value.kind === "slider") return typeof value.value === "number" && Number.isFinite(value.value)
    && typeof value.min === "number" && Number.isFinite(value.min)
    && typeof value.max === "number" && Number.isFinite(value.max) && value.min < value.max
    && (value.step === undefined || typeof value.step === "number" && Number.isFinite(value.step) && value.step > 0)
    && (value.unit === undefined || typeof value.unit === "string" && value.unit.length <= 30);
  return value.kind === "select" && typeof value.value === "string" && Array.isArray(value.options)
    && value.options.length > 0 && value.options.length <= 12
    && value.options.every(option => record(option) && text(option.label, 250) && text(option.value, 250));
}
function group(value: unknown): value is VisualizationControlGroup {
  return record(value) && text(value.id, 250) && text(value.label, 250)
    && (value.variant === undefined || text(value.variant, 250))
    && Array.isArray(value.controls) && value.controls.length <= 12 && value.controls.every(control);
}

/** Validate the untrusted frame protocol before it reaches host capabilities. */
export function decodeVisualizationMessage(value: unknown, instanceId: string): DecodedMessage | null {
  if (!record(value) || value.instanceId !== instanceId) return null;
  if (value.type === "argmax:visualization-height" && typeof value.height === "number" && Number.isFinite(value.height)) {
    return { type: value.type, instanceId, height: value.height };
  }
  if (value.type === "argmax:visualization-state" && text(value.requestId, 250) && record(value.state)
    && Object.keys(value.state).every(key => key === "modelContent" || key === "privateContent")
    && jsonValue(value.state.modelContent ?? null) && jsonValue(value.state.privateContent ?? null)
    && new TextEncoder().encode(JSON.stringify(value.state)).byteLength <= 16 * 1024) {
    return { type: value.type, instanceId, requestId: value.requestId, state: { modelContent: value.state.modelContent ?? null, privateContent: value.state.privateContent ?? null } };
  }
  if (value.type === "argmax:visualization-follow-up" && text(value.requestId, 250) && text(value.prompt, 32_000)
    && (value.title === undefined || text(value.title, 250))) {
    return { type: value.type, instanceId, requestId: value.requestId, prompt: value.prompt, title: value.title };
  }
  if (value.type === "argmax:visualization-link" && text(value.url, 4096) && /^https?:\/\//i.test(value.url)) {
    return { type: value.type, instanceId, url: value.url };
  }
  if (value.type === "argmax:visualization-controls" && Array.isArray(value.groups) && value.groups.length <= 32 && value.groups.every(group)) {
    return { type: value.type, instanceId, groups: value.groups };
  }
  return null;
}
