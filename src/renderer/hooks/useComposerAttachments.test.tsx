import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import { readDraft } from "../lib/composerDrafts.js";
import { useComposerAttachments } from "./useComposerAttachments.js";

function pngBlob(): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
}

afterEach(() => {
  window.localStorage.clear();
  delete (window as unknown as { argmax?: unknown }).argmax;
});

describe("useComposerAttachments — save races the composer retarget", () => {
  it("does not append an in-flight image to the draft the composer moved to", async () => {
    // Full launcher: paste a screenshot against project A, then pick project B
    // before the save resolves. The image belongs to A's prompt; B must not end
    // up launching with a screenshot the user never attached to it.
    let resolveSave!: (result: { filePath: string; sizeBytes: number }) => void;
    const saveImage = vi.fn(
      () =>
        new Promise<{ filePath: string; sizeBytes: number }>((resolve) => {
          resolveSave = resolve;
        })
    );
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      attachments: { saveImage } as unknown as ArgmaxApi["attachments"]
    } as unknown as ArgmaxApi;

    const { result, rerender } = renderHook(
      ({ draftKey }: { draftKey: string }) =>
        useComposerAttachments({
          draftKey,
          workspacePath: null,
          setInput: () => undefined,
          setStatus: () => undefined
        }),
      { initialProps: { draftKey: "launch-a" } }
    );

    const paste = {
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => pngBlob() }] },
      preventDefault: vi.fn()
    };
    act(() => {
      result.current.onComposerPaste(paste as never);
    });
    await waitFor(() => expect(saveImage).toHaveBeenCalledTimes(1));

    rerender({ draftKey: "launch-b" });

    await act(async () => {
      resolveSave({ filePath: "/attachments/launch-a/shot.png", sizeBytes: 3 });
      await Promise.resolve();
    });

    expect(result.current.pendingAttachments).toEqual([]);
    expect(readDraft("launch-b").attachments).toEqual([]);
  });

  it("keeps an in-flight image when the draft it was pasted on carries onto a new key", async () => {
    // Same race, but the typed text moved with the composer, so this image is
    // part of that same unsent message and travels with it.
    let resolveSave!: (result: { filePath: string; sizeBytes: number }) => void;
    const saveImage = vi.fn(
      () =>
        new Promise<{ filePath: string; sizeBytes: number }>((resolve) => {
          resolveSave = resolve;
        })
    );
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      attachments: { saveImage } as unknown as ArgmaxApi["attachments"]
    } as unknown as ArgmaxApi;

    const { result, rerender } = renderHook(
      ({ draftKey, carriedOnRetarget }: { draftKey: string; carriedOnRetarget: boolean }) =>
        useComposerAttachments({
          draftKey,
          workspacePath: null,
          setInput: () => undefined,
          setStatus: () => undefined,
          carriedOnRetarget
        }),
      { initialProps: { draftKey: "launch-a", carriedOnRetarget: false } }
    );

    const paste = {
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => pngBlob() }] },
      preventDefault: vi.fn()
    };
    act(() => {
      result.current.onComposerPaste(paste as never);
    });
    await waitFor(() => expect(saveImage).toHaveBeenCalledTimes(1));

    rerender({ draftKey: "launch-b", carriedOnRetarget: true });

    await act(async () => {
      resolveSave({ filePath: "/attachments/launch-a/shot.png", sizeBytes: 3 });
      await Promise.resolve();
    });

    expect(result.current.pendingAttachments).toEqual([
      { filePath: "/attachments/launch-a/shot.png", mimeType: "image/png", sizeBytes: 3 }
    ]);
  });
});
