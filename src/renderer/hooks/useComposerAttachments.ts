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
  downscaleImageBlob,
  isSupportedImageMime,
  readBlobAsBase64
} from "../lib/composerAttachments.js";
import { readDraft, writeDraftAttachments } from "../lib/composerDrafts.js";
import { shouldPreferHtmlFlavor } from "../lib/clipboardMarkdown.js";
import { isRemoteBridge } from "../lib/tauriBridge.js";
import type { ComposerAttachment } from "../../shared/types.js";

export interface ComposerAttachmentsApi {
  pendingAttachments: ComposerAttachment[];
  isDraggingFiles: boolean;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  removePendingAttachment: (filePath: string) => void;
  /** Bind to the composer `<form>`'s `onDragEnter`. */
  onComposerDragEnter: (event: ReactDragEvent<HTMLFormElement>) => void;
  /** Bind to the composer `<form>`'s `onDragOver`. */
  onComposerDragOver: (event: ReactDragEvent<HTMLFormElement>) => void;
  /** Bind to the composer `<form>`'s `onDragLeave`. */
  onComposerDragLeave: (event: ReactDragEvent<HTMLFormElement>) => void;
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
  /**
   * Third element of `useComposerDraft`: true for the render in which typed
   * text followed the composer onto a new draft key. Images are part of that
   * same unsent message, so they move with it instead of being swapped for the
   * new target's — otherwise the prompt arrives carrying screenshots the user
   * never attached to it, and freshly pasted ones are dropped on the floor.
   */
  carriedOnRetarget?: boolean;
  /**
   * Same send lock as `useComposerDraft`. Off while a submit is in flight so
   * this effect cannot recreate the entry the text hook just dropped.
   */
  persist?: boolean;
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
  const { draftKey, workspacePath, setInput, setStatus, carriedOnRetarget = false, persist = true } = deps;
  const [pendingAttachments, setPendingAttachments] = useState<ComposerAttachment[]>(
    () => readDraft(draftKey ?? null).attachments
  );
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);

  // A pane that swaps drafts without remounting starts from the new draft's
  // own images, never the previous one's — unless the typed text just carried
  // onto this key, in which case these images belong to it and travel along.
  const loadedKey = useRef(draftKey);
  const movedFrom = useRef<string | null>(null);
  // Bumped only when the list is swapped for another draft's — a carried
  // retarget keeps the same images, and the same generation, so an in-flight
  // paste still belongs to them.
  const listGeneration = useRef(0);
  if (loadedKey.current !== draftKey) {
    const previousKey = loadedKey.current;
    loadedKey.current = draftKey;
    if (carriedOnRetarget) {
      movedFrom.current = previousKey ?? null;
    } else {
      listGeneration.current += 1;
      setPendingAttachments(readDraft(draftKey ?? null).attachments);
    }
  }

  useEffect(() => {
    // Clear the images off the draft the text left behind, so the source ends
    // up empty rather than holding screenshots whose sentence has moved on.
    if (!persist) return;
    if (movedFrom.current) {
      writeDraftAttachments(movedFrom.current, []);
      movedFrom.current = null;
    }
    if (draftKey) writeDraftAttachments(draftKey, pendingAttachments);
  }, [draftKey, pendingAttachments, persist]);

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
      // Images are written to the host's attachment store, which the bridge
      // does not expose. Say so plainly — the raw REMOTE_UNSUPPORTED text
      // ("attachments:save-image is only available in the desktop app") reads
      // like a crash under the phone's composer.
      if (isRemoteBridge()) {
        setStatus("Attaching images needs the desktop app.");
        return;
      }
      const generation = listGeneration.current;
      try {
        for (const blob of blobs) {
          if (!isSupportedImageMime(blob.type)) continue;
          // Shrink retina screenshots before the save so the provider's
          // single-line JSON stream can carry the read back.
          const processed = await downscaleImageBlob(blob);
          const mimeType = isSupportedImageMime(processed.type) ? processed.type : blob.type;
          const dataBase64 = await readBlobAsBase64(processed);
          const saved = await api.attachments.saveImage({
            sessionId: draftKey,
            mimeType,
            dataBase64
          });
          // The pane can retarget to another draft while the save is in flight
          // (pick a different project in the launcher). Appending now would
          // hang this image on a prompt it was never pasted into, and the
          // persist effect below would write it into that draft.
          if (listGeneration.current !== generation) return;
          setPendingAttachments((prev) => [
            ...prev,
            {
              filePath: saved.filePath,
              mimeType,
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

  const onComposerDragEnter = useCallback((event: ReactDragEvent<HTMLFormElement>): void => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setIsDraggingFiles(true);
  }, []);

  const onComposerDragOver = useCallback((event: ReactDragEvent<HTMLFormElement>): void => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingFiles(true);
  }, []);

  const onComposerDragLeave = useCallback((): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDraggingFiles(false);
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
      dragDepth.current = 0;
      setIsDraggingFiles(false);
      if (!event.dataTransfer.files || event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      splitAndAttach(Array.from(event.dataTransfer.files));
    },
    [splitAndAttach]
  );

  const onComposerPaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
      const clipboard = event.clipboardData;
      const items = clipboard?.items;
      if (!items || items.length === 0) return;
      const images: Blob[] = [];
      for (const item of Array.from(items)) {
        if (item.kind !== "file") continue;
        if (!isSupportedImageMime(item.type)) continue;
        const file = item.getAsFile();
        if (file) images.push(file);
      }
      if (images.length > 0) {
        event.preventDefault();
        void attachImageBlobs(images);
        return;
      }
      // A selection copy of rendered content pairs a lossy plain-text flavor
      // (list markers, backticks, and emphasis are styling, so they never
      // reach the text) with a structured HTML flavor. A plain textarea reads
      // only the lossy one, which is how rendered chat pastes as unmarked
      // slop. When the HTML flavor carries structure, rebuild markdown from
      // it; otherwise fall through and let the native paste insert the plain
      // text untouched.
      const html = clipboard.getData("text/html");
      if (!html || !shouldPreferHtmlFlavor(html)) return;
      event.preventDefault();
      const target = event.currentTarget;
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      const plain = clipboard.getData("text/plain");
      const insert = (text: string): void => {
        setInput((prev) => prev.slice(0, start) + text + prev.slice(end));
        const caret = start + text.length;
        // React usually skips the value write when the DOM already matches, so
        // the synchronous set survives; the frame callback re-asserts it when a
        // real re-render does flush and resets the caret to the end.
        target.setSelectionRange(caret, caret);
        requestAnimationFrame(() => target.setSelectionRange(caret, caret));
      };
      // The markdown rebuilder carries Turndown, which only a structured paste
      // ever needs, so it loads here rather than in the composer's eager
      // chunk. The paste is already claimed at this point: if the chunk cannot
      // load, insert the plain flavor rather than swallowing what the user
      // pasted.
      void import("../lib/htmlToMarkdown.js").then(
        ({ htmlToMarkdown }) => insert(htmlToMarkdown(html)),
        () => insert(plain)
      );
    },
    [attachImageBlobs, setInput]
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
    isDraggingFiles,
    attachmentInputRef,
    removePendingAttachment,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    onComposerPaste,
    onAttachmentInputChange,
    openFilePicker,
    clearAttachments
  };
}
