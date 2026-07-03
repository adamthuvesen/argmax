import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThinkingLabel } from "./ThinkingLabel.js";

afterEach(() => {
  cleanup();
});

describe("<ThinkingLabel />", () => {
  it("exposes the Thinking aria-label so existing selectors keep working", () => {
    render(<ThinkingLabel />);
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("renders only the Thinking label text", () => {
    render(<ThinkingLabel />);
    expect(screen.getByTestId("thinking-label")).toHaveTextContent("Thinking");
    expect(screen.queryByText(/argmax run/i)).toBeNull();
  });
});
