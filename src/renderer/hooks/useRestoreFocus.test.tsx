import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useRef, type JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useRestoreFocus } from "./useRestoreFocus.js";

function FocusSurface(): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useRestoreFocus(true);

  useEffect(() => {
    buttonRef.current?.focus();
  }, []);

  return <button ref={buttonRef}>Inside</button>;
}

describe("useRestoreFocus", () => {
  afterEach(() => cleanup());

  it("restores focus when an open surface unmounts", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.appendChild(trigger);
    trigger.focus();

    try {
      const { unmount } = render(<FocusSurface />);
      expect(screen.getByRole("button", { name: "Inside" })).toHaveFocus();

      unmount();
      expect(trigger).toHaveFocus();
    } finally {
      trigger.remove();
    }
  });
});
