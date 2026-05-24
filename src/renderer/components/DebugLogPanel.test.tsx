import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugLogPanel } from "./DebugLogPanel.js";
import type { RawProviderOutput } from "../../shared/types.js";

describe("DebugLogPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("summarizes provider protocol JSON in the raw output tab", () => {
    render(
      <DebugLogPanel
        events={[]}
        rawOutputs={[
          rawOutput(
            "raw-thinking",
            JSON.stringify({
              type: "assistant",
              message: {
                content: [
                  {
                    type: "thinking",
                    thinking: "large hidden chain of thought",
                    signature: "x".repeat(400)
                  }
                ]
              }
            })
          ),
          rawOutput("raw-plain", "plain stderr-style line")
        ]}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: /Raw output/ }));

    expect(screen.getByText("[provider json] assistant - thinking block hidden")).toBeInTheDocument();
    expect(screen.getByText("plain stderr-style line")).toBeInTheDocument();
    expect(screen.queryByText(/large hidden chain of thought/)).not.toBeInTheDocument();
    expect(screen.queryByText(/signature/)).not.toBeInTheDocument();
  });

  it("copies the original raw output block even when the visible preview is summarized", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const content = JSON.stringify({
      type: "system",
      subtype: "init",
      tools: ["Task", "Bash"]
    });

    render(<DebugLogPanel events={[]} rawOutputs={[rawOutput("raw-system", content)]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: /Raw output/ }));
    fireEvent.click(screen.getByRole("button", { name: "Copy output block" }));

    expect(screen.getByText("[provider json] system - init")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(content);
  });
});

function rawOutput(id: string, content: string): RawProviderOutput {
  return {
    id,
    sessionId: "session-1",
    stream: "stdout",
    content,
    createdAt: "2026-05-22T15:56:45.000Z"
  };
}
