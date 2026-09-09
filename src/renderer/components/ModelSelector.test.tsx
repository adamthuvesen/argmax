import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { optionName } from "../../test/optionName.js";
import { PROVIDER_MODELS, type ProviderModelSelection } from "../../shared/providerModels.js";
import { LAUNCH_MODEL_RECENCY_KEY } from "../lib/launchModelPreference.js";
import { LaunchModelSelector, ModelSelector, type ProviderAvailability } from "./ModelSelector.js";
import type { ModelPickerSelection } from "../lib/models.js";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(LAUNCH_MODEL_RECENCY_KEY);
});

const HAIKU: ProviderModelSelection = { label: "Haiku 4.5", modelId: "claude-haiku-4-5" };
const OPUS_MEDIUM: ProviderModelSelection = {
  label: "Opus 5",
  modelId: "claude-opus-5",
  reasoningEffort: "medium"
};

function openClaudePicker(value: ProviderModelSelection = HAIKU): ReturnType<typeof vi.fn> {
  const onChange = vi.fn();
  render(<ModelSelector ariaLabel="Chat model" provider="claude" value={value} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Chat model" }));
  return onChange;
}

describe("ModelSelector — one row per model", () => {
  it("lists one row per model, not one per effort", () => {
    openClaudePicker();
    const list = screen.getByRole("listbox", { name: "Chat model" });
    // Four Claude models: Fable 5.1, Opus 5, Sonnet, Haiku.
    expect(within(list).getAllByRole("option")).toHaveLength(4);
    expect(within(list).getByText("Fable 5.1")).toBeInTheDocument();
    expect(within(list).getByText("Opus 5")).toBeInTheDocument();
    expect(within(list).getByText("Sonnet 5")).toBeInTheDocument();
    expect(within(list).getByText("Haiku 4.5")).toBeInTheDocument();
  });

  it("keeps GPT-6 Astra above Sol in the Codex picker", () => {
    const value: ProviderModelSelection = {
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "medium"
    };
    render(<ModelSelector ariaLabel="Chat model" provider="codex" value={value} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));

    const options = within(screen.getByRole("listbox", { name: "Chat model" })).getAllByRole("option");
    expect(options.map((option) => optionName(option))).toEqual([
      "GPT-6 Astra",
      "GPT-5.6 Sol",
      "GPT-5.6 Terra",
      "GPT-5.6 Luna"
    ]);
  });

  it("picking a model row selects it with the default Medium effort", () => {
    const onChange = openClaudePicker();
    fireEvent.click(screen.getByText("Opus 5"));
    expect(onChange).toHaveBeenCalledWith({
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "medium"
    });
  });

  it("picking a fast model selects it with no effort", () => {
    const onChange = openClaudePicker({ label: "Opus 5", modelId: "claude-opus-5", reasoningEffort: "high" });
    fireEvent.click(screen.getByText("Haiku 4.5"));
    expect(onChange).toHaveBeenCalledWith({ label: "Haiku 4.5", modelId: "claude-haiku-4-5" });
  });

  it("shows recently picked models at the top without removing them from the catalog", () => {
    const onChange = openClaudePicker(OPUS_MEDIUM);
    fireEvent.click(screen.getByText("Haiku 4.5"));
    expect(onChange).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));
    const list = screen.getByRole("listbox", { name: "Chat model" });
    const recentHeader = within(list).getByText("Recent");
    const claudeHeader = within(list).getByText("Claude");
    expect(recentHeader.compareDocumentPosition(claudeHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    const labels = within(list)
      .getAllByRole("option")
      .map((option) => optionName(option));
    expect(labels).toEqual(["Haiku 4.5", "Fable 5.1", "Opus 5", "Sonnet 5", "Haiku 4.5"]);
  });

  it("splits Codex recents from the catalog with a Codex header", () => {
    window.localStorage.setItem(
      LAUNCH_MODEL_RECENCY_KEY,
      JSON.stringify(["codex:gpt-6-astra", "codex:gpt-5.6-luna", "codex:gpt-5.6-terra"])
    );
    const value: ProviderModelSelection = {
      label: "GPT-5.6 Terra",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "high"
    };
    render(<ModelSelector ariaLabel="Chat model" provider="codex" value={value} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));

    const list = screen.getByRole("listbox", { name: "Chat model" });
    const recentHeader = within(list).getByText("Recent");
    const codexHeader = within(list).getByText("Codex");
    expect(recentHeader.compareDocumentPosition(codexHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(within(list).getAllByRole("option").map((option) => optionName(option))).toEqual([
      "GPT-6 Astra",
      "GPT-5.6 Luna",
      "GPT-5.6 Terra",
      "GPT-6 Astra",
      "GPT-5.6 Sol",
      "GPT-5.6 Terra",
      "GPT-5.6 Luna"
    ]);
    expect(within(list).getAllByRole("option", { selected: true }).map((option) => optionName(option))).toEqual([
      "GPT-5.6 Terra",
      "GPT-5.6 Terra"
    ]);
  });

  it("shows at most three recent models before the full catalog", () => {
    window.localStorage.setItem(
      LAUNCH_MODEL_RECENCY_KEY,
      JSON.stringify([
        "opencode:opencode-go/deepseek-v4-flash",
        "opencode:opencode-go/deepseek-v4-pro",
        "grok:grok-4.5",
        "grok:grok-4.6",
        "cursor:claude-opus-5-thinking-medium",
        "codex:gpt-5.6-luna"
      ])
    );
    render(
      <LaunchModelSelector
        ariaLabel="Launch model"
        value={{ provider: "claude", ...OPUS_MEDIUM }}
        onChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));

    const labels = within(screen.getByRole("listbox", { name: "Launch model" }))
      .getAllByRole("option")
      .map((option) => optionName(option));
    expect(labels.slice(0, 3)).toEqual(["DeepSeek V4 Flash", "DeepSeek V4 Pro", "Grok 4.5"]);
    expect(labels).toContain("DeepSeek V4 Flash");
    expect(labels).toContain("Grok 4.5");
    expect(labels.indexOf("DeepSeek V4 Flash")).toBeLessThan(labels.lastIndexOf("DeepSeek V4 Flash"));
    expect(labels.indexOf("Grok 4.5")).toBeLessThan(labels.lastIndexOf("Grok 4.5"));
    expect(labels.slice(3, 4)).toEqual(["Fable 5.1"]);
  });
});

