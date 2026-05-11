import { ChevronDown, ChevronRight, Cpu, Folder, GitBranch, Mic, Plus } from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import { PROVIDER_MODELS } from "../../shared/providerModels.js";
import type { ProjectSummary } from "../../shared/types.js";
import { useAutoGrowTextArea } from "../hooks/useAutoGrowTextArea.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useSlashAutocomplete } from "../hooks/useSlashAutocomplete.js";
import { effortLabel, modelValue, type ModelPickerSelection } from "../lib/models.js";
import { SkillPopover } from "./SkillPopover.js";

const PROMPT_MAX_HEIGHT_PX = 140;

function isOptionButtonTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button.project-picker-item") !== null;
}

export function LaunchSurface({
  model,
  onAddProject,
  onBranchSwitch,
  onLaunchTask,
  onModelChange,
  onSelectProject,
  project,
  projects
}: {
  model: ModelPickerSelection;
  onAddProject: () => void;
  onBranchSwitch: (updated: ProjectSummary) => void;
  onLaunchTask: (prompt: string, model: ModelPickerSelection) => Promise<void>;
  onModelChange: (model: ModelPickerSelection) => void;
  onSelectProject: (id: string) => void;
  project: ProjectSummary | null;
  projects: ProjectSummary[];
}): JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const projectPickerRef = useRef<HTMLDivElement | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const branchPickerRef = useRef<HTMLDivElement | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement | null>(null);

  useDismissOnOutsideOrEscape(projectPickerRef, projectPickerOpen, () => setProjectPickerOpen(false));
  useDismissOnOutsideOrEscape(branchPickerRef, branchPickerOpen, () => setBranchPickerOpen(false));
  useDismissOnOutsideOrEscape(modelPickerRef, modelPickerOpen, () => setModelPickerOpen(false));
  const anyContextPickerOpen = projectPickerOpen || branchPickerOpen || modelPickerOpen;

  const closeContextPickers = useCallback((): void => {
    setProjectPickerOpen(false);
    setBranchPickerOpen(false);
    setModelPickerOpen(false);
  }, []);

  const openBranchPicker = useCallback(async (): Promise<void> => {
    if (!window.argmax || !project) return;
    const list = await window.argmax.projects.listBranches(project.id);
    setBranches(list);
    setBranchPickerOpen(true);
  }, [project]);

  const switchBranch = useCallback(async (branch: string): Promise<void> => {
    if (!window.argmax || !project) return;
    setBranchPickerOpen(false);
    try {
      const updated = await window.argmax.projects.switchBranch(project.id, branch);
      onBranchSwitch(updated);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not switch branch.");
    }
  }, [project, onBranchSwitch]);
  const headingTemplate = useMemo(() => {
    const options = [
      "{name}: the final frontier.",
      "In space, no one can hear your {name} build fail.",
      "You're gonna need a bigger {name}.",
      "What we've got here is a failure to ship {name}.",
      "{name} will remember that.",
      "I'm sorry Dave, I can't merge that into {name}.",
      "With great {name} comes great responsibility.",
      "One does not simply deploy {name} to production.",
      "{name}: it's alive!",
      "I know kung fu. What are we building in {name}?",
    ];
    return options[Math.floor(Math.random() * options.length)];
  }, []);
  const placeholderText = useMemo(() => {
    const options = [
      "Do or do not. There is no try.",
      "You can't handle the diff.",
      "I'll be back. (After this build passes.)",
      "My precious... what are we shipping?",
      "Make it so.",
      "Elementary. What needs debugging?",
      "You had me at \"merge conflict\".",
      "Why so serious? Describe the task.",
      "What is thy bidding, master?",
      "They may take our lives, but they'll never take our main branch.",
    ];
    return options[Math.floor(Math.random() * options.length)];
  }, []);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  useAutoGrowTextArea(promptInputRef, prompt, PROMPT_MAX_HEIGHT_PX);
  const slashAutocomplete = useSlashAutocomplete({
    input: prompt,
    setInput: setPrompt,
    provider: model.provider,
    workspaceId: null
  });

  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    slashAutocomplete.onKeyDown(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const submitPrompt = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setStatus(null);
    try {
      await onLaunchTask(trimmedPrompt, model);
      setPrompt("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start agent.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!project) {
    return (
      <div className="launcher-surface empty-project-launcher">
        <h1>Add a project to start</h1>
        <button className="primary-action" type="button" onClick={onAddProject}>
          <Plus size={18} />
          Add Project
        </button>
      </div>
    );
  }

  return (
    <div className="launcher-surface">
      {anyContextPickerOpen && createPortal(
        <div
          className="picker-dismiss-layer"
          aria-hidden="true"
          onMouseDown={closeContextPickers}
        />,
        document.body
      )}
      <h1>{headingTemplate.replace("{name}", project.name)}</h1>
      <form className="composer" ref={formRef} onSubmit={(event) => void submitPrompt(event)}>
        <div className="composer-input">
          <textarea
            aria-label="Task prompt"
            aria-autocomplete="list"
            aria-expanded={slashAutocomplete.popoverOpen}
            aria-controls={slashAutocomplete.popoverOpen ? "skill-popover" : undefined}
            disabled={isSubmitting}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onPromptKeyDown}
            placeholder={placeholderText}
            ref={promptInputRef}
            value={prompt}
            rows={1}
          />
          <SkillPopover state={slashAutocomplete} inputRef={promptInputRef} />
          <button className="composer-tool" type="button" title="Add context">
            <Plus size={18} />
          </button>
          <button className="composer-tool" type="button" title="Voice input">
            <Mic size={18} />
          </button>
          <button className="send-button" disabled={isSubmitting || !prompt.trim()} type="submit" title="Start agent">
            <ChevronRight size={20} />
          </button>
        </div>
        <div className="composer-context">
          <div className="project-picker-anchor" ref={projectPickerRef}>
            <button
              className="composer-context-chip"
              type="button"
              aria-label="Switch project"
              aria-expanded={projectPickerOpen}
              onClick={() => setProjectPickerOpen((o) => !o)}
            >
              <Folder size={14} aria-hidden="true" />
              {project.name}
              <ChevronDown size={12} aria-hidden="true" style={{ marginLeft: 2, opacity: 0.6 }} />
            </button>
            {projectPickerOpen && (
              <ul
                className="project-picker-popover"
                role="listbox"
                aria-label="Select project"
                onClick={(event) => {
                  if (!isOptionButtonTarget(event.target)) {
                    setProjectPickerOpen(false);
                  }
                }}
              >
                {projects.map((p) => (
                  <li key={p.id} role="option" aria-selected={p.id === project.id}>
                    <button
                      type="button"
                      className="project-picker-item"
                      aria-pressed={p.id === project.id}
                      onClick={() => { onSelectProject(p.id); setProjectPickerOpen(false); }}
                    >
                      <Folder size={13} aria-hidden="true" />
                      {p.name}
                    </button>
                  </li>
                ))}
                <li className="project-picker-divider" role="separator" />
                <li role="option" aria-selected={false}>
                  <button
                    type="button"
                    className="project-picker-item"
                    onClick={() => { onAddProject(); setProjectPickerOpen(false); }}
                  >
                    <Plus size={13} aria-hidden="true" />
                    Browse folder…
                  </button>
                </li>
              </ul>
            )}
          </div>
          <div className="project-picker-anchor" ref={branchPickerRef}>
            <button
              className="composer-context-chip"
              type="button"
              aria-label="Switch branch"
              aria-expanded={branchPickerOpen}
              onClick={() => void openBranchPicker()}
            >
              <GitBranch size={14} aria-hidden="true" />
              {project.currentBranch}
              <ChevronDown size={12} aria-hidden="true" style={{ marginLeft: 2, opacity: 0.6 }} />
            </button>
            {branchPickerOpen && (
              <ul
                className="project-picker-popover"
                role="listbox"
                aria-label="Select branch"
                onClick={(event) => {
                  if (!isOptionButtonTarget(event.target)) {
                    setBranchPickerOpen(false);
                  }
                }}
              >
                {branches.map((b) => (
                  <li key={b} role="option" aria-selected={b === project.currentBranch}>
                    <button
                      type="button"
                      className="project-picker-item"
                      aria-pressed={b === project.currentBranch}
                      onClick={() => void switchBranch(b)}
                    >
                      <GitBranch size={13} aria-hidden="true" />
                      {b}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="project-picker-anchor" ref={modelPickerRef}>
            <button
              className="composer-context-chip"
              type="button"
              aria-label="Switch model"
              aria-expanded={modelPickerOpen}
              onClick={() => setModelPickerOpen((o) => !o)}
            >
              <Cpu size={14} aria-hidden="true" />
              {model.reasoningEffort ? `${model.label} · ${effortLabel(model.reasoningEffort)}` : model.label}
              <ChevronDown size={12} aria-hidden="true" style={{ marginLeft: 2, opacity: 0.6 }} />
            </button>
            {modelPickerOpen && (
              <ul
                className="project-picker-popover"
                role="listbox"
                aria-label="Select model"
                onClick={(event) => {
                  if (!isOptionButtonTarget(event.target)) {
                    setModelPickerOpen(false);
                  }
                }}
              >
                <li className="project-picker-group-label" role="presentation">Codex</li>
                {PROVIDER_MODELS.codex.map((m) => {
                  const opt: ModelPickerSelection = { provider: "codex", label: m.label, modelId: m.modelId, ...(m.reasoningEffort ? { reasoningEffort: m.reasoningEffort } : {}) };
                  const isSelected = model.provider === "codex" && model.modelId === m.modelId && model.reasoningEffort === m.reasoningEffort;
                  const label = m.reasoningEffort ? `${m.label} · ${effortLabel(m.reasoningEffort)}` : m.label;
                  return (
                    <li key={modelValue(opt)} role="option" aria-selected={isSelected}>
                      <button
                        type="button"
                        className="project-picker-item"
                        aria-pressed={isSelected}
                        onClick={() => { onModelChange(opt); setModelPickerOpen(false); }}
                      >
                        {label}
                      </button>
                    </li>
                  );
                })}
                <li className="project-picker-divider" role="separator" />
                <li className="project-picker-group-label" role="presentation">Claude</li>
                {PROVIDER_MODELS.claude.map((m) => {
                  const opt: ModelPickerSelection = { provider: "claude", label: m.label, modelId: m.modelId };
                  const isSelected = model.provider === "claude" && model.modelId === m.modelId;
                  return (
                    <li key={modelValue(opt)} role="option" aria-selected={isSelected}>
                      <button
                        type="button"
                        className="project-picker-item"
                        aria-pressed={isSelected}
                        onClick={() => { onModelChange(opt); setModelPickerOpen(false); }}
                      >
                        {m.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        {status ? (
          <p className="composer-status" role="status">
            {status}
          </p>
        ) : null}
      </form>
    </div>
  );
}
