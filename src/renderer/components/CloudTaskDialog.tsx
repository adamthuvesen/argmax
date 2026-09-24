import { AlertCircle, Check, Copy, ExternalLink, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { errorMessage, errorSubCode } from "../../shared/error.js";
import type { CloudHandoffPreview, CloudHandoffResult } from "../../shared/types.js";
import {
  CLOUD_PROVIDER_TASKS_URLS,
  cloudProviderName,
  type HostedCloudProvider
} from "../../shared/cloudProviders.js";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useMotionPresence } from "../hooks/useMotionPresence.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
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
  // The provider may have created the task, so sending again could create a
  // second billable one. The dialog only offers to close from here.
  const [deliveryUnknown, setDeliveryUnknown] = useState(false);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const requestGeneration = useRef(0);
  const launchingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const environmentPopoverRef = useRef<HTMLElement | null>(null);
  const busy = preparing || launching;
  const motion = useMotionPresence(open);
  const providerName = cloudProviderName(provider);
  const [copyFlash, copy] = useCopyToClipboard();
  const instruction = initialBrief?.trim() ?? "";

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
    setDeliveryUnknown(false);
    setPreparing(true);
    setLaunching(false);
    launchingRef.current = false;

    if (!window.argmax?.cloud) {
      setError("Cloud tasks are available only in the Argmax desktop app.");
      setPreparing(false);
      return;
    }

    // A chat's brief comes back whole from Rust: its transcript, closed by the
    // user's instruction when they typed one. A project has no transcript, so
    // its brief is the instruction itself.
    void window.argmax.cloud
      .prepare(sessionId
        ? { sessionId, provider, ...(instruction ? { instruction } : {}) }
        : { projectId, provider })
      .then((nextPreview) => {
        if (requestGeneration.current !== request) return;
        setPreview(nextPreview);
        setBrief(nextPreview.brief.trim() ? nextPreview.brief : instruction);
        setEnvironmentId(nextPreview.environmentId || (nextPreview.environments.length === 1
          ? nextPreview.environments[0]?.id ?? ""
          : ""));
      })
      .catch((cause: unknown) => {
        if (requestGeneration.current !== request) return;
        setError(errorMessage(cause) || "Couldn’t check this task’s setup.");
      })
      .finally(() => {
        if (requestGeneration.current === request) setPreparing(false);
      });
  }, [open, prepareAttempt, sessionId, projectId, instruction, provider]);

  useEffect(() => {
    if (!open || launching) return;
    if (preparing) dialogRef.current?.focus();
    else if (deliveryUnknown) closeButtonRef.current?.focus();
    else if (result) dialogRef.current?.querySelector<HTMLAnchorElement>("a.cloud-task-dialog-launch")?.focus();
    else if (preview) {
      const target = preview.environments.length > 1
        ? dialogRef.current?.querySelector<HTMLButtonElement>('[aria-label="Cloud environment"]')
        : dialogRef.current?.querySelector<HTMLButtonElement>(".cloud-task-dialog-launch");
      target?.focus();
    }
    else if (window.argmax?.cloud) {
      dialogRef.current?.querySelector<HTMLButtonElement>(".cloud-task-dialog-launch")?.focus();
    }
    else dialogRef.current?.focus();
  }, [open, preparing, launching, preview, result, deliveryUnknown]);

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
      setError(errorMessage(cause) || "Couldn’t start the cloud task.");
      if (errorSubCode(cause) === "CLOUD_LAUNCH_DELIVERY_UNKNOWN") setDeliveryUnknown(true);
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
            <h2 id="cloud-task-dialog-title">
              {result
                ? `Task sent to ${providerName}`
                : deliveryUnknown ? "Task status unknown" : `Send task to ${providerName}`}
            </h2>
            <p id="cloud-task-dialog-description">
              {result
                ? !sessionId ? "Argmax doesn’t keep this link. Open or copy it before you close."
                : result.warning ? `The task is running in ${providerName}.` : "A link to the task is saved in this chat."
                : deliveryUnknown ? `${providerName} may already have this task.`
                : preparing ? `Checking your pushed branch and ${providerName} setup…`
                : launching ? `Starting the task in ${providerName}. This can take up to a minute.`
                : "Runs from your pushed branch. Unpushed changes stay on this Mac."}
            </p>
          </div>
          <button type="button" aria-label="Close dialog" onClick={close} disabled={launching}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="cloud-task-dialog-body">
          {preparing ? (
            <CloudTaskSkeleton />
          ) : preview && !result ? (
            <>
              <section className="cloud-task-dialog-task">
                <p className="cloud-task-dialog-task-summary">
                  {instruction || `Continue this chat in ${providerName}.`}
                </p>
              </section>
              {sessionId && preview.brief.trim() ? (
                <details className="cloud-task-dialog-context">
                  <summary>Includes context from this chat</summary>
                  <p>{preview.brief}</p>
                </details>
              ) : null}

              <dl className="cloud-task-dialog-details">
                <div>
                  <dt>Repository</dt>
                  <dd><span title={preview.repository}>{preview.repository}</span></dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>
                    <span title={preview.branch}>{preview.branch}</span>
                    <span className="cloud-task-dialog-commit" title={preview.commit}>
                      {preview.commit.slice(0, 8)}
                    </span>
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
                          { value: "", label: "Choose an environment", disabled: true },
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
          ) : result ? (
            <div className="cloud-task-dialog-link">
              <span title={result.url}>{result.url}</span>
              <button type="button" onClick={() => void copy(result.url)}>
                {copyFlash === "copied"
                  ? <Check size={13} aria-hidden="true" />
                  : <Copy size={13} aria-hidden="true" />}
                {copyFlash === "copied" ? "Copied" : copyFlash === "failed" ? "Copy failed" : "Copy link"}
              </button>
            </div>
          ) : null}

          {error ? (
            <p
              className={`cloud-task-dialog-notice cloud-task-dialog-notice--${deliveryUnknown ? "caution" : "error"}`}
              role="alert"
            >
              <AlertCircle size={15} aria-hidden="true" />
              <span>{withInlineCode(error)}</span>
            </p>
          ) : null}

          {result?.warning ? (
            <p className="cloud-task-dialog-notice cloud-task-dialog-notice--caution" role="alert">
              <AlertCircle size={15} aria-hidden="true" />
              <span>{withInlineCode(result.warning)}</span>
            </p>
          ) : null}
        </div>
        <footer className="cloud-task-dialog-actions">
          <button ref={closeButtonRef} type="button" onClick={close} disabled={launching}>
            {result || deliveryUnknown ? "Close" : "Cancel"}
          </button>
          {!preparing && !preview && window.argmax?.cloud ? (
            <button
              type="button"
              className="cloud-task-dialog-launch"
              onClick={() => setPrepareAttempt((attempt) => attempt + 1)}
            >
              Try again
            </button>
          ) : null}
          {deliveryUnknown ? (
            <WebLink
              href={CLOUD_PROVIDER_TASKS_URLS[provider]}
              className="cloud-task-dialog-launch"
              onClick={() => onClose()}
            >
              Check {providerName}
              <ExternalLink size={14} aria-hidden="true" />
            </WebLink>
          ) : null}
          {result ? (
            <WebLink
              href={result.url}
              className="cloud-task-dialog-launch"
              onClick={() => onClose()}
            >
              Open in {providerName}
              <ExternalLink size={14} aria-hidden="true" />
            </WebLink>
          ) : null}
          {preview && !result && !deliveryUnknown ? (
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

/** Provider messages quote commands and config in backticks; set those apart
 *  as code instead of printing the backticks. */
function withInlineCode(message: string): ReactNode[] {
  return message.split(/`([^`]+)`/).map((part, index) =>
    index % 2 === 1 ? <code key={index}>{part}</code> : part
  );
}

const SKELETON_ROWS = ["repository", "branch", "environment"] as const;

/** The dialog's own shape while prepare runs. That call often takes several
 *  seconds, and a lone mark in the empty body reads as a broken modal. */
function CloudTaskSkeleton(): JSX.Element {
  return (
    <div
      className="cloud-task-dialog-skeleton"
      role="status"
      aria-busy="true"
      aria-label="Preparing cloud task"
    >
      <span className="loading-block cloud-task-dialog-skeleton-summary" />
      <div className="cloud-task-dialog-skeleton-rows">
        {SKELETON_ROWS.map((key) => (
          <div className="cloud-task-dialog-skeleton-row" key={key}>
            <span className="loading-block cloud-task-dialog-skeleton-label" />
            <span className="loading-block cloud-task-dialog-skeleton-value" />
          </div>
        ))}
      </div>
    </div>
  );
}
