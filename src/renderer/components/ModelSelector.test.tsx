import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import { LaunchModelSelector, ModelSelector, type ProviderAvailability } from "./ModelSelector.js";
import type { ModelPickerSelection } from "../lib/models.js";

afterEach(cleanup);

const HAIKU: ProviderModelSelection = { label: "Haiku 4.5", modelId: "claude-haiku-4-5" };
const OPUS_MEDIUM: ProviderModelSelection = {
  label: "Opus 4.8",
  modelId: "claude-opus-4-8",
  reasoningEffort: "medium"
};

function openClaudePicker(value: ProviderModelSelection = HAIKU): ReturnType<typeof vi.fn> {
  const onChange = vi.fn();
  render(<ModelSelector ariaLabel="Session model" provider="claude" value={value} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Session model" }));
  return onChange;
}

describe("ModelSelector — one row per model", () => {
  it("lists one row per model, not one per effort", () => {
    openClaudePicker();
    const list = screen.getByRole("listbox", { name: "Session model" });
    // Four Claude models: Fable, Opus, Sonnet, Haiku.
    expect(within(list).getAllByRole("option")).toHaveLength(4);
    expect(within(list).getByText("Fable 5")).toBeInTheDocument();
    expect(within(list).getByText("Opus 4.8")).toBeInTheDocument();
    expect(within(list).getByText("Sonnet 5")).toBeInTheDocument();
    expect(within(list).getByText("Haiku 4.5")).toBeInTheDocument();
  });

  it("picking a model row selects it with the default Medium effort", () => {
    const onChange = openClaudePicker();
    fireEvent.click(screen.getByText("Opus 4.8"));
    expect(onChange).toHaveBeenCalledWith({
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
      reasoningEffort: "medium"
    });
  });

  it("picking a fast model selects it with no effort", () => {
    const onChange = openClaudePicker({ label: "Opus 4.8", modelId: "claude-opus-4-8", reasoningEffort: "high" });
    fireEvent.click(screen.getByText("Haiku 4.5"));
    expect(onChange).toHaveBeenCalledWith({ label: "Haiku 4.5", modelId: "claude-haiku-4-5" });
  });
});

describe("LaunchModelSelector — all providers", () => {
  it("groups models by provider and keeps Cursor model ids intact", () => {
    const value: ModelPickerSelection = {
      provider: "cursor",
      label: "GPT-5.5 (Cursor)",
      modelId: "gpt-5.5-medium",
      reasoningEffort: "medium"
    };
    render(<LaunchModelSelector ariaLabel="Launch model" value={value} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    // Providers are grouped by thin separators, not text labels — one before
    // Codex and one before Cursor, none above the first (Claude) group.
    expect(screen.queryByText("Claude")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
    expect(screen.queryByText("Cursor")).not.toBeInTheDocument();
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    expect(screen.getByText("GPT-5.5")).toBeInTheDocument();
  });

  it("shows speed in the model picker and toggles fast mode", () => {
    const value: ModelPickerSelection = {
      provider: "claude",
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
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
    fireEvent.click(screen.getByRole("button", { name: /Speed Standard/ }));
    const speedMenu = screen.getByRole("listbox", { name: "Speed" });
    expect(
      within(speedMenu)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["Standard", "Fast"]);
    fireEvent.click(within(speedMenu).getByRole("button", { name: "Fast" }));

    expect(onFastModeEnabledChange).toHaveBeenCalledWith(true);
  });

  it("anchors the speed submenu to the speed row", () => {
    const value: ModelPickerSelection = {
      provider: "claude",
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
      reasoningEffort: "high"
    };
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rect = (top: number, bottom: number) => ({
        x: 0,
        y: top,
        width: 300,
        height: bottom - top,
        top,
        right: 300,
        bottom,
        left: 0,
        toJSON: () => ({})
      });

      if (this.classList.contains("model-picker-popover")) return rect(100, 500);
      if (this.classList.contains("model-picker-submenu-trigger")) return rect(420, 460);
      return rect(0, 0);
    });

    try {
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
      fireEvent.click(screen.getByRole("button", { name: /Speed Standard/ }));

      const speedMenu = screen.getByRole("listbox", { name: "Speed" });
      expect(speedMenu.getAttribute("style") ?? "").toContain("--model-submenu-top: 320px");
      expect(speedMenu.getAttribute("style") ?? "").toContain("--model-submenu-bottom: 40px");
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("marks fast mode in the closed chip for supported providers", () => {
    const value: ModelPickerSelection = {
      provider: "claude",
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
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

    expect(screen.getByRole("button", { name: "Launch model" })).toHaveAttribute("title", "Opus 4.8 · Fast speed");
  });

  it("offers speed for fast-capable Cursor models (GPT-5.5)", () => {
    const value: ModelPickerSelection = {
      provider: "cursor",
      label: "GPT-5.5 (Cursor)",
      modelId: "gpt-5.5-medium",
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
    fireEvent.click(screen.getByRole("button", { name: /Speed Standard/ }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Speed" })).getByRole("button", { name: "Fast" }));
    expect(onFastModeEnabledChange).toHaveBeenCalledWith(true);
  });

  it("hides speed for Gemini (the one Cursor model without a fast variant)", () => {
    const value: ModelPickerSelection = {
      provider: "cursor",
      label: "Gemini 3.5 Flash (Cursor)",
      modelId: "gemini-3.5-flash"
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
    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    expect(screen.queryByRole("button", { name: /Speed/ })).toBeNull();
    expect(onFastModeEnabledChange).not.toHaveBeenCalled();
  });

  it("selecting a Cursor model keeps the stored fast preference", () => {
    const value: ModelPickerSelection = {
      provider: "claude",
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
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
    fireEvent.click(screen.getByText("GPT-5.5 (Cursor)"));

    expect(onFastModeEnabledChange).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({
      provider: "cursor",
      label: "GPT-5.5 (Cursor)",
      modelId: "gpt-5.5-medium",
      reasoningEffort: "medium"
    });
  });

  it("offers fast mode for Codex selections", () => {
    const value: ModelPickerSelection = {
      provider: "codex",
      label: "GPT-5.5",
      modelId: "gpt-5.5",
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
    fireEvent.click(screen.getByRole("button", { name: /Speed Standard/ }));
    const speedMenu = screen.getByRole("listbox", { name: "Speed" });
    const fastButton = within(speedMenu).getByRole("button", { name: "Fast" });
    expect(fastButton).toBeEnabled();
    fireEvent.click(fastButton);
    expect(onFastModeEnabledChange).toHaveBeenCalledWith(true);
  });
});

describe("LaunchModelSelector — provider availability gating", () => {
  const CLAUDE_VALUE: ModelPickerSelection = {
    provider: "claude",
    label: "Opus 4.8",
    modelId: "claude-opus-4-8",
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
    const codexRow = screen.getByText("GPT-5.5").closest("li");
    expect(codexRow).not.toHaveAttribute("data-disabled");
    expect(codexRow && within(codexRow).getAllByRole("button")[0]).toBeEnabled();
  });

  it("disables and annotates an uninstalled provider's models", () => {
    openLauncher({
      claude: { installed: true, authenticated: true },
      codex: { installed: false, authenticated: null },
      cursor: { installed: true, authenticated: true }
    });
    const codexRow = screen.getByText("GPT-5.5").closest("li");
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
    fireEvent.click(screen.getByText("GPT-5.5"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("annotates an installed-but-unauthenticated provider while keeping it selectable", () => {
    const onChange = openLauncher({
      claude: { installed: true, authenticated: true },
      codex: { installed: true, authenticated: false },
      cursor: { installed: true, authenticated: true }
    });
    const codexRow = screen.getByText("GPT-5.5").closest("li");
    expect(codexRow).not.toHaveAttribute("data-disabled");
    expect(codexRow && within(codexRow).getByText("needs login")).toBeInTheDocument();
    fireEvent.click(screen.getByText("GPT-5.5"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("ModelSelector — standalone effort slider", () => {
  it("without withEffortSlider the chip shows just the model label, no slider", () => {
    render(<ModelSelector ariaLabel="Session model" provider="claude" value={OPUS_MEDIUM} onChange={vi.fn()} />);
    const modelButton = screen.getByRole("button", { name: "Session model" });
    expect(modelButton).toHaveTextContent("Opus 4.8");
    expect(modelButton).toHaveAttribute("title", "Opus 4.8");
    expect(screen.queryByRole("button", { name: "Session model effort" })).toBeNull();
  });

  it("with withEffortSlider the model chip stays effort-free and a separate chip shows it", () => {
    render(
      <ModelSelector
        ariaLabel="Session model"
        provider="claude"
        value={OPUS_MEDIUM}
        onChange={vi.fn()}
        withEffortSlider
      />
    );
    const modelButton = screen.getByRole("button", { name: "Session model" });
    expect(modelButton).toHaveTextContent("Opus 4.8");
    expect(modelButton).toHaveAttribute("title", "Opus 4.8");
    expect(screen.getByRole("button", { name: "Session model effort" })).toHaveTextContent("Medium");
  });

  it("hides the effort chip for a no-effort (fast) model", () => {
    render(
      <ModelSelector ariaLabel="Session model" provider="claude" value={HAIKU} onChange={vi.fn()} withEffortSlider />
    );
    expect(screen.queryByRole("button", { name: "Session model effort" })).toBeNull();
  });

  it("steps the slider live but commits the draft only on dismiss", () => {
    const onChange = vi.fn();
    render(
      <ModelSelector
        ariaLabel="Session model"
        provider="claude"
        value={OPUS_MEDIUM}
        onChange={onChange}
        withEffortSlider
      />
    );
    const chip = screen.getByRole("button", { name: "Session model effort" });
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Session model effort" });

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

    // Re-clicking the chip dismisses the picker and commits the final draft.
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
      reasoningEffort: "ultra"
    });
  });

  it("caps the Codex effort slider at Extra High", () => {
    const value: ModelPickerSelection = {
      provider: "codex",
      label: "GPT-5.5",
      modelId: "gpt-5.5",
      reasoningEffort: "medium"
    };
    render(<LaunchModelSelector ariaLabel="Session model" value={value} onChange={vi.fn()} withEffortSlider />);
    fireEvent.click(screen.getByRole("button", { name: "Session model effort" }));
    const dialog = screen.getByRole("dialog", { name: "Session model effort" });
    expect(within(dialog).getByRole("slider", { name: "Reasoning effort" })).toHaveAttribute("aria-valuemax", "3");
  });

  it("caps the Cursor GPT-5.5 effort slider at Extra High, Opus at Max", () => {
    const gpt: ModelPickerSelection = {
      provider: "cursor",
      label: "GPT-5.5 (Cursor)",
      modelId: "gpt-5.5-medium",
      reasoningEffort: "medium"
    };
    const { unmount } = render(
      <LaunchModelSelector ariaLabel="Session model" value={gpt} onChange={vi.fn()} withEffortSlider />
    );
    fireEvent.click(screen.getByRole("button", { name: "Session model effort" }));
    expect(
      within(screen.getByRole("dialog", { name: "Session model effort" })).getByRole("slider", {
        name: "Reasoning effort"
      })
    ).toHaveAttribute("aria-valuemax", "3");
    unmount();

    // Cursor's Opus exposes one more level (Max) than GPT-5.5.
    const opus: ModelPickerSelection = {
      provider: "cursor",
      label: "Claude Opus 4.8 (Cursor)",
      modelId: "claude-opus-4-8-medium",
      reasoningEffort: "medium"
    };
    render(<LaunchModelSelector ariaLabel="Session model" value={opus} onChange={vi.fn()} withEffortSlider />);
    fireEvent.click(screen.getByRole("button", { name: "Session model effort" }));
    expect(
      within(screen.getByRole("dialog", { name: "Session model effort" })).getByRole("slider", {
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

  it("clamps a Claude Max selection down to Extra High switching to Codex", () => {
    const onChange = openWith({
      provider: "claude",
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
      reasoningEffort: "max"
    });
    fireEvent.click(screen.getByText("GPT-5.5"));
    expect(onChange).toHaveBeenCalledWith({
      provider: "codex",
      label: "GPT-5.5",
      modelId: "gpt-5.5",
      reasoningEffort: "xhigh"
    });
  });

  it("keeps Extra High (never promotes to Ultra) switching Codex → Claude", () => {
    const onChange = openWith({
      provider: "codex",
      label: "GPT-5.5",
      modelId: "gpt-5.5",
      reasoningEffort: "xhigh"
    });
    fireEvent.click(screen.getByText("Opus 4.8"));
    expect(onChange).toHaveBeenCalledWith({
      provider: "claude",
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
      reasoningEffort: "xhigh"
    });
  });

  it("clamps Claude Ultra to Max switching to Cursor Opus (its ceiling)", () => {
    const onChange = openWith({
      provider: "claude",
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
      reasoningEffort: "ultra"
    });
    fireEvent.click(screen.getByText("Claude Opus 4.8 (Cursor)"));
    expect(onChange).toHaveBeenCalledWith({
      provider: "cursor",
      label: "Claude Opus 4.8 (Cursor)",
      modelId: "claude-opus-4-8-medium",
      reasoningEffort: "max"
    });
  });

  it("carries no effort onto a fast model", () => {
    const onChange = openWith({
      provider: "claude",
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
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
