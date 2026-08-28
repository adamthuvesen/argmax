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
import { readDraft, writeDraftAttachments } from "../lib/composerDrafts.js";
import type { AttachmentMimeType, ComposerAttachment } from "../../shared/types.js";

export interface ComposerAttachmentsApi {
  pendingAttachments: ComposerAttachment[];
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  removePendingAttachment: (filePath: string) => void;
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
  /**
   * Identifies the draft these attachments belong to, either a session id in the
   * session composer, `launcherDraftKey(projectId)` in the launcher. Doubles
   * as the `AttachmentStore` folder the images are written to.
   */
  draftKey: string | null | undefined;
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
 * Pending images are part of the unsent draft, not of the mounted composer:
 * they are restored when the draft key comes back, such as a reopened session or
 * relaunched app. They only leave on removal or a successful submit, so a
 * screenshot never has to be taken twice.
 */
export function useComposerAttachments(deps: ComposerAttachmentsDeps): ComposerAttachmentsApi {
  const { draftKey, workspacePath, setInput, setStatus } = deps;
  const [pendingAttachments, setPendingAttachments] = useState<ComposerAttachment[]>(
    () => readDraft(draftKey ?? null).attachments
  );
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);

  // A pane that swaps drafts without remounting starts from the new draft's
  // own images, never the previous one's.
  const loadedKey = useRef(draftKey);
  if (loadedKey.current !== draftKey) {
    loadedKey.current = draftKey;
    setPendingAttachments(readDraft(draftKey ?? null).attachments);
  }

  useEffect(() => {
    if (draftKey) writeDraftAttachments(draftKey, pendingAttachments);
  }, [draftKey, pendingAttachments]);

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
      if (!draftKey || blobs.length === 0) return;
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
            sessionId: draftKey,
            mimeType: blob.type,
            dataBase64
          });
          setPendingAttachments((prev) => [
            ...prev,
            {
              filePath: saved.filePath,
              mimeType: blob.type as AttachmentMimeType,
              sizeBytes: saved.sizeBytes
            }
          ]);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not attach image.");
      }
    },
    [draftKey, setStatus]
  );

  const removePendingAttachment = useCallback((filePath: string): void => {
    setPendingAttachments((prev) => prev.filter((a) => a.filePath !== filePath));
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
