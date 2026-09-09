import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import { readDraft } from "../lib/composerDrafts.js";
import { setViewportMeasurementPaused } from "../mobile/useVisualViewportInsets.js";
import { useComposerAttachments } from "./useComposerAttachments.js";

vi.mock("../mobile/useVisualViewportInsets.js", () => ({
  setViewportMeasurementPaused: vi.fn(),
  useVisualViewportInsets: vi.fn()
}));

function pngBlob(): Blob {
  return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
}

function installObjectUrl(urls: string[]): { create: ReturnType<typeof vi.fn>; revoke: ReturnType<typeof vi.fn>; restore: () => void } {
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const create = vi.fn(() => urls.shift() ?? "blob:unused");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  return {
    create,
    revoke,
    restore: () => {
      if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  };
}

afterEach(() => {
  window.localStorage.clear();
  delete (window as unknown as { argmax?: unknown }).argmax;
  vi.mocked(setViewportMeasurementPaused).mockClear();
});

describe("useComposerAttachments — text paste stays native", () => {
  it("never intercepts a plain-text clipboard, so the platform paste is verbatim", () => {
    // A plain-text-only clipboard (no HTML flavor) must reach the textarea
    // untouched: the hook only ever claims pastes carrying supported images
    // or structured HTML. Intercepting plain text — or worse, re-serializing
    // it — would mangle the user's formatting, so this pins preventDefault
    // off for the plain flavor.
    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput: () => undefined,
        setStatus: () => undefined
      })
    );

    const paste = {
      clipboardData: {
        items: [{ kind: "string", type: "text/plain" }],
        getData: vi.fn(() => "")
      },
      preventDefault: vi.fn()
    };

    act(() => {
      result.current.onComposerPaste(paste as never);
    });

    expect(paste.preventDefault).not.toHaveBeenCalled();
  });

  it("rebuilds markdown from the HTML flavor when a styled copy carries structure", async () => {
    // Copying rendered chat (Claude, Argmax, any web UI) puts a lossy plain
    // flavor next to a structured HTML one. The composer must paste the
    // markdown rebuilt from the HTML — list markers, code spans, emphasis —
    // instead of the marker-less slop the plain flavor carries.
    const setInput = vi.fn();
    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput,
        setStatus: () => undefined
      })
    );

    const html =
      "<ul><li><code>1. 2. 3.</code> gone — selecting rendered <code>&lt;ol&gt;</code> text</li>" +
      "<li><strong>bold</strong> and <em>italics</em> survive</li></ul>";
    const target = { value: "findings: ", selectionStart: 10, selectionEnd: 10, setSelectionRange: vi.fn() };
    const paste = {
      clipboardData: {
        items: [{ kind: "string", type: "text/html" }],
        getData: vi.fn(() => html)
      },
      currentTarget: target,
      preventDefault: vi.fn()
    };

    act(() => {
      result.current.onComposerPaste(paste as never);
    });

    // The paste is claimed synchronously; the markdown rebuilder is a lazy
    // chunk, so the insert lands once that import settles.
    expect(paste.preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(setInput).toHaveBeenCalledWith(expect.any(Function)));
    const apply = setInput.mock.calls[0][0] as (prev: string) => string;
    expect(apply("findings: ")).toBe(
      "findings: - `1. 2. 3.` gone — selecting rendered `<ol>` text\n- **bold** and *italics* survive"
    );
    expect(target.setSelectionRange).toHaveBeenCalledWith(93, 93);
  });

  it("falls back to the plain flavor when the HTML carries no structure", () => {
    // Styled copies of unstructured text (an editor selection, a flattened
    // chat span) wrap the same words in a <span>. Converting those could only
    // lose newlines, so the native paste wins.
    const setInput = vi.fn();
    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput,
        setStatus: () => undefined
      })
    );

    const paste = {
      clipboardData: {
        items: [{ kind: "string", type: "text/html" }],
        getData: vi.fn(() => "<span style=\"font-weight: 390\">just a line</span>")
      },
      preventDefault: vi.fn()
    };

    act(() => {
      result.current.onComposerPaste(paste as never);
    });

    expect(paste.preventDefault).not.toHaveBeenCalled();
    expect(setInput).not.toHaveBeenCalled();
  });
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

function dragEvent(dataTransfer: {
  types?: string[];
  files?: File[];
  items?: Array<{ kind: string; type: string; getAsFile: () => File | null }>;
}): {
  dataTransfer: {
    types: string[];
    files: File[];
    items: Array<{ kind: string; type: string; getAsFile: () => File | null }>;
    dropEffect: string;
  };
  preventDefault: ReturnType<typeof vi.fn>;
} {
  return {
    dataTransfer: {
      types: dataTransfer.types ?? [],
      files: dataTransfer.files ?? [],
      items: dataTransfer.items ?? [],
      dropEffect: "none"
    },
    preventDefault: vi.fn()
  };
}

