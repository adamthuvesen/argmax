import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { primaryProject, setupAppTestMocks } from "../../test/appTestHarness.js";
import { preferredLaunchModel } from "../lib/models.js";
import { LaunchSurface } from "./LaunchSurface.js";

type LaunchSurfaceProps = ComponentProps<typeof LaunchSurface>;

function launcher(overrides: Partial<LaunchSurfaceProps> = {}): JSX.Element {
  const project = primaryProject();
  return (
    <LaunchSurface
      isFocused={false}
      model={preferredLaunchModel([])}
      onAddProject={() => undefined}
      onBranchSwitch={() => undefined}
      onLaunchTask={() => Promise.resolve()}
      onModelChange={() => undefined}
      onSelectProject={() => undefined}
      project={project}
      projects={[project]}
      {...overrides}
    />
  );
}

function focusedNeighbor(): HTMLTextAreaElement {
  const view = render(<textarea aria-label="Neighbor draft" />);
  const neighbor = within(view.container).getByRole<HTMLTextAreaElement>("textbox", {
    name: "Neighbor draft"
  });
  neighbor.focus();
  return neighbor;
}

describe("LaunchSurface focus ownership", () => {
  beforeEach(() => {
    setupAppTestMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not steal a neighboring draft when a background launcher mounts", async () => {
    const neighbor = focusedNeighbor();
    render(launcher());
    await act(async () => {});

    expect(screen.getByRole("textbox", { name: "Task prompt" })).not.toHaveFocus();
    expect(neighbor).toHaveFocus();
  });

  it("focuses its prompt when the launcher becomes active", async () => {
    const neighbor = focusedNeighbor();
    const view = render(launcher());
    await act(async () => {});
    expect(neighbor).toHaveFocus();

    view.rerender(launcher({ isFocused: true }));

    expect(screen.getByRole("textbox", { name: "Task prompt" })).toHaveFocus();
  });

  it("does not steal focus when a background launch finishes", async () => {
    let finishLaunch!: () => void;
    const launchFinished = new Promise<void>((resolve) => {
      finishLaunch = resolve;
    });
    const onLaunchTask = vi.fn(() => launchFinished);
    const view = render(launcher({ isFocused: true, onLaunchTask }));
    await act(async () => {});

    const prompt = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Task prompt" });
    expect(prompt).toHaveFocus();
    fireEvent.change(prompt, { target: { value: "Start the background agent" } });
    fireEvent.submit(prompt.closest("form")!);
    expect(onLaunchTask).toHaveBeenCalledOnce();
    expect(prompt).toBeDisabled();
    view.rerender(launcher({ isFocused: false, onLaunchTask }));
    const neighbor = focusedNeighbor();

    await act(async () => {
      finishLaunch();
      await launchFinished;
    });

    expect(prompt).toBeEnabled();
    expect(neighbor).toHaveFocus();
  });
});
