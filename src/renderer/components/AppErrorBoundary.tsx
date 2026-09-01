import { Component, type ErrorInfo, type ReactNode } from "react";
import { logger } from "../../shared/logger.js";

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, componentStack: null };
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

  private handleOpenDataFolder = (): void => {
    if (typeof window === "undefined" || !window.argmax) return;
    void window.argmax.system
      .diagnostics()
      .then((report) => window.argmax?.system.openPath({ path: report.databasePath }))
      .catch(() => {
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
        <p>Your session state is safe — it was persisted before the error.</p>
        <pre className="error-boundary-message">{this.state.error.message}</pre>
        {this.state.componentStack ? (
          <details className="error-boundary-details">
            <summary>Where it happened</summary>
            <pre className="error-boundary-message">{this.state.componentStack.trim()}</pre>
          </details>
        ) : null}
        <div className="error-boundary-actions">
          <button type="button" onClick={this.handleReload}>
            Reload renderer
          </button>
          <button type="button" onClick={this.handleOpenDataFolder}>
            Open data folder
          </button>
        </div>
      </main>
    );
  }
}
