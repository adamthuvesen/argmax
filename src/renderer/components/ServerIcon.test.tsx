// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setActivityIconColorMode } from "../lib/activityIconColorMode.js";
import { serverIconFor } from "../lib/serverIcons.js";
import { ServerIcon } from "./ServerIcon.js";

afterEach(() => {
  cleanup();
  setActivityIconColorMode("color");
});

it.each(["engram", "linear", "datadog", "shunt", "trace", "hex", "executor", "google calendar"])(
  "switches %s to a bare glyph and restores its color badge",
  (server) => {
    setActivityIconColorMode("color");
    const icon = serverIconFor(server)!;
    render(<ServerIcon server={server} />);
    const svg = screen.getByRole("img", { name: icon.title });
    expect(svg.querySelectorAll("path")).toHaveLength(icon.layers.length);
    act(() => setActivityIconColorMode("monochrome"));
    expect(svg).toHaveAttribute("viewBox", icon.monochrome!.viewBox);
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.querySelector("path")).toHaveAttribute("d", icon.monochrome!.layers[0].path);
    act(() => setActivityIconColorMode("color"));
    expect(svg).toHaveAttribute("viewBox", icon.viewBox);
    expect(svg.querySelectorAll("path")).toHaveLength(icon.layers.length);
  }
);
