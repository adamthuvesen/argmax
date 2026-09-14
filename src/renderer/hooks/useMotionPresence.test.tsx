import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMotionPresence } from "./useMotionPresence.js";

function Surface({ open }: { open: boolean }): React.JSX.Element | null {
  const motion = useMotionPresence(open);
  if (!motion.present) return null;
  return (
    <div
      data-testid="surface"
      data-motion-state={motion.motionState}
      onAnimationEnd={motion.onMotionEnd}
    />
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useMotionPresence", () => {
  it("keeps a closing surface mounted until its animation ends", () => {
    const { rerender } = render(<Surface open />);
    rerender(<Surface open={false} />);

    expect(screen.getByTestId("surface")).toHaveAttribute("data-motion-state", "closing");
    fireEvent.animationEnd(screen.getByTestId("surface"));
    expect(screen.queryByTestId("surface")).not.toBeInTheDocument();
  });

  it("uses a timeout when animationend never arrives", () => {
    vi.useFakeTimers();
    const { rerender } = render(<Surface open />);
    rerender(<Surface open={false} />);

    act(() => {
      vi.advanceTimersByTime(320);
    });
    expect(screen.queryByTestId("surface")).not.toBeInTheDocument();
  });

  it("removes closing motion immediately when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { rerender } = render(<Surface open />);
    rerender(<Surface open={false} />);

    expect(screen.queryByTestId("surface")).not.toBeInTheDocument();
  });
});