describe("Cursor Auto models", () => {
  const autoModels = [
    { label: "Auto Cost (Cursor)", modelId: "auto-smart[optimize_for=cost]" },
    { label: "Auto Balance (Cursor)", modelId: "auto-smart[optimize_for=balanced]" },
    { label: "Auto Intelligence (Cursor)", modelId: "auto-smart[optimize_for=intelligence]" }
  ];

  it("places Auto modes before the other Cursor models in the launch catalog", () => {
    render(<LaunchModelSelector ariaLabel="Launch model" value={{ provider: "claude", ...OPUS_MEDIUM }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    const cursorLabels = within(screen.getByRole("listbox", { name: "Launch model" }))
      .getAllByRole("option")
      .map((option) => optionName(option))
      .filter((label) => label?.includes("(Cursor)"));
    expect(cursorLabels.slice(0, 4)).toEqual([...autoModels.map((model) => model.label), "Composer 2.5 (Cursor)"]);
  });

  it.each(autoModels)("selects $label without effort or speed overrides", (model) => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ModelSelector ariaLabel="Chat model" provider="cursor" value={{ label: "Grok 4.6 (Cursor)", modelId: "cursor-grok-4.6-medium", reasoningEffort: "high" }} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));
    fireEvent.click(within(screen.getByRole("option", { name: model.label })).getByRole("button", { name: model.label }));
    expect(onChange).toHaveBeenCalledWith(model);

    rerender(<ModelSelector ariaLabel="Chat model" provider="cursor" value={model} onChange={onChange} withEffortSlider fastModeEnabled onFastModeEnabledChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Chat model effort" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));
    expect(screen.queryByRole("button", { name: /Speed/ })).toBeNull();
  });
});

