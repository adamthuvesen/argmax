import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type RefObject
} from "react";
import {
  appendReferencesToPrompt,
  buildAttachmentReferences,
  isSupportedImageMime,
  readBlobAsBase64
} from "../lib/composerAttachments.js";
import type { AttachmentMimeType, ComposerAttachment } from "../../shared/types.js";

export type PendingAttachment = ComposerAttachment & {
  id: string;
  thumbnailDataUrl: string;
};

export interface ComposerAttachmentsApi {
  pendingAttachments: PendingAttachment[];
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  removePendingAttachment: (id: string) => void;
  /** Bind to the composer `<form>`'s `onDragOver`. */
  onComposerDragOver: (event: ReactDragEvent<HTMLFormElement>) => void;
  /** Bind to the composer `<form>`'s `onDrop`. */
  onComposerDrop: (event: ReactDragEvent<HTMLFormElement>) => void;
  /** Bind to the textarea's `onPaste`. */
  onComposerPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  /** Bind to the hidden file `<input>`'s `onChange`. */
  onAttachmentInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  /** Trigger the hidden file input — call from a button's `onClick`. */
  openFilePicker: () => void;
  /** Drop all pending attachments. Call after a successful submit. */
  clearAttachments: () => void;
}

export interface ComposerAttachmentsDeps {
  sessionId: string | null | undefined;
  workspacePath: string | null | undefined;
  /** Append `@-mentions` to the live composer text. */
  setInput: (updater: (prev: string) => string) => void;
  /** Surface an error to the composer status line. */
  setStatus: (status: string | null) => void;
}

/**
 * Composer attachment handling: file-picker, drag/drop, paste, image upload.
 *
 * Two persistence paths:
 * - **Path-based files** (file picker on macOS, drags from Finder) become
 *   `@-mentions` appended to the prompt — handled inline by the agent.
 * - **Path-less images** (browser drags, Slack drags, clipboard paste)
 *   are persisted to the `AttachmentStore` so the agent can read them back
 *   via the `argmax-attachment://` scheme.
 *
 * Pending attachments reset when the session changes; the caller is also
 * expected to call `clearAttachments()` after a successful submit.
 */
export function useComposerAttachments(deps: ComposerAttachmentsDeps): ComposerAttachmentsApi {
  const { sessionId, workspacePath, setInput, setStatus } = deps;
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);

  // Reset on session change so the new session starts empty.
  useEffect(() => {
    setPendingAttachments([]);
  }, [sessionId]);

  const attachFiles = useCallback(
    (files: Iterable<File> | Iterable<{ path?: string }>): void => {
      const refs = buildAttachmentReferences(files, workspacePath ?? null);
      if (refs.length === 0) return;
      setInput((prev) => appendReferencesToPrompt(prev, refs));
    },
    [workspacePath, setInput]
  );

  const attachImageBlobs = useCallback(
    async (blobs: Blob[]): Promise<void> => {
      if (!sessionId || blobs.length === 0) return;
      const api = window.argmax;
      if (!api) {
        setStatus("Open the Tauri app window to attach images.");
        return;
      }
      try {
        for (const blob of blobs) {
          if (!isSupportedImageMime(blob.type)) continue;
          const dataBase64 = await readBlobAsBase64(blob);
          const saved = await api.attachments.saveImage({
            sessionId,
            mimeType: blob.type,
            dataBase64
          });
          const thumbnailDataUrl = `data:${blob.type};base64,${dataBase64}`;
          setPendingAttachments((prev) => [
            ...prev,
            {
              id: `${saved.filePath}-${prev.length}`,
              filePath: saved.filePath,
              mimeType: blob.type as AttachmentMimeType,
              sizeBytes: saved.sizeBytes,
              thumbnailDataUrl
            }
          ]);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not attach image.");
      }
    },
    [sessionId, setStatus]
  );

  const removePendingAttachment = useCallback((id: string): void => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const onComposerDragOver = useCallback((event: ReactDragEvent<HTMLFormElement>): void => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
  }, []);

  const splitAndAttach = useCallback(
    (files: File[]): void => {
      // Split: files with a disk path use the @-mention flow; path-less
      // image MIMEs get persisted via AttachmentStore so the agent can
      // still read them.
      const withPath: File[] = [];
      const imageBlobs: Blob[] = [];
      for (const file of files) {
        const path = (file as { path?: string }).path;
        if (typeof path === "string" && path.length > 0) {
          withPath.push(file);
        } else if (isSupportedImageMime(file.type)) {
          imageBlobs.push(file);
        }
      }
      if (withPath.length > 0) attachFiles(withPath);
      if (imageBlobs.length > 0) void attachImageBlobs(imageBlobs);
      if (withPath.length === 0 && imageBlobs.length === 0) {
        setStatus("Only files with a disk path or images can be attached.");
      }
    },
    [attachFiles, attachImageBlobs, setStatus]
  );

  const onComposerDrop = useCallback(
    (event: ReactDragEvent<HTMLFormElement>): void => {
      if (!event.dataTransfer.files || event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      splitAndAttach(Array.from(event.dataTransfer.files));
    },
    [splitAndAttach]
  );

  const onComposerPaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
      const items = event.clipboardData?.items;
      if (!items || items.length === 0) return;
      const images: Blob[] = [];
      for (const item of Array.from(items)) {
        if (item.kind !== "file") continue;
        if (!isSupportedImageMime(item.type)) continue;
        const file = item.getAsFile();
        if (file) images.push(file);
      }
      if (images.length === 0) return;
      event.preventDefault();
      void attachImageBlobs(images);
    },
    [attachImageBlobs]
  );

  const onAttachmentInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      if (event.target.files && event.target.files.length > 0) {
        splitAndAttach(Array.from(event.target.files));
      }
      // Clear so the same file can be selected again next time.
      event.target.value = "";
    },
    [splitAndAttach]
  );

  const openFilePicker = useCallback((): void => {
    attachmentInputRef.current?.click();
  }, []);

  const clearAttachments = useCallback((): void => {
    setPendingAttachments([]);
  }, []);

  return {
    pendingAttachments,
    attachmentInputRef,
    removePendingAttachment,
    onComposerDragOver,
    onComposerDrop,
    onComposerPaste,
    onAttachmentInputChange,
    openFilePicker,
    clearAttachments
  };
}
