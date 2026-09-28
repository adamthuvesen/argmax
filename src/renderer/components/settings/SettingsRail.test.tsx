import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsRail } from "./SettingsRail.js";

afterEach(cleanup);

it("finds settings with typos and terms spread across section and group", () => {
  const onOpenSection = vi.fn();
  render(<SettingsRail active="general" onChange={vi.fn()} onBack={vi.fn()} onOpenSection={onOpenSection} />);
  const input = screen.getByRole("searchbox", { name: "Search settings" });
  fireEvent.change(input, { target: { value: "notificatons" } });
  expect(screen.getByRole("button", { name: "Notifications General" })).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "appearance typography" } });
  fireEvent.click(screen.getByRole("button", { name: "Typography Appearance" }));
  expect(onOpenSection).toHaveBeenCalledWith("appearance", "settings-typography");
});

it("finds a setting row inside a section and opens that section", () => {
  const onOpenSection = vi.fn();
  render(<SettingsRail active="general" onChange={vi.fn()} onBack={vi.fn()} onOpenSection={onOpenSection} />);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "Fast" } });
  fireEvent.click(screen.getByRole("button", { name: "Fast mode Agents · Defaults" }));
  expect(onOpenSection).toHaveBeenCalledWith("agents", "settings-agent-defaults");
});
