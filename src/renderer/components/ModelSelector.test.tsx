import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
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
    // Four Claude models (Fable, Opus, Sonnet, Haiku) — the old picker had 12 rows.
    expect(within(list).getAllByRole("option")).toHaveLength(4);
    expect(within(list).getByText("Fable 5")).toBeInTheDocument();
    expect(within(list).getByText("Opus 4.8")).toBeInTheDocument();
    expect(within(list).getByText("Sonnet 5")).toBeInTheDocument();
    expect(within(list).getByText("Haiku 4.5")).toBeInTheDocument();
  });

  it("shows a default effort label for effort-capable models", () => {
    openClaudePicker();
    const list = screen.getByRole("listbox", { name: "Session model" });
    const opusRow = within(list).getByText("Opus 4.8").closest("li");
    // Default effort before any edit is Medium.
    expect(opusRow && within(opusRow).getByText("Medium")).toBeTruthy();
  });

  it("shows Edit on every effort-capable model", () => {
    openClaudePicker(OPUS_MEDIUM);
    expect(screen.getByRole("button", { name: "Edit effort for Opus 4.8" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit effort for Fable 5" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit effort for Sonnet 5" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Edit effort for Haiku 4.5" })).toBeNull();
  });

  it("gives fast models (Haiku) no Edit button and no effort", () => {
    openClaudePicker();
    const list = screen.getByRole("listbox", { name: "Session model" });
    expect(screen.queryByRole("button", { name: "Edit effort for Haiku 4.5" })).toBeNull();
    const haikuRow = within(list).getByText("Haiku 4.5").closest("li");
    expect(haikuRow && within(haikuRow).queryByText(/Medium|Low|High/)).toBeNull();
  });

  it("opens an effort submenu spanning Low → Extra High (no Max)", () => {
    openClaudePicker(OPUS_MEDIUM);
    fireEvent.click(screen.getByRole("button", { name: "Edit effort for Opus 4.8" }));
    const submenu = screen.getByRole("listbox", { name: "Reasoning effort" });
    const labels = within(submenu)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual(["Low", "Medium", "High", "Extra High"]);
    expect(within(submenu).queryByText("Max")).toBeNull();
  });

  it("selecting Extra High emits xhigh for the selected model", () => {
    const onChange = openClaudePicker(OPUS_MEDIUM);
    fireEvent.click(screen.getByRole("button", { name: "Edit effort for Opus 4.8" }));
    fireEvent.click(screen.getByRole("button", { name: "Extra High" }));
    expect(onChange).toHaveBeenCalledWith({
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
      reasoningEffort: "xhigh"
    });
  });

  it("clicking Edit on an unselected model selects it and opens effort", () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<ProviderModelSelection>(HAIKU);
      return (
        <ModelSelector
          ariaLabel="Session model"
          provider="claude"
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Session model" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit effort for Opus 4.8" }));

    expect(onChange).toHaveBeenCalledWith({
      label: "Opus 4.8",
      modelId: "claude-opus-4-8",
      reasoningEffort: "medium"
    });
    expect(screen.getByRole("button", { name: "Session model" })).toHaveAttribute("title", "Opus 4.8 · Medium");
    expect(screen.getByRole("listbox", { name: "Reasoning effort" })).toBeInTheDocument();
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

describe("ModelSelector — Cursor", () => {
  it("treats fast Cursor models as no-effort and keeps effort model edits available", () => {
    const value: ProviderModelSelection = { label: "Composer 2.5 (Cursor)", modelId: "composer-2.5" };
    render(<ModelSelector ariaLabel="Session model" provider="cursor" value={value} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Session model" }));
    expect(screen.queryByRole("button", { name: "Edit effort for Composer 2.5 (Cursor)" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit effort for Gemini 3.5 Flash (Cursor)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit effort for GPT-5.5 (Cursor)" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit effort for Claude Opus 4.8 (Cursor)" })).toBeEnabled();
  });
});

describe("LaunchModelSelector — all providers", () => {
  it("groups models by provider and keeps Cursor model ids intact", () => {
    // The Cursor model is selected so its effort is editable.
    const value: ModelPickerSelection = {
      provider: "cursor",
      label: "GPT-5.5 (Cursor)",
      modelId: "gpt-5.5-medium",
      reasoningEffort: "medium"
    };
    const onChange = vi.fn();
    render(<LaunchModelSelector ariaLabel="Launch model" value={value} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("GPT-5.5")).toBeInTheDocument();

    // Cursor effort is UI-only: selecting Extra High keeps the -medium alias id.
    fireEvent.click(screen.getByRole("button", { name: "Edit effort for GPT-5.5 (Cursor)" }));
    fireEvent.click(screen.getByRole("button", { name: "Extra High" }));
    expect(onChange).toHaveBeenCalledWith({
      provider: "cursor",
      label: "GPT-5.5 (Cursor)",
      modelId: "gpt-5.5-medium",
      reasoningEffort: "xhigh"
    });
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

  it("keeps effort and speed submenus mutually exclusive", () => {
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
        fastModeEnabled
        onFastModeEnabledChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    fireEvent.click(screen.getByRole("button", { name: /Speed Fast/ }));
    expect(screen.getByRole("listbox", { name: "Speed" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit effort for Opus 4.8" }));

    expect(screen.getByRole("listbox", { name: "Reasoning effort" })).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Speed" })).toBeNull();
  });

  it("anchors the speed submenu to the speed row instead of the selected model row", () => {
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
      if (this.getAttribute("aria-label") === "Edit effort for Opus 4.8") return rect(180, 220);
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

      fireEvent.click(screen.getByRole("button", { name: "Edit effort for Opus 4.8" }));

      const effortMenu = screen.getByRole("listbox", { name: "Reasoning effort" });
      expect(effortMenu.getAttribute("style") ?? "").toContain("--model-submenu-top: 80px");
      expect(effortMenu.getAttribute("style") ?? "").toContain("--model-submenu-bottom: 280px");
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

    expect(screen.getByRole("button", { name: "Launch model" })).toHaveAttribute(
      "title",
      "Opus 4.8 · Medium · Fast speed"
    );
  });

  it("hides speed and clears fast mode for Cursor selections", async () => {
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
        fastModeEnabled={true}
        onFastModeEnabledChange={onFastModeEnabledChange}
      />
    );

    expect(screen.getByRole("button", { name: "Launch model" })).toHaveAttribute(
      "title",
      "GPT-5.5 (Cursor) · Medium"
    );
    fireEvent.click(screen.getByRole("button", { name: "Launch model" }));
    expect(screen.queryByRole("button", { name: /Speed/ })).toBeNull();
    await waitFor(() => expect(onFastModeEnabledChange).toHaveBeenCalledWith(false));
  });

  it("selecting a Cursor model clears fast mode", () => {
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

    expect(onFastModeEnabledChange).toHaveBeenCalledWith(false);
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
