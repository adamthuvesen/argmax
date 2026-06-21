import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  baseSession,
  event,
  renderConversation
} from "../../test/sessionConversationTestHarness.js";

describe("SessionConversation — tools & chrome", () => {
  afterEach(() => {
    cleanup();
  });
  it("routes a backticked file chip click to onOpenFile (right panel)", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "See `src/foo.ts:42` for details.",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    fireEvent.click(screen.getByLabelText("Open src/foo.ts at line 42"));
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onOpenFile).toHaveBeenCalledWith("src/foo.ts", { line: 42, preferIde: false });
  });

  it("routes a markdown link to a local path through onOpenFile", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "Open [foo](src/bar.ts) please.",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    fireEvent.click(screen.getByLabelText("Open src/bar.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/bar.ts", { line: null, preferIde: false });
  });

  it("flags ⌘-click on a file chip with preferIde so the parent routes to the external IDE", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "See `src/foo.ts` for details.",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    fireEvent.click(screen.getByLabelText("Open src/foo.ts"), { metaKey: true });
    expect(onOpenFile).toHaveBeenCalledWith("src/foo.ts", { line: null, preferIde: true });
  });

  it("collapses a single MCP tool row when the turn chip is toggled", () => {
    renderConversation(
      baseSession({ provider: "claude", modelLabel: "Claude Haiku 4.5", state: "complete" }),
      [
        event("u1", "user.message", "check memory", "2026-05-12T15:00:00.000Z"),
        event("mcp-start", "command.started", "mcp__engram__recall", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "toolu_mcp_recall",
          name: "mcp__engram__recall",
          input: { query: "Argmax project state" }
        }),
        event("mcp-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "toolu_mcp_recall",
          content: "{\"status\":\"ok\",\"data\":{\"answer\":\"stored fact\"}}"
        })
      ],
      { defaultToolCallsExpanded: true }
    );

    expect(screen.getByRole("button", { name: /mcp__engram__recall/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));

    expect(screen.getByRole("button", { name: /mcp__engram__recall/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("turn chip expands every tool group even after one group was toggled locally", () => {
    renderConversation(
      baseSession({ provider: "claude", modelLabel: "Claude Opus 4.8", state: "complete" }),
      [
        event("u1", "user.message", "explore this", "2026-05-12T15:00:00.000Z"),
        event("m1", "message.completed", "I'll explore.", "2026-05-12T15:00:01.000Z"),
        event("g1-read-start", "command.started", "Read", "2026-05-12T15:00:02.000Z", {
          id: "g1-read",
          name: "Read",
          input: { file_path: "README.md" }
        }),
        event("g1-read-end", "command.completed", "tool_result", "2026-05-12T15:00:03.000Z", {
          tool_use_id: "g1-read",
          content: "readme"
        }),
        event("g1-bash-start", "command.started", "Bash", "2026-05-12T15:00:04.000Z", {
          id: "g1-bash",
          name: "Bash",
          input: { command: "echo first" }
        }),
        event("g1-bash-end", "command.completed", "tool_result", "2026-05-12T15:00:05.000Z", {
          tool_use_id: "g1-bash",
          content: "first"
        }),
        event("m2", "message.completed", "I'll keep going.", "2026-05-12T15:00:06.000Z"),
        event("g2-read-start", "command.started", "Read", "2026-05-12T15:00:07.000Z", {
          id: "g2-read",
          name: "Read",
          input: { file_path: "package.json" }
        }),
        event("g2-read-end", "command.completed", "tool_result", "2026-05-12T15:00:08.000Z", {
          tool_use_id: "g2-read",
          content: "package"
        }),
        event("g2-bash-start", "command.started", "Bash", "2026-05-12T15:00:09.000Z", {
          id: "g2-bash",
          name: "Bash",
          input: { command: "echo second" }
        }),
        event("g2-bash-end", "command.completed", "tool_result", "2026-05-12T15:00:10.000Z", {
          tool_use_id: "g2-bash",
          content: "second"
        })
      ],
      { defaultToolCallGroupsExpanded: false }
    );

    const groups = screen.getAllByRole("button", { name: /Read a file, ran a command/ });
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group).toHaveAttribute("aria-expanded", "false");
      expect(group).not.toHaveTextContent("✓");
      expect(group).not.toHaveTextContent(/\d(?:\.\d)?s/);
      expect(group).not.toHaveTextContent("+");
      expect(group).not.toHaveTextContent("−");
    }

    fireEvent.click(groups[0]);
    expect(groups[0]).toHaveAttribute("aria-expanded", "true");
    expect(groups[1]).toHaveAttribute("aria-expanded", "false");
    expect(groups[0]).not.toHaveTextContent("−");

    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));

    expect(groups[0]).toHaveAttribute("aria-expanded", "true");
    expect(groups[1]).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Read README.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read package.json" })).toBeInTheDocument();
  });

  it("leaves external markdown links as anchors (does not call onOpenFile)", () => {
    const onOpenFile = vi.fn();
    renderConversation(
      baseSession({ state: "complete" }),
      [
        event(
          "m1",
          "message.completed",
          "Docs at [example](https://example.com).",
          "2026-05-12T15:00:00.000Z"
        )
      ],
      { onOpenFile }
    );

    const link = screen.getByRole("link", { name: "example" });
    expect(link).toHaveAttribute("href", "https://example.com");
    fireEvent.click(link);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("renders an assistant message produced in plan mode as a PlanCard", () => {
    const plan = [
      "# Plan: Tidy chat header",
      "",
      "Make the header lighter and clearer.",
      "",
      "## Key Changes",
      "",
      "- Update the badge color",
      "- Shrink the avatar"
    ].join("\n");

    renderConversation(baseSession({ state: "complete" }), [
      event("u1", "user.message", "draft a plan", "2026-05-12T15:00:00.000Z", { agentMode: "plan" }),
      event("m1", "message.completed", plan, "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.getByRole("article", { name: /Plan: Tidy chat header/ })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "Plan response" })).toBeInTheDocument();
    expect(screen.getByText("Key Changes")).toBeInTheDocument();
  });

  it("renders the same content as a ChatBubble when the turn was sent in edit mode", () => {
    const plan = [
      "# Plan: Tidy chat header",
      "",
      "Make the header lighter and clearer.",
      "",
      "## Key Changes",
      "",
      "- Update the badge color"
    ].join("\n");

    renderConversation(baseSession({ state: "complete" }), [
      event("u1", "user.message", "draft a plan", "2026-05-12T15:00:00.000Z", { agentMode: "auto" }),
      event("m1", "message.completed", plan, "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.queryByRole("listbox", { name: "Plan response" })).toBeNull();
    expect(screen.queryByRole("article", { name: /Plan: Tidy chat header/ })).toBeNull();
    // Title still shows, but as plain markdown inside a ChatBubble
    expect(screen.getByRole("heading", { name: "Plan: Tidy chat header" })).toBeInTheDocument();
  });

  it("falls back to a ChatBubble when a plan-mode reply has no parseable plan structure", () => {
    renderConversation(baseSession({ state: "complete" }), [
      event("u1", "user.message", "what time is it?", "2026-05-12T15:00:00.000Z", { agentMode: "plan" }),
      event("m1", "message.completed", "It's about 3:30 PM here.", "2026-05-12T15:00:01.000Z")
    ]);

    expect(screen.queryByRole("listbox", { name: "Plan response" })).toBeNull();
    expect(screen.getByText("It's about 3:30 PM here.")).toBeInTheDocument();
  });

  it("hides the per-session toolbar actions behind a Session actions picker", () => {
    renderConversation(baseSession({ state: "complete" }));

    // None of the consolidated actions are visible until the picker is opened.
    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Save checkpoint" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Git actions" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Toggle debug log" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));

    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();
    // The default workspace stub is clean, so the checkpoint row is disabled.
    expect(screen.getByRole("menuitem", { name: "Save checkpoint" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Git actions" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Toggle debug log" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
  });

  it("dismisses the session actions popover on a mousedown outside the popover", () => {
    renderConversation(baseSession({ state: "complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
  });

  it("dismisses the session actions popover when clicking inside the conversation area", () => {
    renderConversation(baseSession({ state: "complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();

    const repositoryHeading = screen.getByRole("heading", { level: 2 });
    fireEvent.mouseDown(repositoryHeading);

    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
  });

  it("dismisses the session actions popover after toggling the debug log", () => {
    renderConversation(baseSession({ state: "complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Toggle debug log" }));

    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
  });

  it("swaps the picker contents in place when Git actions is selected", () => {
    renderConversation(baseSession({ state: "complete" }));

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Git actions" }));

    // Main menu items are no longer in the DOM; git actions take their place.
    expect(screen.queryByRole("menuitem", { name: "Browse files" })).toBeNull();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Toggle debug log" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Push" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Create pull request|View pull request/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create branch" })).toBeInTheDocument();

    // Back returns to the main menu.
    fireEvent.click(screen.getByRole("button", { name: "Back to session actions" }));
    expect(screen.getByRole("menuitem", { name: "Browse files" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Push" })).toBeNull();
  });

});
