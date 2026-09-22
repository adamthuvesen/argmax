import { AlertCircle, ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { errorMessage } from "../../shared/error.js";
import type { CloudHandoffPreview, CloudHandoffResult } from "../../shared/types.js";
import { cloudProviderName, type HostedCloudProvider } from "../../shared/cloudProviders.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useMotionPresence } from "../hooks/useMotionPresence.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
import { LoadingLine } from "./LoadingLine.js";
import { SettingsListPicker } from "./settings/settingsPrimitives.js";
import { WebLink } from "./WebLink.js";
import "../styles/cloud-handoff.css";

export function CloudTaskDialog({
  open,
  provider,
  sessionId,
  projectId,
  initialBrief,
  onLaunched,
  onClose
}: {
  open: boolean;
  provider: HostedCloudProvider;
  onLaunched?: () => void;
  onClose: () => void;
} & (
  | { sessionId: string; projectId?: never; initialBrief?: string }
  | { sessionId?: never; projectId: string; initialBrief: string }
)): JSX.Element | null {
  const [preview, setPreview] = useState<CloudHandoffPreview | null>(null);
  const [brief, setBrief] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [environmentPickerOpen, setEnvironmentPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<CloudHandoffResult | null>(null);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const requestGeneration = useRef(0);
  const launchingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const environmentPopoverRef = useRef<HTMLElement | null>(null);
  const busy = preparing || launching;
  const motion = useMotionPresence(open);
  const providerName = cloudProviderName(provider);

  const close = useCallback(() => {
    if (environmentPickerOpen) {
      setEnvironmentPickerOpen(false);
      queueMicrotask(() => {
        dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="Cloud environment"]')?.focus();
      });
      return;
    }
    if (!launching) onClose();
  }, [environmentPickerOpen, launching, onClose]);

  useDismissOnOutsideOrEscape(dialogRef, open, close, environmentPopoverRef, { trapFocus: true });
  useRestoreFocus(open);

  useEffect(() => {
    if (!open) {
      requestGeneration.current += 1;
      launchingRef.current = false;
      return;
    }

    const request = ++requestGeneration.current;
    setPreview(null);
    setBrief("");
    setEnvironmentId("");
    setEnvironmentPickerOpen(false);
    setError(null);
    setResult(null);
    setPreparing(true);
    setLaunching(false);
    launchingRef.current = false;

    if (!window.argmax?.cloud) {
      setError("Cloud handoff is unavailable. Open this chat in the desktop app.");
      setPreparing(false);
      return;
    }

    void window.argmax.cloud
      .prepare(sessionId ? { sessionId, provider } : { projectId, provider })
      .then((nextPreview) => {
        if (requestGeneration.current !== request) return;
        setPreview(nextPreview);
        const instruction = initialBrief?.trim() ?? "";
        const context = nextPreview.brief.trim();
        setBrief(instruction && context
          ? `${instruction}\n\nContext from this chat:\n${context}`
          : instruction || context);
        setEnvironmentId(nextPreview.environmentId || (nextPreview.environments.length === 1
          ? nextPreview.environments[0]?.id ?? ""
          : ""));
      })
      .catch((cause: unknown) => {
        if (requestGeneration.current !== request) return;
        setError(errorMessage(cause) || "Could not prepare this cloud task.");
      })
      .finally(() => {
        if (requestGeneration.current === request) setPreparing(false);
      });
  }, [open, prepareAttempt, sessionId, projectId, initialBrief, provider]);

  useEffect(() => {
    if (!open || launching) return;
    if (preparing) dialogRef.current?.focus();
    else if (result) dialogRef.current?.querySelector<HTMLAnchorElement>("a[href]")?.focus();
    else if (preview) {
      const target = preview.environments.length > 1
        ? dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="Cloud environment"]')
        : dialogRef.current?.querySelector<HTMLButtonElement>(".cloud-task-dialog-launch");
      target?.focus();
    }
    else dialogRef.current?.focus();
  }, [open, preparing, launching, preview, result]);

  if (!motion.present) return null;

  const launch = async (): Promise<void> => {
    const trimmedBrief = brief.trim();
    if (!preview || !trimmedBrief || !environmentId || busy || launchingRef.current || !window.argmax?.cloud) return;

    const request = requestGeneration.current;
    launchingRef.current = true;
    setLaunching(true);
    setError(null);
    try {
      const nextResult = await window.argmax.cloud.launch({
        ...(sessionId ? { sessionId } : { projectId }),
        provider,
        repository: preview.repository,
        branch: preview.branch,
        commit: preview.commit,
        brief: trimmedBrief,
        environmentId
      });
      if (requestGeneration.current !== request) return;
      setResult(nextResult);
      onLaunched?.();
    } catch (cause) {
      if (requestGeneration.current !== request) return;
      setError(errorMessage(cause) || "Could not launch the cloud task.");
    } finally {
      if (requestGeneration.current === request) setLaunching(false);
      launchingRef.current = false;
    }
  };

  return createPortal(
    <div
      className="cloud-task-dialog-overlay motion-modal-overlay"
      data-motion-state={motion.motionState}
      onAnimationEnd={motion.onMotionEnd}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cloud-task-dialog-title"
      aria-describedby="cloud-task-dialog-description"
      aria-busy={busy}
    >
      <div
        ref={dialogRef}
        className="cloud-task-dialog motion-modal-surface"
        tabIndex={-1}
      >
        <header className="cloud-task-dialog-header">
          <div>
            <h2 id="cloud-task-dialog-title">{result ? `Task sent to ${providerName}` : `Send task to ${providerName}`}</h2>
            <p id="cloud-task-dialog-description">
              {result
                ? !sessionId ? "Open your cloud task before closing. This link isn’t saved in Argmax."
                : result.warning ? "Your cloud task is ready." : "The link is saved in this chat."
                : "Runs from pushed code. Local changes stay here."}
            </p>
          </div>
          <button type="button" aria-label="Close cloud task dialog" onClick={close} disabled={launching}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="cloud-task-dialog-body">
          {preparing ? (
            <LoadingLine className="cloud-task-dialog-loading" label="Preparing cloud task" />
          ) : preview && !result ? (
            <>
              <section className="cloud-task-dialog-task">
                <p className="cloud-task-dialog-task-summary">
                  {initialBrief?.trim() || preview.brief}
                </p>
              </section>
              {sessionId && initialBrief?.trim() && preview.brief.trim() ? (
                <details className="cloud-task-dialog-context">
                  <summary>Chat context included</summary>
                  <p>{preview.brief}</p>
                </details>
              ) : null}

              <dl className="cloud-task-dialog-details">
                <div><dt>Provider</dt><dd>{providerName}</dd></div>
                <div><dt>Repository</dt><dd title={preview.repository}>{preview.repository}</dd></div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    <span title={preview.branch}>{preview.branch}</span>
                    <span aria-hidden="true"> · </span>
                    <span title={preview.commit}>{preview.commit.slice(0, 8)}</span>
                  </dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd className="cloud-task-dialog-environment" title={environmentId || undefined}>
                    {preview.environments.length > 1 ? (
                      <SettingsListPicker
                        ariaLabel="Cloud environment"
                        value={environmentId}
                        onChange={setEnvironmentId}
                        onOpenChange={setEnvironmentPickerOpen}
                        disabled={launching}
                        popoverRef={environmentPopoverRef}
                        portaled
                        options={[
                          { value: "", label: "Choose environment", disabled: true },
                          ...preview.environments.map((environment) => ({
                            value: environment.id,
                            label: environment.name
                          }))
                        ]}
                      />
                    ) : preview.environmentDescription}
                  </dd>
                </div>
              </dl>
            </>
          ) : null}

          {error ? (
            <p className="cloud-task-dialog-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{error}</span>
            </p>
          ) : null}

          {result?.warning ? (
            <p className="cloud-task-dialog-error" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{result.warning}</span>
            </p>
          ) : null}
        </div>
        <footer className="cloud-task-dialog-actions">
          {!preparing && !preview ? (
            <button type="button" onClick={() => setPrepareAttempt((attempt) => attempt + 1)}>
              Try again
            </button>
          ) : null}
          <button type="button" onClick={close} disabled={launching}>
            {result ? "Close" : "Cancel"}
          </button>
          {result ? (
            <WebLink href={result.url} className="cloud-task-dialog-launch">
              Open in {providerName}
              <ExternalLink size={14} aria-hidden="true" />
            </WebLink>
          ) : null}
          {preview && !result ? (
            <button
              type="button"
              className="cloud-task-dialog-launch"
              disabled={preparing || brief.trim().length === 0 || environmentId.length === 0}
              aria-disabled={launching || undefined}
              onClick={() => void launch()}
            >
              {launching ? "Sending…" : "Send task"}
            </button>
          ) : null}
        </footer>
      </div>
    </div>,
    document.body
  );
}
