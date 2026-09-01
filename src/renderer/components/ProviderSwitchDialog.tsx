import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { PROVIDER_DISPLAY_NAMES } from "../../shared/providerModels.js";
import type { ProviderId } from "../../shared/types.js";

/**
 * Confirmation for handing an idle session to a different provider.
 *
 * The switch itself works for every provider pair, but the new agent starts
 * without the old one's native conversation — it reads the capped text
 * transcript `compose_follow_up_prompt` builds instead (providers/follow_up.rs).
 * That is a real loss of context, so the dialog says so and offers the better
 * path first: a new session, which starts the new provider clean instead of
 * half-informed.
 */
export function ProviderSwitchDialog({
  from,
  to,
  onCancel,
  onStartNewSession,
  onSwitch
}: {
  from: ProviderId;
  to: ProviderId;
  onCancel: () => void;
  /** Absent when the pane can't open the launcher; the dialog drops the action
      rather than offering a button that does nothing. */
  onStartNewSession?: () => void;
  onSwitch: () => void;
}): JSX.Element {
  const fromName = PROVIDER_DISPLAY_NAMES[from];
  const toName = PROVIDER_DISPLAY_NAMES[to];
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  // The composer raises this dialog, but the decision is about the whole
  // session, so the overlay covers the pane. `.provider-switch-overlay` is
  // `position: absolute; inset: 0` against `.conversation-surface` — and
  // `.session-input` around the composer is itself `position: relative`, so
  // rendered in place the overlay would size to the composer box and the dialog
  // would sit over the input rather than centred in the pane. Portal it up to
  // the surface the stylesheet is written against.
  // `undefined` until the probe has looked; `null` when this host has no pane
  // to portal into, which falls back to rendering in place rather than
  // swallowing the dialog.
  const [surface, setSurface] = useState<HTMLElement | null | undefined>(undefined);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    setSurface(probeRef.current?.closest<HTMLElement>(".conversation-surface") ?? null);
  }, []);

  const overlay = (
    <div
      className="provider-switch-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Switch this session to ${toName}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="provider-switch-dialog">
        <h2>Switch to {toName}?</h2>
        <p>
          {`${toName} can't resume ${fromName}'s session. It starts fresh from a short summary of this chat.`}
        </p>
        <p className="provider-switch-recommendation">A new session usually works better.</p>
        <div className="provider-switch-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={onStartNewSession ? undefined : "provider-switch-primary"}
            ref={onStartNewSession ? undefined : primaryRef}
            onClick={onSwitch}
          >
            Switch
          </button>
          {onStartNewSession ? (
            <button
              type="button"
              className="provider-switch-primary"
              ref={primaryRef}
              onClick={onStartNewSession}
            >
              New session
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Locates the pane on mount. Rendering the overlay in place for that
          first paint would flash it over the composer, so it waits. */}
      <span ref={probeRef} hidden />
      {surface === undefined ? null : surface ? createPortal(overlay, surface) : overlay}
    </>
  );
}
