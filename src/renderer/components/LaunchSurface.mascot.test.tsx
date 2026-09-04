import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { LaunchSurface } from "./LaunchSurface.js";
import { preferredLaunchModel } from "../lib/models.js";
import { primaryProject, setupAppTestMocks } from "../../test/appTestHarness.js";

async function renderLauncher(hasRunningSession = false): Promise<void> {
  render(
    <LaunchSurface
      hasRunningSession={hasRunningSession}
      model={preferredLaunchModel([])}
      onAddProject={() => undefined}
      onBranchSwitch={() => undefined}
      onLaunchTask={() => Promise.resolve()}
      onModelChange={() => undefined}
      onSelectProject={() => undefined}
      project={primaryProject()}
      projects={[primaryProject()]}
    />
  );
  // Mounting kicks off provider discovery and a branch read; settle them so
  // their state updates land inside the test rather than after the assertions.
  await act(async () => {});
}

function heroFox(): HTMLElement {
  return screen.getByRole("button", { name: /^Fox mascot/ });
}

function heroSprite(): SVGElement {
  const svg = heroFox().querySelector("svg");
  if (!svg) throw new Error("The launcher hero should render a mascot sprite");
  return svg;
}

describe("launcher hero mascot", () => {
  beforeEach(() => {
    setupAppTestMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("thinks while an agent is running in this project", async () => {
    await renderLauncher(true);
    expect(heroSprite().getAttribute("data-mood")).toBe("thinking");
  });

  it("dozes off after a long untouched stretch and wakes on a keystroke", async () => {
    // Fake timers before mounting: the doze countdown is armed by a mount
    // effect, so a clock swapped in afterwards would never own that timer.
    vi.useFakeTimers();
    await renderLauncher();
    expect(heroSprite().getAttribute("data-mood")).toBe("idle");

    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(heroSprite().getAttribute("data-mood")).toBe("sleepy");
    expect(heroSprite().getAttribute("data-sprite")).toBe("sleepy");

    act(() => {
      fireEvent.keyDown(heroFox(), { key: "a" });
    });
    expect(heroSprite().getAttribute("data-mood")).toBe("idle");
  });

  it("puts the sunglasses on after ten pets in a row", async () => {
    await renderLauncher();
    const fox = heroFox();
    for (let pet = 0; pet < 10; pet += 1) {
      act(() => {
        fireEvent.click(fox);
      });
    }
    expect(heroSprite().getAttribute("data-sprite")).toBe("shades");
  });

  it("leaves the sunglasses off at nine pets", async () => {
    await renderLauncher();
    const fox = heroFox();
    for (let pet = 0; pet < 9; pet += 1) {
      act(() => {
        fireEvent.click(fox);
      });
    }
    expect(heroSprite().getAttribute("data-sprite")).not.toBe("shades");
  });
});
