import { describe, expect, it, vi } from "vitest";
import { Check } from "lucide-react";
import { buildSettingCommands, type SettingCommandsInput } from "./settingCommands.js";
import { searchPaletteItems } from "./paletteSearch.js";

function inputWith(overrides: Partial<SettingCommandsInput> = {}): SettingCommandsInput {
  return {
    themeMode: "dark",
    onThemeModeChange: vi.fn(),
    accentId: "green",
    onAccentChange: vi.fn(),
    fontSize: 6,
    onFontSizeChange: vi.fn(),
    chatFontSize: 6,
    onChatFontSizeChange: vi.fn(),
    chatVerbosity: 3,
    onChatVerbosityChange: vi.fn(),
    chatWidth: 3,
    onChatWidthChange: vi.fn(),
    reviewPanelSide: "right",
    onReviewPanelSideChange: vi.fn(),
    fontFamily: "geist-sans",
    onFontFamilyChange: vi.fn(),
    fontHeaviness: 5,
    onFontHeavinessChange: vi.fn(),
    inkStrength: 7,
    onInkStrengthChange: vi.fn(),
    backgroundIntensity: 7,
    onBackgroundIntensityChange: vi.fn(),
    desktopNotificationsEnabled: true,
    onDesktopNotificationsEnabledChange: vi.fn(),
    keepAwakeEnabled: false,
    onKeepAwakeEnabledChange: vi.fn(),
    fastModeEnabled: false,
    onFastModeEnabledChange: vi.fn(),
    turnChangesExpanded: true,
    onTurnChangesExpandedChange: vi.fn(),
    contextIndicatorEnabled: false,
    onContextIndicatorEnabledChange: vi.fn(),
    ...overrides
  };
}