describe("ModelSelector type to filter", () => {
  it("focuses the currently selected model when opened so only one row is highlighted", () => {
    openClaudePicker(OPUS_MEDIUM);
    const list = screen.getByRole("listbox", { name: "Chat model" });
    const options = within(list).getAllByRole("option");
    // Four Claude models: Fable 5.1 (0), Opus 5 (1), Sonnet 5 (2), Haiku 4.5 (3)
    expect(options[0]).not.toHaveAttribute("data-active");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("data-active", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[2]).not.toHaveAttribute("data-active");
    expect(options[2]).toHaveAttribute("aria-selected", "false");
  });

  it("picks the currently selected model on immediate Enter without typing", () => {
    const onChange = openClaudePicker(OPUS_MEDIUM);
    const list = screen.getByRole("listbox", { name: "Chat model" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "medium"
    });
  });

  it("takes focus on open without panning ancestor scrollers", () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      openClaudePicker(OPUS_MEDIUM);
      const list = screen.getByRole("listbox", { name: "Chat model" });
      expect(document.activeElement).toBe(list);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      scrollIntoView.mockRestore();
      focus.mockRestore();
    }
  });

  it("takes focus on open so typing narrows the list instead of the input behind it", () => {
    openClaudePicker();
    const list = screen.getByRole("listbox", { name: "Chat model" });
    expect(document.activeElement).toBe(list);

    fireEvent.keyDown(list, { key: "h" });

    expect(within(list).getByText("Haiku 4.5")).toBeInTheDocument();
    expect(within(list).queryByText("Opus 5")).not.toBeInTheDocument();
    // The query is echoed with a match count. A list that silently shrank
    // would leave the user guessing.
    expect(within(list).getByText("h")).toBeInTheDocument();
    expect(within(list).getByText("1 of 4")).toBeInTheDocument();
  });

  it("picks the highlighted match on Enter", () => {
    const onChange = openClaudePicker();
    const list = screen.getByRole("listbox", { name: "Chat model" });

    fireEvent.keyDown(list, { key: "o" });
    fireEvent.keyDown(list, { key: "p" });
    fireEvent.keyDown(list, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith({
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "medium"
    });
  });

  it("backspaces out of a query that matches nothing", () => {
    openClaudePicker();
    const list = screen.getByRole("listbox", { name: "Chat model" });

    fireEvent.keyDown(list, { key: "z" });
    expect(within(list).getByText("No models match")).toBeInTheDocument();

    fireEvent.keyDown(list, { key: "Backspace" });
    expect(within(list).getAllByRole("option")).toHaveLength(4);
    expect(within(list).queryByText("No models match")).not.toBeInTheDocument();
  });

  it("forgets the query when the picker closes", () => {
    openClaudePicker();
    const list = screen.getByRole("listbox", { name: "Chat model" });
    fireEvent.keyDown(list, { key: "h" });
    expect(within(list).getAllByRole("option")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat model" }));

    const reopened = screen.getByRole("listbox", { name: "Chat model" });
    expect(within(reopened).getAllByRole("option")).toHaveLength(4);
  });

  it("does not duplicate recent catalog twins when filtering", () => {
    window.localStorage.setItem(LAUNCH_MODEL_RECENCY_KEY, JSON.stringify(["cursor:composer-2.5"]));
    const value: ModelPickerSelection = {
      provider: "claude",
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "medium"
    };
    render(<LaunchModelSelector ariaLabel="Launch model" value={value} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    const list = screen.getByRole("listbox", { name: "Launch model" });

    fireEvent.keyDown(list, { key: "c" });
    fireEvent.keyDown(list, { key: "o" });
    fireEvent.keyDown(list, { key: "m" });
    fireEvent.keyDown(list, { key: "p" });
    fireEvent.keyDown(list, { key: "o" });
    fireEvent.keyDown(list, { key: "s" });
    fireEvent.keyDown(list, { key: "e" });
    fireEvent.keyDown(list, { key: "r" });

    expect(within(list).getByText(/^2 of \d+$/)).toBeInTheDocument();
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    expect(within(list).getAllByText("Composer 2.5")).toHaveLength(2);
  });
});

describe("LaunchModelSelector — all providers", () => {
  it("groups models by provider and keeps Cursor model ids intact", () => {
    const value: ModelPickerSelection = {
      provider: "cursor",
      label: "GPT-5.6 Sol (Cursor)",
      modelId: "gpt-5.6-sol-medium",
      reasoningEffort: "medium"
    };
    render(<LaunchModelSelector ariaLabel="Launch model" value={value} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    // Every provider heads its own group, and a row under a provider header
    // drops the "(Cursor)" suffix the catalog label carries.
    for (const provider of ["Claude", "Codex", "Cursor", "OpenCode", "Grok Build"]) {
      expect(screen.getByText(provider)).toBeInTheDocument();
    }
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.getAllByText("GPT-5.6 Sol")).toHaveLength(2);
    expect(within(screen.getByRole("listbox", { name: "Launch model" })).queryByText("GPT-5.6 Sol (Cursor)")).not.toBeInTheDocument();
    // The chosen row is the one carrying the check, not a fill.
    const chosen = screen.getByRole("option", { selected: true });
    expect(chosen).toHaveTextContent("GPT-5.6 Sol");
    expect(chosen.querySelector(".picker-lead svg")).not.toBeNull();
  });

  it("shows speed in the model picker and toggles fast mode", () => {
    const value: ModelPickerSelection = {
      provider: "codex",
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "medium"
    };
    const onFastModeEnabledChange = vi.fn();
    render(
      <LaunchModelSelector
        ariaLabel="Launch model"
        value={value}
        onChange={vi.fn()}
        fastModeEnabled={false}
        onFastModeEnabledChange={onFastModeEnabledChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    fireEvent.click(screen.getByRole("button", { name: "Speed" }));
    const speedMenu = screen.getByRole("listbox", { name: "Speed" });
    expect(
      within(speedMenu)
        .getAllByRole("option")
        .map((option) => optionName(option))
    ).toEqual(["Standard", "Fast"]);
    fireEvent.click(within(speedMenu).getByRole("button", { name: "Fast" }));

    expect(onFastModeEnabledChange).toHaveBeenCalledWith(true);
  });

  // Both boxes are placed by `useAnchoredPopover` — the flyout against the
  // chip, the Speed submenu against its own row. jsdom has no layout to check
  // where they land, so this pins the wiring: each carries the primitive's
  // inline positioning rather than falling back to a hard-coded side in CSS,
  // which is what used to leave the flyout clipped at the viewport edge.
  it("positions the model flyout and speed submenu with the shared primitive", () => {
    const value: ModelPickerSelection = {
      provider: "codex",
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high"
    };
    render(
      <LaunchModelSelector
        ariaLabel="Launch model"
        value={value}
        onChange={vi.fn()}
        fastModeEnabled={false}
        onFastModeEnabledChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    const flyout = screen.getByRole("listbox", { name: "Launch model" }).parentElement;
    expect(flyout).toHaveStyle({ position: "absolute" });

    fireEvent.click(screen.getByRole("button", { name: "Speed" }));
    expect(screen.getByRole("listbox", { name: "Speed" })).toHaveStyle({ position: "absolute" });
  });

  it("marks fast mode in the closed chip for a supported model", () => {
    const value: ModelPickerSelection = {
      provider: "codex",
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "medium"
    };
    render(
      <LaunchModelSelector
        ariaLabel="Launch model"
        value={value}
        onChange={vi.fn()}
        fastModeEnabled={true}
        onFastModeEnabledChange={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Launch model" })).toHaveAttribute("title", "GPT-5.6 Sol · Fast speed");
  });

  const unsupportedFastModeModels = (["claude", "cursor", "opencode", "grok"] as const).flatMap((provider) =>
    PROVIDER_MODELS[provider].map((model) => ({ provider, ...model }))
  );

  it.each(unsupportedFastModeModels)(
    "hides fast mode for $provider $label",
    ({ provider, label, modelId, supportsReasoningEffort }) => {
      const value: ModelPickerSelection = {
        provider,
        label,
        modelId,
        ...(supportsReasoningEffort ? { reasoningEffort: "medium" } : {})
      };
      const onFastModeEnabledChange = vi.fn();
      render(
        <LaunchModelSelector
          ariaLabel="Launch model"
          value={value}
          onChange={vi.fn()}
          fastModeEnabled={true}
          onFastModeEnabledChange={onFastModeEnabledChange}
        />
      );

      expect(screen.getByRole("button", { name: "Launch model" }).getAttribute("title")).not.toContain("Fast speed");
      fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
      expect(screen.queryByRole("button", { name: "Speed" })).toBeNull();
      expect(screen.queryByRole("listbox", { name: "Speed" })).toBeNull();
      expect(onFastModeEnabledChange).not.toHaveBeenCalled();
    }
  );

  it("selecting a Cursor model keeps the stored fast preference", () => {
    const value: ModelPickerSelection = {
      provider: "claude",
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "medium"
    };
    const onChange = vi.fn();
    const onFastModeEnabledChange = vi.fn();
    render(
      <LaunchModelSelector
        ariaLabel="Launch model"
        value={value}
        onChange={onChange}
        fastModeEnabled={true}
        onFastModeEnabledChange={onFastModeEnabledChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    fireEvent.click(screen.getByRole("button", { name: "GPT-5.6 Sol (Cursor)" }));

    expect(onFastModeEnabledChange).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({
      provider: "cursor",
      label: "GPT-5.6 Sol (Cursor)",
      modelId: "gpt-5.6-sol-medium",
      reasoningEffort: "medium"
    });
  });

  it.each([
    { label: "GPT-6 Astra", modelId: "gpt-6-astra" },
    { label: "GPT-5.6 Sol", modelId: "gpt-5.6-sol" },
    { label: "GPT-5.6 Terra", modelId: "gpt-5.6-terra" },
    { label: "GPT-5.6 Luna", modelId: "gpt-5.6-luna" }
  ])("offers fast mode for Codex $label", ({ label, modelId }) => {
    const value: ModelPickerSelection = {
      provider: "codex",
      label,
      modelId,
      reasoningEffort: "medium"
    };
    const onFastModeEnabledChange = vi.fn();
    render(
      <LaunchModelSelector
        ariaLabel="Launch model"
        value={value}
        onChange={vi.fn()}
        fastModeEnabled={false}
        onFastModeEnabledChange={onFastModeEnabledChange}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    fireEvent.click(screen.getByRole("button", { name: "Speed" }));
    const speedMenu = screen.getByRole("listbox", { name: "Speed" });
    const fastButton = within(speedMenu).getByRole("button", { name: "Fast" });
    expect(fastButton).toBeEnabled();
    fireEvent.click(fastButton);
    expect(onFastModeEnabledChange).toHaveBeenCalledWith(true);
  });
});

describe("LaunchModelSelector — provider availability gating", () => {
  // The Codex row, by name: annotated ("… not installed") when gated, and never the Cursor twin.
  const CODEX_SOL_ROW = /^GPT-5\.6 Sol(?! \(Cursor\))/;
  const CLAUDE_VALUE: ModelPickerSelection = {
    provider: "claude",
    label: "Opus 5",
    modelId: "claude-opus-5",
    reasoningEffort: "medium"
  };

  function openLauncher(availability?: ProviderAvailability): ReturnType<typeof vi.fn> {
    const onChange = vi.fn();
    render(
      <LaunchModelSelector
        ariaLabel="Launch model"
        availability={availability}
        value={CLAUDE_VALUE}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    return onChange;
  }

  it("leaves every model selectable when availability is unknown (optimistic)", () => {
    openLauncher(undefined);
    const codexRow = screen.getByRole("button", { name: CODEX_SOL_ROW }).closest("li");
    expect(codexRow).not.toHaveAttribute("data-disabled");
    expect(codexRow && within(codexRow).getAllByRole("button")[0]).toBeEnabled();
  });

  it("disables and annotates an uninstalled provider's models", () => {
    openLauncher({
      claude: { installed: true, authenticated: true },
      codex: { installed: false, authenticated: null },
      cursor: { installed: true, authenticated: true }
    });
    const codexRow = screen.getByRole("button", { name: CODEX_SOL_ROW }).closest("li");
    expect(codexRow).toHaveAttribute("data-disabled", "true");
    expect(codexRow && within(codexRow).getByText("not installed")).toBeInTheDocument();
    // The row's primary button is disabled, so it can't be chosen.
    expect(codexRow && within(codexRow).getAllByRole("button")[0]).toBeDisabled();
  });

  it("does not fire onChange when an uninstalled model row is clicked", () => {
    const onChange = openLauncher({
      claude: { installed: true, authenticated: true },
      codex: { installed: false, authenticated: null },
      cursor: { installed: true, authenticated: true }
    });
    fireEvent.click(screen.getByRole("button", { name: CODEX_SOL_ROW }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("annotates an installed-but-unauthenticated provider while keeping it selectable", () => {
    const onChange = openLauncher({
      claude: { installed: true, authenticated: true },
      codex: { installed: true, authenticated: false },
      cursor: { installed: true, authenticated: true }
    });
    const codexRow = screen.getByRole("button", { name: CODEX_SOL_ROW }).closest("li");
    expect(codexRow).not.toHaveAttribute("data-disabled");
    expect(codexRow && within(codexRow).getByText("needs login")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: CODEX_SOL_ROW }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("ModelSelector — standalone effort slider", () => {
  it("without withEffortSlider the chip shows just the model label, no slider", () => {
    render(<ModelSelector ariaLabel="Chat model" provider="claude" value={OPUS_MEDIUM} onChange={vi.fn()} />);
    const modelButton = screen.getByRole("button", { name: "Chat model" });
    expect(modelButton).toHaveTextContent("Opus 5");
    expect(modelButton).toHaveAttribute("title", "Opus 5");
    expect(screen.queryByRole("button", { name: "Chat model effort" })).toBeNull();
  });

  it("with withEffortSlider the model chip stays effort-free and a separate chip shows it", () => {
    render(
      <ModelSelector
        ariaLabel="Chat model"
        provider="claude"
        value={OPUS_MEDIUM}
        onChange={vi.fn()}
        withEffortSlider
      />
    );
    const modelButton = screen.getByRole("button", { name: "Chat model" });
    expect(modelButton).toHaveTextContent("Opus 5");
    expect(modelButton).toHaveAttribute("title", "Opus 5");
    expect(screen.getByRole("button", { name: "Chat model effort" })).toHaveTextContent("Medium");
  });

  it("hides the effort chip for a no-effort (fast) model", () => {
    render(
      <ModelSelector ariaLabel="Chat model" provider="claude" value={HAIKU} onChange={vi.fn()} withEffortSlider />
    );
    expect(screen.queryByRole("button", { name: "Chat model effort" })).toBeNull();
  });

  it("steps the slider live but commits the draft only on dismiss", () => {
    const onChange = vi.fn();
    render(
      <ModelSelector
        ariaLabel="Chat model"
        provider="claude"
        value={OPUS_MEDIUM}
        onChange={onChange}
        withEffortSlider
      />
    );
    const chip = screen.getByRole("button", { name: "Chat model effort" });
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Chat model effort" });

    // Claude spans low..ultra as indices 0..5; medium is 1.
    const slider = within(dialog).getByRole("slider", { name: "Reasoning effort" });
    expect(slider).toHaveAttribute("aria-valuenow", "1");
    expect(slider).toHaveAttribute("aria-valuemax", "5");

    // End jumps the slider to the far right → the draft reads Ultra live...
    fireEvent.keyDown(slider, { key: "End" });
    expect(slider).toHaveAttribute("aria-valuetext", "Ultra");
    // ...but the parent isn't touched and the chip in the toolbar stays put.
    expect(onChange).not.toHaveBeenCalled();
    expect(chip).toHaveTextContent("Medium");

    // A stop label under the rail jumps the draft straight to that level.
    fireEvent.click(within(dialog).getByRole("button", { name: "Set effort to Max" }));
    expect(slider).toHaveAttribute("aria-valuenow", "4");
    expect(slider).toHaveAttribute("aria-valuetext", "Max");
    fireEvent.keyDown(slider, { key: "End" });

    // Re-clicking the chip dismisses the picker and commits the final draft.
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "ultra"
    });
  });

  it("caps the Codex Astra/Sol/Terra effort slider at Ultra", () => {
    const value: ModelPickerSelection = {
      provider: "codex",
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "medium"
    };
    render(<LaunchModelSelector ariaLabel="Chat model" value={value} onChange={vi.fn()} withEffortSlider />);
    fireEvent.click(screen.getByRole("button", { name: "Chat model effort" }));
    const dialog = screen.getByRole("dialog", { name: "Chat model effort" });
    expect(within(dialog).getByRole("slider", { name: "Reasoning effort" })).toHaveAttribute("aria-valuemax", "5");
  });

  it("caps the Codex Luna effort slider at Max", () => {
    const value: ModelPickerSelection = {
      provider: "codex",
      label: "GPT-5.6 Luna",
      modelId: "gpt-5.6-luna",
      reasoningEffort: "medium"
    };
    render(<LaunchModelSelector ariaLabel="Chat model" value={value} onChange={vi.fn()} withEffortSlider />);
    fireEvent.click(screen.getByRole("button", { name: "Chat model effort" }));
    const dialog = screen.getByRole("dialog", { name: "Chat model effort" });
    expect(within(dialog).getByRole("slider", { name: "Reasoning effort" })).toHaveAttribute("aria-valuemax", "4");
  });

  it("caps the Cursor GPT-5.6 effort slider at Max, same as Opus", () => {
    const gpt: ModelPickerSelection = {
      provider: "cursor",
      label: "GPT-5.6 Sol (Cursor)",
      modelId: "gpt-5.6-sol-medium",
      reasoningEffort: "medium"
    };
    const { unmount } = render(
      <LaunchModelSelector ariaLabel="Chat model" value={gpt} onChange={vi.fn()} withEffortSlider />
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat model effort" }));
    expect(
      within(screen.getByRole("dialog", { name: "Chat model effort" })).getByRole("slider", {
        name: "Reasoning effort"
      })
    ).toHaveAttribute("aria-valuemax", "4");
    unmount();

    const opus: ModelPickerSelection = {
      provider: "cursor",
      label: "Claude Opus 5 (Cursor)",
      modelId: "claude-opus-5-thinking-medium",
      reasoningEffort: "medium"
    };
    render(<LaunchModelSelector ariaLabel="Chat model" value={opus} onChange={vi.fn()} withEffortSlider />);
    fireEvent.click(screen.getByRole("button", { name: "Chat model effort" }));
    expect(
      within(screen.getByRole("dialog", { name: "Chat model effort" })).getByRole("slider", {
        name: "Reasoning effort"
      })
    ).toHaveAttribute("aria-valuemax", "4");
  });
});

describe("LaunchModelSelector — effort carries across model switches", () => {
  function openWith(value: ModelPickerSelection): ReturnType<typeof vi.fn> {
    const onChange = vi.fn();
    render(<LaunchModelSelector ariaLabel="Launch model" value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    return onChange;
  }

  it("keeps a Claude Max selection when switching to Codex Sol", () => {
    const onChange = openWith({
      provider: "claude",
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "max"
    });
    fireEvent.click(screen.getByRole("button", { name: "GPT-5.6 Sol" }));
    expect(onChange).toHaveBeenCalledWith({
      provider: "codex",
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "max"
    });
  });

  it("keeps a Claude Ultra selection when switching to Codex Sol", () => {
    const onChange = openWith({
      provider: "claude",
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "ultra"
    });
    fireEvent.click(screen.getByRole("button", { name: "GPT-5.6 Sol" }));
    expect(onChange).toHaveBeenCalledWith({
      provider: "codex",
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "ultra"
    });
  });

  it("clamps Claude Ultra to Max switching to Codex Luna (its ceiling)", () => {
    const onChange = openWith({
      provider: "claude",
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "ultra"
    });
    fireEvent.click(screen.getByRole("button", { name: "GPT-5.6 Luna" }));
    expect(onChange).toHaveBeenCalledWith({
      provider: "codex",
      label: "GPT-5.6 Luna",
      modelId: "gpt-5.6-luna",
      reasoningEffort: "max"
    });
  });

  it("keeps Extra High (never promotes to Ultra) switching Codex → Claude", () => {
    const onChange = openWith({
      provider: "codex",
      label: "GPT-5.6 Sol",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "xhigh"
    });
    fireEvent.click(screen.getByText("Opus 5"));
    expect(onChange).toHaveBeenCalledWith({
      provider: "claude",
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "xhigh"
    });
  });

  it("clamps Claude Ultra to Max switching to Cursor Opus (its ceiling)", () => {
    const onChange = openWith({
      provider: "claude",
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "ultra"
    });
    fireEvent.click(screen.getByRole("button", { name: "Claude Opus 5 (Cursor)" }));
    expect(onChange).toHaveBeenCalledWith({
      provider: "cursor",
      label: "Claude Opus 5 (Cursor)",
      modelId: "claude-opus-5-thinking-medium",
      reasoningEffort: "max"
    });
  });

  it("carries no effort onto a fast model", () => {
    const onChange = openWith({
      provider: "claude",
      label: "Opus 5",
      modelId: "claude-opus-5",
      reasoningEffort: "ultra"
    });
    fireEvent.click(screen.getByText("Haiku 4.5"));
    expect(onChange).toHaveBeenCalledWith({
      provider: "claude",
      label: "Haiku 4.5",
      modelId: "claude-haiku-4-5"
    });
  });
});
