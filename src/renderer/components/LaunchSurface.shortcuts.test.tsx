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

  it("opens the model and project menus downward at the same height", async () => {
    render(launcher());
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Switch model" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });

    const modelMenu = screen.getByRole("listbox", { name: "Switch model" }).parentElement;
    const projectMenu = screen.getByRole("listbox", { name: "Select project" });
    expect(modelMenu).toHaveStyle({ position: "absolute", bottom: "auto" });
    expect(projectMenu).toHaveStyle({ position: "absolute", bottom: "auto" });
    // jsdom has no layout, so both caps land on the minimum scrollable height.
    // The match is the point: one ceiling, both below the chip.
    expect(modelMenu).toHaveStyle({ maxHeight: "120px" });
    expect(projectMenu).toHaveStyle({ maxHeight: "120px" });
  });

  it("anchors the project menu so its height can stay inside the viewport", async () => {
    render(launcher());
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));
    // Floating UI measures in autoUpdate, which waits a frame. jsdom has no
    // layout, so the cap lands on the minimum scrollable height.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    const list = screen.getByRole("listbox", { name: "Select project" });

    // The hook clears the stylesheet's far edges and writes the viewport cap
    // inline. A menu positioned only by `top: calc(100% + 6px)` has neither.
    expect(list).toHaveStyle({ bottom: "auto", right: "auto", position: "absolute" });
    expect(list.style.maxHeight).toBe("120px");
  });

  it("leaves the pickers alone when another pane holds focus", async () => {
    render(launcher({ isFocused: false }));
    await act(async () => {});

    fireEvent.keyDown(document, { key: "M", metaKey: true, shiftKey: true });
    expect(screen.queryByRole("listbox", { name: "Switch model" })).toBeNull();
  });
});
