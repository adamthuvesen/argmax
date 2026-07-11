import { Component, type ErrorInfo, type ReactNode } from "react";
import { logger } from "../../shared/logger.js";

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logger.error("renderer.error-boundary", "caught render error", {
      error: error.message,
      stack: info.componentStack ?? null
    });
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
