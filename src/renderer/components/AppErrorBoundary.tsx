import { Component, type ErrorInfo, type ReactNode } from "react";
import { logger } from "../../shared/logger.js";
import { APP_VERSION } from "../../shared/appVersion.js";
import { ISSUES_URL } from "../../shared/appLinks.js";
import { copyTextToClipboard } from "../hooks/useCopyToClipboard.js";

interface State {
  error: Error | null;
  componentStack: string | null;
  copied: boolean;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: null, copied: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, componentStack: null, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error("renderer.error-boundary", "caught render error", {
      error: error.message,
      stack: info.componentStack ?? null
    });
    // The log buffer is in-memory and reachable only from the desktop debug
    // panel, so on a paired phone the boundary itself is the only place the
    // crash is ever readable. Without the component stack, a message like
    // "undefined is not an object" names no file and the report cannot be
    // acted on.
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private handleReload = (): void => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  /** Everything a report needs, in the order someone reading it wants it. */
  private crashReport(): string {
    const stack = this.state.componentStack?.trim();
    return [
      `Argmax ${APP_VERSION} — ${navigator.userAgent}`,
      this.state.error?.stack?.trim() ?? this.state.error?.message ?? "",
      stack ? `Component stack:\n${stack}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private handleCopyReport = (): void => {
    void copyTextToClipboard(this.crashReport()).then((copied) => this.setState({ copied }));
  };

  private handleReportIssue = (): void => {
    if (typeof window === "undefined" || !window.argmax) return;
    void window.argmax.system.openPath({ path: ISSUES_URL }).catch(() => {
      /* swallow — we're already in the error boundary path */
    });
  };

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <main className="error-boundary" role="alert" aria-label="Argmax encountered an error">
        <h1>Argmax hit an unexpected error.</h1>
        <p>Your chats are safe — everything was saved before this happened.</p>
        <details className="error-boundary-details">
          <summary>Technical details</summary>
          <pre className="error-boundary-message">{this.state.error.message}</pre>
          {this.state.componentStack ? (
            <pre className="error-boundary-message">{this.state.componentStack.trim()}</pre>
          ) : null}
        </details>
        <div className="error-boundary-actions">
          <button type="button" onClick={this.handleReload}>
            Reload Argmax
          </button>
          <button type="button" onClick={this.handleCopyReport}>
            {this.state.copied ? "Copied" : "Copy report"}
          </button>
          <button type="button" onClick={this.handleReportIssue}>
            Report this
          </button>
        </div>
      </main>
    );
  }
}