describe("buildSettingCommands", () => {
  it("applies a value row with the value it names", () => {
    const input = inputWith();
    const commands = buildSettingCommands(input);
    const byId = new Map(commands.map((command) => [command.id, command]));

    byId.get("setting:theme:light")!.run();
    byId.get("setting:accent:blue")!.run();
    byId.get("setting:chat-verbosity:4")!.run();
    byId.get("setting:chat-width:5")!.run();
    byId.get("setting:font-family:inter")!.run();
    byId.get("setting:files-panel-side:left")!.run();
    byId.get("setting:font-size:9")!.run();
    byId.get("setting:chat-font-size:2")!.run();
    byId.get("setting:font-heaviness:8")!.run();
    byId.get("setting:ink-strength:3")!.run();
    byId.get("setting:background-intensity:4")!.run();
    byId.get("setting:notifications:disable")!.run();
    byId.get("setting:keep-awake:enable")!.run();
    byId.get("setting:fast-mode:enable")!.run();
    byId.get("setting:changed-files:collapse")!.run();
    byId.get("setting:context-indicator:show")!.run();

    expect(input.onThemeModeChange).toHaveBeenCalledWith("light");
    expect(input.onAccentChange).toHaveBeenCalledWith("blue");
    expect(input.onChatVerbosityChange).toHaveBeenCalledWith(4);
    expect(input.onChatWidthChange).toHaveBeenCalledWith(5);
    expect(input.onFontFamilyChange).toHaveBeenCalledWith("inter");
    expect(input.onReviewPanelSideChange).toHaveBeenCalledWith("left");
    expect(input.onFontSizeChange).toHaveBeenCalledWith(9);
    expect(input.onChatFontSizeChange).toHaveBeenCalledWith(2);
    expect(input.onFontHeavinessChange).toHaveBeenCalledWith(8);
    expect(input.onInkStrengthChange).toHaveBeenCalledWith(3);
    expect(input.onBackgroundIntensityChange).toHaveBeenCalledWith(4);
    expect(input.onDesktopNotificationsEnabledChange).toHaveBeenCalledWith(false);
    expect(input.onKeepAwakeEnabledChange).toHaveBeenCalledWith(true);
    expect(input.onFastModeEnabledChange).toHaveBeenCalledWith(true);
    expect(input.onTurnChangesExpandedChange).toHaveBeenCalledWith(false);
    expect(input.onContextIndicatorEnabledChange).toHaveBeenCalledWith(true);
    expect(commands.every((command) => command.group === "Actions")).toBe(true);
    expect(byId.has("setting:chat-verbosity:5")).toBe(false);
    expect(byId.get("setting:chat-verbosity:4")?.subtitle).toContain("Verbosity 4 of 4");
  });

  it("marks only the current value of each setting with a check", () => {
    const commands = buildSettingCommands(inputWith({ themeMode: "system", chatVerbosity: 1 }));
    const checked = commands.filter((command) => command.icon === Check).map((command) => command.id);
    expect(checked).toEqual([
      "setting:theme:system",
      "setting:accent:green",
      "setting:chat-verbosity:1",
      "setting:font-family:geist-sans",
      "setting:files-panel-side:right",
      "setting:chat-width:3",
      "setting:font-size:6",
      "setting:chat-font-size:6",
      "setting:font-heaviness:5",
      "setting:ink-strength:7",
      "setting:background-intensity:7"
    ]);
  });

  it("keeps heaviness adjustments open and respects both limits", () => {
    for (const [level, direction] of [[1, "lighter"], [10, "heavier"]] as const) {
      const input = inputWith({ fontHeaviness: level });
      const command = buildSettingCommands(input).find((row) => row.id === `setting:font-heaviness:${direction}`)!;
      expect(command.keepOpen).toBe(true);
      command.run();
      expect(input.onFontHeavinessChange).not.toHaveBeenCalled();
    }
    const input = inputWith({ fontHeaviness: 5 });
    buildSettingCommands(input).find((row) => row.id === "setting:font-heaviness:heavier")!.run();
    expect(input.onFontHeavinessChange).toHaveBeenCalledWith(6);
  });

  it("steps a font size one notch and keeps the palette open", () => {
    const input = inputWith({ fontSize: 4, chatFontSize: 8 });
    const commands = buildSettingCommands(input);
    const byId = new Map(commands.map((command) => [command.id, command]));

    const larger = byId.get("setting:font-size:larger")!;
    const smaller = byId.get("setting:chat-font-size:smaller")!;
    expect(larger.keepOpen).toBe(true);
    expect(smaller.keepOpen).toBe(true);
    larger.run();
    smaller.run();
    expect(input.onFontSizeChange).toHaveBeenCalledWith(5);
    expect(input.onChatFontSizeChange).toHaveBeenCalledWith(7);
  });

  it("keeps both step rows at the bounds but leaves the value alone", () => {
    const input = inputWith({ fontSize: 10, chatFontSize: 1 });
    const byId = new Map(buildSettingCommands(input).map((command) => [command.id, command]));
    byId.get("setting:font-size:larger")!.run();
    byId.get("setting:chat-font-size:smaller")!.run();
    expect(input.onFontSizeChange).not.toHaveBeenCalled();
    expect(input.onChatFontSizeChange).not.toHaveBeenCalled();
    byId.get("setting:font-size:smaller")!.run();
    byId.get("setting:chat-font-size:larger")!.run();
    expect(input.onFontSizeChange).toHaveBeenCalledWith(9);
    expect(input.onChatFontSizeChange).toHaveBeenCalledWith(2);
  });

  it("is reachable by the words a user types", () => {
    const commands = buildSettingCommands(inputWith());
    const top = (query: string): string | undefined =>
      searchPaletteItems(commands, query)[0]?.item.label;
    expect(top("dark")).toBe("Dark theme");
    expect(top("blue accent")).toBe("Blue accent");
    expect(top("black accent")).toBe("Black accent");
    expect(top("chat detail 4")).toBe("Chat detail 4: Detailed");
    expect(top("verbosity 2")).toBe("Chat detail 2: Compact");
    expect(top("chat width 5")).toBe("Chat width 5");
    expect(top("font family inter")).toBe("Font family: Inter");
    expect(top("files panel left")).toBe("Files panel: left");
    expect(top("disable notifications")).toBe("Disable desktop notifications");
    expect(top("keep computer awake")).toBe("Enable keep computer awake");
    expect(top("fast mode")).toBe("Enable fast mode");
    expect(top("changed files")).toBe("Collapse changed files");
    expect(top("context indicator")).toBe("Show context indicator");
    expect(top("app font size 8")).toBe("App font size 8");
    expect(top("chat font 8")).toBe("Chat font size 8");
    expect(top("font size")).toBe("App font size: larger");
    expect(top("chat font larger")).toBe("Chat font size: larger");
    expect(top("ink strength 2")).toBe("Ink strength 2");
    expect(top("ink softer")).toBe("Ink strength: softer");
    expect(top("background intensity 2")).toBe("Background intensity 2");
    expect(top("background softer")).toBe("Background intensity: softer");
  });
});
