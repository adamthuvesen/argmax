export interface VisualizationState {
  modelContent: unknown;
  privateContent: unknown;
}

export interface VisualizationAppearance {
  dark: boolean;
  variables: Record<string, string>;
}

export interface VisualizationRuntimeConfig {
  instanceId: string;
  appearance: VisualizationAppearance;
  state?: VisualizationState | null;
  controlValues?: Record<string, string | number | boolean>;
  capabilities?: { controls?: boolean };
  standalone?: boolean;
}

export interface VisualizationControl {
  id: string;
  kind: "slider" | "color" | "toggle" | "select";
  label: string;
  value: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  reference?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface VisualizationControlGroup {
  id: string;
  label: string;
  variant?: string;
  controls: VisualizationControl[];
}

export type VisualizationRuntimeMessage =
  | { type: "argmax:visualization-height"; instanceId: string; height: number }
  | { type: "argmax:visualization-state"; instanceId: string; requestId: string; state: VisualizationState }
  | { type: "argmax:visualization-follow-up"; instanceId: string; requestId: string; prompt: string; title?: string }
  | { type: "argmax:visualization-link"; instanceId: string; url: string }
  | { type: "argmax:visualization-controls"; instanceId: string; groups: VisualizationControlGroup[] };

export type VisualizationHostMessage =
  | { type: "argmax:visualization-appearance"; instanceId: string; appearance: VisualizationAppearance }
  | { type: "argmax:visualization-state"; instanceId: string; state: VisualizationState }
  | { type: "argmax:visualization-ack"; instanceId: string; requestId: string; error?: string }
  | { type: "argmax:visualization-control"; instanceId: string; id: string; value: string | number | boolean }
  | { type: "argmax:visualization-reset"; instanceId: string; groupId?: string }
  | { type: "argmax:visualization-original"; instanceId: string; active: boolean; groupId?: string };

export const VISUALIZATION_RUNTIME_VERSION = 1;
export const VISUALIZATION_STATE_BYTES = 16 * 1024;
