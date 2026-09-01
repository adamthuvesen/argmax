import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readDraft } from "../lib/composerDrafts.js";
import { useComposerDraft } from "./useComposerDraft.js";

afterEach(() => {
  window.localStorage.clear();
});

describe("useComposerDraft persist lock", () => {
  it("drops the stored entry when persist turns off without clearing the on-screen text", () => {
    const { result, rerender } = renderHook(
      ({ persist }: { persist: boolean }) => useComposerDraft("launch-p", { persist }),
      { initialProps: { persist: true } }
    );

    act(() => {
      result.current[1]("Implement PTY launch");
    });
    expect(readDraft("launch-p").text).toBe("Implement PTY launch");

    rerender({ persist: false });
    expect(readDraft("launch-p").text).toBe("");
    expect(result.current[0]).toBe("Implement PTY launch");
  });

  it("writes the still-held text back if persist returns (a failed send)", () => {
    const { result, rerender } = renderHook(
      ({ persist }: { persist: boolean }) => useComposerDraft("launch-p", { persist }),
      { initialProps: { persist: true } }
    );

    act(() => {
      result.current[1]("Implement PTY launch");
    });
    rerender({ persist: false });
    rerender({ persist: true });

    expect(result.current[0]).toBe("Implement PTY launch");
    expect(readDraft("launch-p").text).toBe("Implement PTY launch");
  });
});
