import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary } from "../../shared/types.js";
import { modelPickerSelectionFromSession, type ModelPickerSelection } from "../lib/models.js";
import { orderedOpenFilePaths } from "../lib/openFileContext.js";
import { readStoredSessionModel, writeStoredSessionModel } from "../lib/sessionModelPreference.js";
import {
  createAnnotation,
  createDiffNoteAnnotation,
  type ComposerAnnotation,
  type DiffNoteInput
} from "../lib/composerAnnotations.js";
import type { ComposerStatus } from "../components/SessionComposer.js";
import type { ComposerField } from "../components/composerEditor/composerField.js";
import type { ChatSelection } from "../components/SelectionToolbar.js";

interface SessionComposerStateOptions {
  session: SessionSummary | null;
  isFocused: boolean;
  review: {
    isPanelOpen: boolean;
    workspaceFiles: {
      tabs: readonly { path: string }[];
      activeTabPath: string | null;
    };
  };
  registerAnnotationSink?: (sink: ((input: DiffNoteInput) => void) | null) => void;
}

/** Owns the draft's model, status, and annotations across transcript updates. */
export function useSessionComposerState({
  session,
  isFocused,
  review,
  registerAnnotationSink
}: SessionComposerStateOptions) {
  const sessionId = session?.id ?? null;
  const [status, setStatusState] = useState<ComposerStatus | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const setStatus = useCallback((next: ComposerStatus | null): void => {
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    setStatusState(next);
    if (next?.kind === "info") {
      statusTimerRef.current = window.setTimeout(() => {
        statusTimerRef.current = null;
        setStatusState(null);
      }, 4000);
    }
  }, []);
  useEffect(() => () => {
    if (statusTimerRef.current !== null) window.clearTimeout(statusTimerRef.current);
  }, []);

  const [selectedModel, setSelectedModel] = useState<ModelPickerSelection>(() => {
    const fallback = modelPickerSelectionFromSession(session);
    return session ? readStoredSessionModel(session.id, fallback) : fallback;
  });
  const setSelectedModelForSession = useCallback((model: ModelPickerSelection): void => {
    setSelectedModel(model);
    if (sessionId) writeStoredSessionModel(sessionId, model);
  }, [sessionId]);
  // A routed session can change its model on a dashboard delta. Reseeding
  // during render prevents a stale chip from briefly appearing as a pin.
  const seededModelKey = [sessionId, session?.provider, session?.modelId, session?.reasoningEffort].join("\n");
  const [seededFor, setSeededFor] = useState(seededModelKey);
  if (seededFor !== seededModelKey) {
    setSeededFor(seededModelKey);
    const fallback = modelPickerSelectionFromSession(session);
    setSelectedModel(sessionId ? readStoredSessionModel(sessionId, fallback) : fallback);
  }

  const inputRef = useRef<ComposerField | null>(null);
  const shouldRefocusInput = useRef(false);
  const [pendingAnnotations, setPendingAnnotations] = useState<ComposerAnnotation[]>([]);
  useEffect(() => setPendingAnnotations([]), [sessionId]);
  const addAnnotation = useCallback((selection: ChatSelection): void => {
    setPendingAnnotations((current) => [...current, createAnnotation(selection.text)]);
    if (isFocused) inputRef.current?.focus();
  }, [isFocused]);
  const removeAnnotation = useCallback((id: string): void => {
    setPendingAnnotations((current) => current.filter((annotation) => annotation.id !== id));
  }, []);
  const clearAnnotations = useCallback((): void => setPendingAnnotations([]), []);
  useEffect(() => {
    if (!registerAnnotationSink) return undefined;
    registerAnnotationSink((input) => {
      setPendingAnnotations((current) => [...current, createDiffNoteAnnotation(input)]);
      if (isFocused) inputRef.current?.focus();
    });
    return () => registerAnnotationSink(null);
  }, [isFocused, registerAnnotationSink]);
  const openFilePaths = useMemo(
    () => review.isPanelOpen
      ? orderedOpenFilePaths(review.workspaceFiles.tabs, review.workspaceFiles.activeTabPath)
      : [],
    [review.isPanelOpen, review.workspaceFiles.tabs, review.workspaceFiles.activeTabPath]
  );

  return {
    status,
    setStatus,
    selectedModel,
    setSelectedModelForSession,
    inputRef,
    shouldRefocusInput,
    pendingAnnotations,
    addAnnotation,
    removeAnnotation,
    clearAnnotations,
    openFilePaths
  };
}