describe("useComposerAttachments — screenshot drag", () => {
  it("highlights an image drag that never advertises Files", () => {
    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput: () => undefined,
        setStatus: () => undefined
      })
    );
    const event = dragEvent({ types: ["image/png"] });
    act(() => {
      result.current.onComposerDragOver(event as never);
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(result.current.isDraggingFiles).toBe(true);
  });

  it("highlights a macOS screenshot thumbnail that advertises public.png", () => {
    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput: () => undefined,
        setStatus: () => undefined
      })
    );
    const event = dragEvent({ types: ["public.png"] });
    act(() => {
      result.current.onComposerDragOver(event as never);
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(result.current.isDraggingFiles).toBe(true);
  });

  it("highlights a drag whose types stay empty but string items are listed", () => {
    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput: () => undefined,
        setStatus: () => undefined
      })
    );
    const event = dragEvent({
      types: [],
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }]
    });
    act(() => {
      result.current.onComposerDragOver(event as never);
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(result.current.isDraggingFiles).toBe(true);
  });

  it("does not highlight a text drag", () => {
    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput: () => undefined,
        setStatus: () => undefined
      })
    );
    const event = dragEvent({ types: ["text/plain"] });
    act(() => {
      result.current.onComposerDragOver(event as never);
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(result.current.isDraggingFiles).toBe(false);
  });

  it("attaches a path-less PNG when drop files is empty but items holds the image", async () => {
    const saveImage = vi.fn().mockResolvedValue({
      filePath: "/attachments/launch-a/shot.png",
      sizeBytes: 3
    });
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      attachments: { saveImage } as unknown as ArgmaxApi["attachments"]
    } as unknown as ArgmaxApi;

    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput: () => undefined,
        setStatus: () => undefined
      })
    );
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const event = dragEvent({
      types: ["image/png"],
      files: [],
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }]
    });
    act(() => {
      result.current.onComposerDrop(event as never);
    });
    expect(event.preventDefault).toHaveBeenCalled();
    await waitFor(() => expect(result.current.pendingAttachments).toEqual([
      { filePath: "/attachments/launch-a/shot.png", mimeType: "image/png", sizeBytes: 3 }
    ]));
  });

  it("attaches a typeless screenshot named .png", async () => {
    const saveImage = vi.fn().mockResolvedValue({
      filePath: "/attachments/launch-a/shot.png",
      sizeBytes: 3
    });
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      attachments: { saveImage } as unknown as ArgmaxApi["attachments"]
    } as unknown as ArgmaxApi;

    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput: () => undefined,
        setStatus: () => undefined
      })
    );
    const file = new File(
      [new Uint8Array([1, 2, 3])],
      "Screenshot 2026-09-05 at 10.30.00.png",
      { type: "" }
    );
    const event = dragEvent({ types: ["Files"], files: [file] });
    act(() => {
      result.current.onComposerDrop(event as never);
    });
    await waitFor(() => expect(saveImage).toHaveBeenCalledTimes(1));
    expect(saveImage.mock.calls[0][0]).toEqual(expect.objectContaining({ mimeType: "image/png" }));
  });

  it("attaches a typeless PNG once when files and items both list it", async () => {
    const saveImage = vi.fn().mockResolvedValue({
      filePath: "/attachments/launch-a/shot.png",
      sizeBytes: 3
    });
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      attachments: { saveImage } as unknown as ArgmaxApi["attachments"]
    } as unknown as ArgmaxApi;

    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput: () => undefined,
        setStatus: () => undefined
      })
    );
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "" });
    const event = dragEvent({
      types: ["Files", "image/png"],
      files: [file],
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }]
    });
    act(() => {
      result.current.onComposerDrop(event as never);
    });
    await waitFor(() => expect(result.current.pendingAttachments).toHaveLength(1));
    expect(saveImage).toHaveBeenCalledTimes(1);
  });

  it("mentions a Finder image by path instead of also uploading a wrapped copy", () => {
    const saveImage = vi.fn();
    const setInput = vi.fn();
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      attachments: { saveImage } as unknown as ArgmaxApi["attachments"]
    } as unknown as ArgmaxApi;

    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput,
        setStatus: () => undefined
      })
    );
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "" });
    Object.defineProperty(file, "path", { value: "/tmp/shot.png" });
    act(() => {
      result.current.onComposerDrop(
        dragEvent({
          types: ["Files"],
          files: [file],
          items: [{ kind: "file", type: "image/png", getAsFile: () => file }]
        }) as never
      );
    });
    expect(saveImage).not.toHaveBeenCalled();
    expect(setInput).toHaveBeenCalledTimes(1);
    const apply = setInput.mock.calls[0][0] as (prev: string) => string;
    expect(apply("")).toBe("@/tmp/shot.png");
    expect(result.current.pendingAttachments).toEqual([]);
  });

  it("persists a screenshot-thumbnail temp path as image bytes, not an @-mention", async () => {
    const saveImage = vi.fn().mockResolvedValue({
      filePath: "/attachments/launch-a/shot.png",
      sizeBytes: 3
    });
    const setInput = vi.fn();
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      attachments: { saveImage } as unknown as ArgmaxApi["attachments"]
    } as unknown as ArgmaxApi;

    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput,
        setStatus: () => undefined
      })
    );
    const file = new File(
      [new Uint8Array([1, 2, 3])],
      "Screenshot 2026-09-06 at 10.30.00.png",
      { type: "" }
    );
    Object.defineProperty(file, "path", {
      value:
        "/var/folders/xx/T/TemporaryItems/NSIRD_screencaptureui_abc/Screenshot 2026-09-06 at 10.30.00.png"
    });
    act(() => {
      result.current.onComposerDrop(dragEvent({ types: ["Files"], files: [file] }) as never);
    });
    await waitFor(() => expect(saveImage).toHaveBeenCalledTimes(1));
    expect(setInput).not.toHaveBeenCalled();
    expect(result.current.pendingAttachments).toEqual([
      { filePath: "/attachments/launch-a/shot.png", mimeType: "image/png", sizeBytes: 3 }
    ]);
  });
});

