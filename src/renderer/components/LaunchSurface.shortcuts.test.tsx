import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, JSX } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { primaryProject, setupAppTestMocks } from "../../test/appTestHarness.js";
import { factoryLaunchModel } from "../lib/models.js";
import { LaunchSurface } from "./LaunchSurface.js";

type LaunchSurfaceProps = ComponentProps<typeof LaunchSurface>;

function launcher(overrides: Partial<LaunchSurfaceProps> = {}): JSX.Element {
  const project = primaryProject();
  return (
    <LaunchSurface
      model={factoryLaunchModel("medium")}
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

describe("LaunchSurface picker shortcuts", () => {
  beforeEach(() => {
    setupAppTestMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the model, effort and folder pickers from the composer draft", async () => {
    render(launcher());
    await act(async () => {});
    const prompt = screen.getByRole("textbox", { name: "Task prompt" });

    fireEvent.keyDown(prompt, { key: "M", metaKey: true, shiftKey: true });
    expect(screen.getByRole("listbox", { name: "Switch model" })).toBeInTheDocument();

    fireEvent.keyDown(prompt, { key: "E", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("listbox", { name: "Switch model" })).toBeNull();
    expect(screen.getByRole("slider", { name: "Reasoning effort" })).toHaveFocus();

    fireEvent.keyDown(prompt, { key: "R", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("slider", { name: "Reasoning effort" })).toBeNull();
    expect(screen.getByRole("listbox", { name: "Select project" })).toBeInTheDocument();

    fireEvent.keyDown(prompt, { key: "R", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("listbox", { name: "Select project" })).toBeNull();
  });

  it("leaves the pickers alone when another pane holds focus", async () => {
    render(launcher({ isFocused: false }));
    await act(async () => {});

    fireEvent.keyDown(document, { key: "M", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("listbox", { name: "Switch model" })).toBeNull();
  });
});
