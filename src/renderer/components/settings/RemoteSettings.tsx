import { Check, Copy, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState, type JSX } from "react";
import { errorMessage } from "../../../shared/error.js";
import type { RemoteStatus } from "../../../shared/types.js";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard.js";
import { LoadingLine } from "../LoadingLine.js";
import { SettingGroup, SettingNote, SettingRow, Toggle } from "./settingsPrimitives.js";

/**
 * Settings → Integrations → Remote access: pair a phone with the local
 * bridge (QR encodes the tailnet URL + token) and configure both push sinks —
 * ntfy through a relay, or APNs straight from this Mac to Apple.
 */
export function RemoteSettings(): JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [portField, setPortField] = useState("");
  const [topicField, setTopicField] = useState("");
  const [keyPathField, setKeyPathField] = useState("");
  const [keyIdField, setKeyIdField] = useState("");
  const [teamIdField, setTeamIdField] = useState("");
  const [note, setNote] = useState<{ kind: "saved" | "error"; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const adoptStatus = useCallback((next: RemoteStatus): void => {
    setStatus(next);
    setPortField(String(next.port));
    setTopicField(next.ntfyTopic ?? "");
    setKeyPathField(next.apns.keyPath ?? "");
    setKeyIdField(next.apns.keyId ?? "");
    setTeamIdField(next.apns.teamId ?? "");
  }, []);

  const loadStatus = useCallback(async (): Promise<void> => {
    if (!window.argmax) {
      setLoadError("Open the Argmax desktop app to configure remote access.");
      return;
    }
    try {
      adoptStatus(await window.argmax.remote.getStatus());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [adoptStatus]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // `fields` defaults to the drafts, which is what "Save changes" commits. The
  // enable toggle passes the saved values instead: flipping the switch must not
  // silently commit a half-typed port or an ntfy topic the user never saved.
  const saveConfig = useCallback(
    async (enabled: boolean, fields?: { port: string; ntfyTopic: string }): Promise<void> => {
      if (!window.argmax || !status) return;
      const source = fields ?? { port: portField, ntfyTopic: topicField };
      const port = Number.parseInt(source.port, 10);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        setNote({ kind: "error", message: "Port must be between 1024 and 65535." });
        return;
      }
      setBusy(true);
      setNote(null);
      try {
        const next = await window.argmax.remote.setConfig({
          enabled,
          port,
          ntfyTopic: source.ntfyTopic
        });
        adoptStatus(next);
        setNote(
          next.enabled && !next.serving
            ? {
                kind: "error",
                message: `The bridge could not start on port ${next.port} — is something else using it?`
              }
            : { kind: "saved", message: "Saved." }
        );
      } catch (error) {
        setNote({ kind: "error", message: errorMessage(error) });
      } finally {
        setBusy(false);
      }
    },
    [adoptStatus, portField, status, topicField]
  );

  const sendTestNotification = useCallback(async (): Promise<void> => {
    if (!window.argmax) return;
    setBusy(true);
    setNote(null);
    try {
      await window.argmax.remote.testNotification();
      setNote({ kind: "saved", message: "Test notification sent — check your phone." });
    } catch (error) {
      setNote({ kind: "error", message: `Test notification failed: ${errorMessage(error)}` });
    } finally {
      setBusy(false);
    }
  }, []);

  const saveApnsConfig = useCallback(
    async (sandbox: boolean): Promise<void> => {
      if (!window.argmax) return;
      setBusy(true);
      setNote(null);
      try {
        adoptStatus(
          await window.argmax.remote.setApnsConfig({
            keyPath: keyPathField,
            keyId: keyIdField,
            teamId: teamIdField,
            sandbox
          })
        );
        setNote({ kind: "saved", message: "Saved." });
      } catch (error) {
        setNote({ kind: "error", message: errorMessage(error) });
      } finally {
        setBusy(false);
      }
    },
    [adoptStatus, keyIdField, keyPathField, teamIdField]
  );

  const removeDevice = useCallback(async (token: string): Promise<void> => {
    if (!window.argmax) return;
    setBusy(true);
    setNote(null);
    try {
      const devices = await window.argmax.remote.unregisterPushDevice({ token });
      setStatus((current) => (current ? { ...current, apns: { ...current.apns, devices } } : current));
    } catch (error) {
      setNote({ kind: "error", message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }, []);

  const sendTestPush = useCallback(async (): Promise<void> => {
    if (!window.argmax) return;
    setBusy(true);
    setNote(null);
    try {
      const results = await window.argmax.remote.pushTest();
      const failed = results.filter((result) => !result.ok);
      setNote(
        failed.length === 0
          ? {
              kind: "saved",
              message: `Test push sent to ${results.length} device${results.length === 1 ? "" : "s"}.`
            }
          : {
              kind: "error",
              // Naming the device matters: one retired phone in a list of two
              // is a very different problem from a bad auth key.
              message: failed
                .map((result) => `${result.name}: ${result.error ?? "failed"}`)
                .join("; ")
            }
      );
    } catch (error) {
      setNote({ kind: "error", message: `Test push failed: ${errorMessage(error)}` });
    } finally {
      setBusy(false);
    }
  }, []);

  const dirty =
    status !== null && (portField !== String(status.port) || topicField !== (status.ntfyTopic ?? ""));

  const apnsDirty =
    status !== null &&
    (keyPathField !== (status.apns.keyPath ?? "") ||
      keyIdField !== (status.apns.keyId ?? "") ||
      teamIdField !== (status.apns.teamId ?? ""));

  return (
    <SettingGroup id="settings-remote" label="Remote access">
      {status === null ? (
        loadError ? (
          <SettingNote role="alert">{loadError}</SettingNote>
        ) : (
          <LoadingLine label="Loading remote status…" />
        )
      ) : (
        <>
          <SettingRow
            label="Phone remote"
            description="Drive Argmax from your phone over your Tailscale network. The bridge listens on this Mac only."
            control={
              <Toggle
                ariaLabel="Enable phone remote"
                checked={status.enabled}
                onChange={(next) =>
                  void saveConfig(next, {
                    port: String(status.port),
                    ntfyTopic: status.ntfyTopic ?? ""
                  })
                }
              />
            }
          />

          {status.enabled ? (
            <div className="settings-remote-pairing">
              <div
                className="settings-remote-qr"
                role="img"
                aria-label="Pairing QR code"
                // Trusted markup: SVG generated by our own Rust backend from
                // the pairing URL, never from remote input.
                dangerouslySetInnerHTML={{ __html: status.qrSvg }}
              />
              <div className="settings-remote-pairing-info">
                <p className="settings-note">
                  Scan with your phone's camera. The link carries the pairing token in the URL
                  fragment, so it never crosses the network.
                </p>
                <CopyValueRow label="Pairing link" value={status.pairingUrl} />
                <CopyValueRow label="Tailscale proxy" value={status.serveCommand} code />
                {status.tailnetUrl === null ? (
                  <p className="settings-note" data-tone="warn">
                    Tailscale CLI not found — the QR points at this Mac only. Install Tailscale to
                    reach it from your phone.
                  </p>
                ) : !status.tailscaleRunning ? (
                  <p className="settings-note" data-tone="warn">
                    Tailscale is not running, so the phone link will not connect until you start it.
                  </p>
                ) : null}
                {!status.serving ? (
                  <p className="settings-note" role="alert" data-tone="warn">
                    The bridge is enabled but not running. Try a different port.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <SettingRow
            label="Port"
            htmlFor="settings-remote-port"
            control={
              <input
                id="settings-remote-port"
                className="settings-text-input settings-remote-port"
                inputMode="numeric"
                value={portField}
                onChange={(event) => setPortField(event.target.value)}
              />
            }
          />

          <SettingRow
            label="ntfy topic"
            description="Push when a chat needs approval, blocks, fails, or finishes. Bare names use ntfy.sh, so pick something unguessable."
            htmlFor="settings-remote-ntfy"
            control={
              <input
                id="settings-remote-ntfy"
                className="settings-text-input"
                placeholder="argmax-yourname"
                value={topicField}
                onChange={(event) => setTopicField(event.target.value)}
              />
            }
          />

          <h4 className="settings-remote-subhead">Push notifications</h4>

          <SettingRow
            label="APNs key file"
            description="Push straight from this Mac to Apple, for the native Argmax app. Download the .p8 from Apple Developer → Keys and give its full path here."
            htmlFor="settings-remote-apns-key-path"
            control={
              <input
                id="settings-remote-apns-key-path"
                className="settings-text-input"
                placeholder="/Users/you/Keys/AuthKey_ABC1234567.p8"
                value={keyPathField}
                onChange={(event) => setKeyPathField(event.target.value)}
              />
            }
          />

          <SettingRow
            label="Key ID"
            htmlFor="settings-remote-apns-key-id"
            control={
              <input
                id="settings-remote-apns-key-id"
                className="settings-text-input settings-remote-port"
                placeholder="ABC1234567"
                value={keyIdField}
                onChange={(event) => setKeyIdField(event.target.value)}
              />
            }
          />

          <SettingRow
            label="Team ID"
            htmlFor="settings-remote-apns-team-id"
            control={
              <input
                id="settings-remote-apns-team-id"
                className="settings-text-input settings-remote-port"
                placeholder="TEAM123456"
                value={teamIdField}
                onChange={(event) => setTeamIdField(event.target.value)}
              />
            }
          />

          <SettingRow
            label="Apple sandbox"
            description="Send to Apple's development host. A token from a debug build of the phone app only works there."
            control={
              <Toggle
                ariaLabel="Use the Apple sandbox host"
                checked={status.apns.sandbox}
                onChange={(next) => void saveApnsConfig(next)}
              />
            }
          />

          {status.apns.devices.length > 0 ? (
            <ul className="settings-remote-devices" aria-label="Paired phones">
              {status.apns.devices.map((device) => (
                <li key={device.token} className="settings-remote-device">
                  <span className="settings-remote-device-name">{device.name}</span>
                  <code className="settings-remote-device-token">{device.token.slice(0, 12)}…</code>
                  <button
                    type="button"
                    className="settings-button"
                    aria-label={`Remove ${device.name}`}
                    disabled={busy}
                    onClick={() => void removeDevice(device.token)}
                  >
                    <X size={13} aria-hidden="true" />
                    <span>Remove</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-note">
              No phones paired yet. The Argmax app registers itself the first time you open it on a
              paired phone.
            </p>
          )}

          <div className="settings-remote-actions">
            <button
              type="button"
              className="settings-button"
              disabled={busy || !apnsDirty}
              onClick={() => void saveApnsConfig(status.apns.sandbox)}
            >
              Save push key
            </button>
            <button
              type="button"
              className="settings-button"
              disabled={busy || !status.apns.configured || status.apns.devices.length === 0 || apnsDirty}
              title={
                !status.apns.configured
                  ? "Set the key path, key id, and team id first"
                  : status.apns.devices.length === 0
                    ? "Pair a phone first"
                    : apnsDirty
                      ? "Save your changes first"
                      : undefined
              }
              onClick={() => void sendTestPush()}
            >
              Send test push
            </button>
          </div>

          <div className="settings-remote-actions">
            <button
              type="button"
              className="settings-button"
              disabled={busy || !dirty}
              onClick={() => void saveConfig(status.enabled)}
            >
              Save changes
            </button>
            <button
              type="button"
              className="settings-button"
              disabled={busy || status.ntfyTopic === null || dirty}
              title={
                status.ntfyTopic === null
                  ? "Save an ntfy topic first"
                  : dirty
                    ? "Save your changes first"
                    : undefined
              }
              onClick={() => void sendTestNotification()}
            >
              Send test notification
            </button>
            <button
              type="button"
              className="settings-button"
              aria-label="Refresh remote status"
              disabled={busy}
              onClick={() => void loadStatus()}
            >
              <RefreshCw size={13} aria-hidden="true" />
              <span>Refresh</span>
            </button>
          </div>
          {note ? (
            <p
              className="settings-note settings-form-status"
              data-status={note.kind}
              role={note.kind === "error" ? "alert" : "status"}
            >
              {note.message}
            </p>
          ) : null}
        </>
      )}
    </SettingGroup>
  );
}

function CopyValueRow({
  label,
  value,
  code = false
}: {
  label: string;
  value: string;
  code?: boolean;
}): JSX.Element {
  const [copyFlash, copy] = useCopyToClipboard();
  return (
    <div className="settings-remote-copyrow">
      <span className="settings-remote-copyrow-label">{label}</span>
      {code ? <code>{value}</code> : <span className="settings-remote-copyrow-value">{value}</span>}
      <button
        type="button"
        className="settings-button"
        onClick={() => void copy(value)}
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        {copyFlash === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        <span>{copyFlash === "copied" ? "Copied" : copyFlash === "failed" ? "Couldn't copy" : "Copy"}</span>
      </button>
    </div>
  );
}