describe("useComposerAttachments — transient previews", () => {
  it("creates browser-local previews and releases them with the attachment", async () => {
    const objectUrl = installObjectUrl(["blob:removed", "blob:cleared", "blob:unmounted"]);
    const saveImage = vi.fn().mockResolvedValue({
      filePath: "/attachments/launch-a/shot.png",
      sizeBytes: 3
    });
    (window as unknown as { argmax: ArgmaxApi }).argmax = {
      attachments: { saveImage } as unknown as ArgmaxApi["attachments"]
    } as unknown as ArgmaxApi;

    const { result, unmount } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput: () => undefined,
        setStatus: () => undefined
      })
    );
    const paste = () => ({
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => pngBlob() }] },
      preventDefault: vi.fn()
    });

    try {
      act(() => result.current.onComposerPaste(paste() as never));
      await waitFor(() => expect(result.current.pendingAttachmentPreviews).toEqual({
        "/attachments/launch-a/shot.png": "blob:removed"
      }));
      expect(result.current.pendingAttachments).toHaveLength(1);

      act(() => result.current.removePendingAttachment("/attachments/launch-a/shot.png"));
      expect(result.current.pendingAttachmentPreviews).toEqual({});
      expect(objectUrl.revoke).toHaveBeenCalledWith("blob:removed");

      act(() => result.current.onComposerPaste(paste() as never));
      await waitFor(() => expect(result.current.pendingAttachmentPreviews).toEqual({
        "/attachments/launch-a/shot.png": "blob:cleared"
      }));
      act(() => result.current.clearAttachments());
      expect(objectUrl.revoke).toHaveBeenCalledWith("blob:cleared");

      act(() => result.current.onComposerPaste(paste() as never));
      await waitFor(() => expect(result.current.pendingAttachmentPreviews).toEqual({
        "/attachments/launch-a/shot.png": "blob:unmounted"
      }));
      unmount();
      expect(objectUrl.revoke).toHaveBeenCalledWith("blob:unmounted");
    } finally {
      objectUrl.restore();
    }
  });
});

describe("useComposerAttachments — native picker viewport hold", () => {
  it("pauses visual-viewport measurement while the picker is open", () => {
    const { result } = renderHook(() =>
      useComposerAttachments({
        draftKey: "launch-a",
        workspacePath: null,
        setInput: () => undefined,
        setStatus: () => undefined
      })
    );

    act(() => result.current.openFilePicker());
    expect(setViewportMeasurementPaused).toHaveBeenCalledWith(true);

    const input = document.createElement("input");
    act(() =>
      result.current.onAttachmentInputChange({
        target: input
      } as never)
    );
    expect(setViewportMeasurementPaused).toHaveBeenCalledWith(false);
  });
});
