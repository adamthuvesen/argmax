import { CheckCircle2, History, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { ChromeProfile } from "../../shared/types.js";
import { errorMessage } from "../../shared/error.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
import { mergeBrowserHistory } from "../lib/browserHistory.js";
import "../styles/browser-history-import.css";

interface ImportSummary {
  read: number;
  totalAvailable: number;
  added: number;
}

export function BrowserHistoryImport({ onClose }: { onClose: () => void }): JSX.Element {
  const browser = window.argmax?.browser ?? null;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const profileRequestRef = useRef(0);
  const titleId = useId();
  const [profiles, setProfiles] = useState<ChromeProfile[] | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const requestClose = (): void => {
    if (!importing) onClose();
  };
  useDismissOnOutsideOrEscape(dialogRef, true, requestClose, undefined, { trapFocus: true });
  useRestoreFocus(true);

  const loadProfiles = useCallback((): void => {
    const request = ++profileRequestRef.current;
    setProfiles(null);
    setLoadError(null);
    setImportError(null);
    if (!browser) {
      setProfiles([]);
      setLoadError("The desktop browser bridge is unavailable.");
      return;
    }
    void browser.chromeProfiles()
      .then((nextProfiles) => {
        if (profileRequestRef.current !== request) return;
        setProfiles(nextProfiles);
        setSelectedProfileId((current) =>
          nextProfiles.some((profile) => profile.id === current)
            ? current
            : (nextProfiles[0]?.id ?? "")
        );
      })
      .catch((error: unknown) => {
        if (profileRequestRef.current !== request) return;
        setProfiles([]);
        setLoadError(errorMessage(error));
      });
  }, [browser]);

  useEffect(() => {
    closeRef.current?.focus();
    loadProfiles();
    return () => {
      profileRequestRef.current += 1;
    };
  }, [loadProfiles]);

  const handleImport = async (): Promise<void> => {
    if (!browser || !selectedProfileId || importing) return;
    setImporting(true);
    setImportError(null);
    setSummary(null);
    try {
      const result = await browser.importChromeHistory(selectedProfileId);
      const added = await mergeBrowserHistory(result.entries);
      setSummary({ read: result.entries.length, totalAvailable: result.totalAvailable, added });
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      setImporting(false);
    }
  };

  const profileControls = profiles === null ? (
    <p className="browser-history-import-loading" role="status" aria-label="Loading Chrome profiles">
      Loading Chrome profiles…
    </p>
  ) : loadError ? (
    <div className="browser-history-import-profiles-error">
      <p role="alert">Could not load Chrome profiles: {loadError}</p>
      <button type="button" onClick={loadProfiles}>Try again</button>
    </div>
  ) : profiles.length === 0 ? (
    <p className="browser-history-import-empty" role="status">
      No Chrome profiles were found on this computer.
    </p>
  ) : (
    <label className="browser-history-import-profile">
      <span>Chrome profile</span>
      <select
        aria-label="Chrome profile"
        value={selectedProfileId}
        disabled={importing}
        onChange={(event) => {
          setSelectedProfileId(event.target.value);
          setImportError(null);
          setSummary(null);
        }}
      >
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>{profile.name}</option>
        ))}
      </select>
    </label>
  );

  return createPortal(
    <div
      className="browser-history-import-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy={importing}
    >
      <div className="browser-history-import-dialog" ref={dialogRef}>
        <header className="browser-history-import-header">
          <span className="browser-history-import-mark" aria-hidden="true">
            <History size={18} />
          </span>
          <span>
            <h2 id={titleId}>Import from Chrome</h2>
            <p>Bring your browsing history into Argmax.</p>
          </span>
          <button
            ref={closeRef}
            type="button"
            className="browser-history-import-close"
            aria-label="Close Chrome history import"
            disabled={importing}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <p className="browser-history-import-description">
          History improves suggestions when you type in the address bar. Cookies and saved logins are not included.
        </p>

        {profileControls}

        {importError ? (
          <p className="browser-history-import-error" role="alert">
            Import failed: {importError}
          </p>
        ) : null}

        {summary ? (
          <div className="browser-history-import-success" role="status">
            <CheckCircle2 size={17} aria-hidden="true" />
            <p>
              Imported {summary.read.toLocaleString()} {summary.read === 1 ? "page" : "pages"} from Chrome. {summary.added.toLocaleString()} {summary.added === 1 ? "was" : "were"} new to Argmax.
              {summary.totalAvailable > summary.read ? (
                <> Chrome has {summary.totalAvailable.toLocaleString()} available pages. Each import is capped at 10,000.</>
              ) : null}
            </p>
          </div>
        ) : null}

        <footer className="browser-history-import-actions">
          <button type="button" onClick={onClose} disabled={importing}>
            {summary ? "Done" : "Cancel"}
          </button>
          {!summary ? (
            <button
              type="button"
              className="browser-history-import-submit"
              disabled={profiles === null || profiles.length === 0 || !selectedProfileId || importing || Boolean(loadError)}
              onClick={() => void handleImport()}
            >
              {importing ? "Importing…" : "Import history"}
            </button>
          ) : null}
        </footer>
      </div>
    </div>,
    document.body
  );
}
